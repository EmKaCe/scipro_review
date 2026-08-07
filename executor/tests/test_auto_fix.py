"""Phase 3c tests: autofix orchestration + /auto-fix + whole-notebook verify.

Covers (mocked ki_connect): the NON-DESTRUCTIVE automatic pass (input
cells are never mutated; a verified clean fixed execution is returned
separately as ``fixed_cells``, otherwise None — the teacher only ever sees
the original + a proposal), dependent-cell cascade (first error fixed →
downstream resolves), skip cases, endpoint response shapes, and the
manual-fix verify endpoint (whole-notebook verify of a teacher-supplied
patch). Both the automatic pass and the manual flow re-run the WHOLE
notebook after applying a fix — a single-cell re-run loses kernel state
built by earlier cells (`_00` regression); single-cell re-runs are gone.
Endpoint tests execute real kernels like the Phase 3b suite; autofix-LLM
calls are always mocked.
"""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient

import app as app_module
import auto_fix as auto_fix_module
from auto_fix import apply_autofix_pass, apply_manual_fix, autofix_cell, is_valid_python
from runner import CellOutput, ExecutionResult

VALID_FIX = {
    "suggestion": (
        "import numpy as np\n"
        "x = np.array([1, 2, 3])\n"
        "print(x.mean())"
    ),
    "explanation": "Add the missing numpy import so np is defined.",
    "confidence": 0.95,
    "fix_type": "import_fix",
}

INVALID_FIX = {
    "suggestion": "def broken(:\n    return 1",
    "explanation": "Fix the function signature syntax.",
    "confidence": 0.6,
    "fix_type": "syntax_fix",
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _mock_ki_client(fix: dict | None = None) -> Mock:
    """A KI Connect client stub whose autofix() returns ``fix``."""
    client = Mock()
    client.api_key = "test-key"
    client.autofix.return_value = fix if fix is not None else VALID_FIX
    return client


@pytest.fixture()
def api_client(tmp_path, monkeypatch):
    """TestClient with DATA_DIR pointed at a temp dir."""
    monkeypatch.setattr(app_module, "DATA_DIR", tmp_path)
    with TestClient(app_module.app) as client:
        yield client


# ---------------------------------------------------------------------------
# autofix_cell — orchestration unit tests
# ---------------------------------------------------------------------------


def test_autofix_cell_applies_valid_fix():
    result = autofix_cell(
        cell_source="x = np.array([1, 2, 3])",
        cell_error="NameError: name 'np' is not defined",
        ki_client=_mock_ki_client(),
    )

    assert result["skipped"] is False
    assert result["suggestion"] == VALID_FIX["suggestion"]
    assert result["explanation"] == VALID_FIX["explanation"]
    assert result["confidence"] == 0.95
    assert result["fix_type"] == "import_fix"
    # Sanity check passed → the suggestion is applied as the patch
    assert result["syntax_valid"] is True
    assert result["patched_source"] == VALID_FIX["suggestion"]


def test_autofix_cell_flags_syntax_invalid_fix_not_applied():
    result = autofix_cell(
        cell_source="def broken(:",
        cell_error="SyntaxError: invalid syntax",
        ki_client=_mock_ki_client(INVALID_FIX),
    )

    assert result["skipped"] is False
    # Suggestion is still returned (teacher can review it)…
    assert result["suggestion"] == INVALID_FIX["suggestion"]
    # …but flagged and NOT applied as a patch
    assert result["syntax_valid"] is False
    assert result["patched_source"] is None


@pytest.mark.parametrize(
    "response",
    [
        {"skipped": True},
        {},  # nothing usable
        {"suggestion": "   "},  # whitespace-only suggestion
    ],
)
def test_autofix_cell_skipped_when_no_usable_fix(response):
    result = autofix_cell(
        cell_source="x = ",
        cell_error="SyntaxError",
        ki_client=_mock_ki_client(response),
    )
    assert result == {"skipped": True}


def test_autofix_cell_skipped_when_ki_client_none():
    result = autofix_cell(
        cell_source="x = ",
        cell_error="SyntaxError",
        ki_client=None,
    )
    assert result == {"skipped": True}


def test_autofix_cell_appends_traceback_to_error():
    client = _mock_ki_client()
    autofix_cell(
        cell_source="x = 1/0",
        cell_error="ZeroDivisionError: division by zero",
        traceback=["----> 1 x = 1/0", "ZeroDivisionError: division by zero"],
        ki_client=client,
    )

    sent_error = client.autofix.call_args.args[1]
    assert "ZeroDivisionError: division by zero" in sent_error
    assert "----> 1 x = 1/0" in sent_error


def test_autofix_cell_enriches_context_with_data_files_and_assignment():
    client = _mock_ki_client()
    autofix_cell(
        cell_source="df = pd.read_csv('soil.csv')",
        cell_error="FileNotFoundError: soil.csv",
        context_cells=[{"type": "code", "source": "import pandas as pd"}],
        assignment_context="Analyze soil samples.",
        available_paths={"soil.csv", "nested/ref.csv"},
        ki_client=client,
    )

    sent_context = client.autofix.call_args.args[2]
    assert sent_context[0]["source"] == "import pandas as pd"
    combined = "\n".join(str(c.get("source", "")) for c in sent_context)
    assert "Analyze soil samples." in combined
    assert "soil.csv" in combined
    assert "nested/ref.csv" in combined


def test_autofix_cell_normalizes_missing_confidence():
    fix = dict(VALID_FIX)
    fix.pop("confidence")
    result = autofix_cell(
        cell_source="x = np.array([1])",
        cell_error="NameError: name 'np' is not defined",
        ki_client=_mock_ki_client(fix),
    )
    assert result["confidence"] is None
    assert result["patched_source"] == VALID_FIX["suggestion"]


def test_is_valid_python_deterministic_sanity_check():
    assert is_valid_python("x = 1\nprint(x)") is True
    assert is_valid_python("def broken(:") is False
    # ast.parse semantics: an empty module is syntactically valid — the
    # empty-suggestion guard lives in autofix_cell, not here
    assert is_valid_python("") is True


# ---------------------------------------------------------------------------
# apply_autofix_pass — automatic pipeline autofix stage (NON-DESTRUCTIVE)
# ---------------------------------------------------------------------------


def _error_cell(index: int, source: str = "x = 1/0") -> CellOutput:
    return CellOutput(
        cell_index=index,
        execution_count=1,
        source=source,
        output_text="",
        error="ZeroDivisionError: division by zero",
        traceback=["ZeroDivisionError: division by zero"],
    )


def _fake_rerun(clean: bool = True, errors_per_pass: list[int] | None = None):
    """Fake ``execute_notebook`` for the whole-notebook re-run.

    Reads the temp notebook the pass wrote (so an applied fix is reflected
    in the re-run cells) and returns an ``ExecutionResult``.
    ``errors_per_pass`` overrides ``clean`` with per-call error counts
    (capped at 1 error cell per run).
    """

    def _fn(
        notebook_path,
        timeout=30,
        kernel_name="python3",
        data_dir=None,
        assignment_id="",
    ):
        calls["n"] += 1
        with open(notebook_path, encoding="utf-8") as f:
            nb = json.load(f)
        if errors_per_pass is not None:
            err_count = errors_per_pass[min(calls["n"] - 1, len(errors_per_pass) - 1)]
        else:
            err_count = 0 if clean else 1
        cells: list[CellOutput] = []
        for i, cell in enumerate(nb["cells"]):
            src = "".join(cell["source"]) if isinstance(cell["source"], list) else cell["source"]
            if cell["cell_type"] == "code":
                if err_count > 0 and i < err_count:
                    cells.append(
                        CellOutput(i, 1, src, "", "RuntimeError: boom", ["RuntimeError: boom"])
                    )
                else:
                    cells.append(CellOutput(i, 2, src, "ok", None))
            else:
                cells.append(CellOutput(i, None, src, "", None))
        return ExecutionResult(str(notebook_path), cells, True, len(cells), 0.1)

    calls = {"n": 0}
    return _fn


def _fixed(original: list[CellOutput]) -> dict:
    """Run the pass and return its info dict (attempts/succeeded/fixed_cells)."""
    return apply_autofix_pass(
        original,
        ki_client=_mock_ki_client(),
        cell_types={i: "code" for i in range(len(original))},
    )


def test_autofix_pass_returns_fixed_cells_without_mutating(monkeypatch):
    monkeypatch.setattr(auto_fix_module, "execute_notebook", _fake_rerun(clean=True))
    original = [_error_cell(0)]

    info = _fixed(original)

    assert info["attempts"] == 1 and info["succeeded"] == 1
    assert info["fixed_cells"] is not None
    fixed = {c.cell_index: c for c in info["fixed_cells"]}
    assert fixed[0].error is None
    assert fixed[0].output_text == "ok"
    # ORIGINALS untouched — the incident's core guarantee.
    assert original[0].error == "ZeroDivisionError: division by zero"
    assert original[0].source == "x = 1/0"


def test_autofix_pass_no_comment_in_fixed_cells(monkeypatch):
    monkeypatch.setattr(auto_fix_module, "execute_notebook", _fake_rerun(clean=True))
    original = [_error_cell(0, source="y = (x + 1")]

    info = apply_autofix_pass(
        original,
        ki_client=_mock_ki_client({"suggestion": "y = (x + 1)", "fix_type": "syntax_fix"}),
        cell_types={0: "code"},
    )

    src = info["fixed_cells"][0].source
    assert not src.startswith("# auto-fix:")  # comments are gone
    assert "y = (x + 1)" in src
    # Original still authentic — the fix lives in fixed_cells, not in cells.
    assert original[0].source == "y = (x + 1"


def test_autofix_pass_no_fixed_cells_when_rerun_still_failing(monkeypatch):
    monkeypatch.setattr(auto_fix_module, "execute_notebook", _fake_rerun(clean=False))
    original = [_error_cell(0)]

    info = _fixed(original)

    assert info["attempts"] == 1 and info["succeeded"] == 0
    # No clean fixed version — the teacher sees only the original.
    assert info["fixed_cells"] is None
    assert original[0].error == "ZeroDivisionError: division by zero"
    assert original[0].source == "x = 1/0"


def test_autofix_pass_no_fixed_cells_when_rerun_makes_errors_worse(monkeypatch):
    monkeypatch.setattr(
        auto_fix_module, "execute_notebook", _fake_rerun(clean=False, errors_per_pass=[2])
    )
    original = [_error_cell(0)]

    info = _fixed(original)

    assert info["attempts"] == 1 and info["succeeded"] == 0
    assert info["fixed_cells"] is None
    assert original[0].error == "ZeroDivisionError: division by zero"


def test_autofix_pass_no_fixed_cells_when_no_clean_fix_within_passes(monkeypatch):
    # Every re-run leaves an error → the same cell is attempted again, then
    # the loop stops. No clean fixed version exists.
    monkeypatch.setattr(
        auto_fix_module, "execute_notebook", _fake_rerun(clean=False, errors_per_pass=[1, 1])
    )
    original = [_error_cell(0)]

    info = _fixed(original)

    assert info["attempts"] == 1 and info["succeeded"] == 0
    assert info["fixed_cells"] is None
    assert original[0].error == "ZeroDivisionError: division by zero"


def test_autofix_pass_fixes_first_error_only_cascade(monkeypatch):
    """Dependent-cell cascade (the `_00` regression scenario).

    Cell 0 errors and cell 1 only fails because of it. The pass fixes the
    FIRST error; the whole-notebook re-run resolves the downstream cell —
    KI is never asked about the symptom.
    """
    fake = _fake_rerun(clean=True)
    monkeypatch.setattr(auto_fix_module, "execute_notebook", fake)
    client = _mock_ki_client()
    original = [
        _error_cell(0, source="y = (x + 1"),
        _error_cell(1, source="print(y)"),
    ]

    info = apply_autofix_pass(
        original,
        ki_client=client,
        cell_types={0: "code", 1: "code"},
    )

    assert info["attempts"] == 1 and info["succeeded"] == 1
    assert info["fixed_cells"] is not None
    assert client.autofix.call_count == 1  # only the root cause was fixed
    # Originals untouched.
    assert original[0].source == "y = (x + 1"
    assert original[0].error is not None
    assert original[1].source == "print(y)"
    assert original[1].error is not None


def test_autofix_pass_skips_when_suggestion_not_usable(monkeypatch):
    rerun = Mock()
    monkeypatch.setattr(auto_fix_module, "execute_notebook", rerun)
    original = [_error_cell(0)]

    info = apply_autofix_pass(
        original,
        ki_client=_mock_ki_client(INVALID_FIX),  # syntax-invalid → no patch
        cell_types={0: "code"},
    )

    assert info == {"attempts": 0, "succeeded": 0, "fixed_cells": None}
    rerun.assert_not_called()
    assert original[0].error == "ZeroDivisionError: division by zero"


def test_autofix_pass_skips_without_ki_client(monkeypatch):
    rerun = Mock()
    monkeypatch.setattr(auto_fix_module, "execute_notebook", rerun)
    original = [_error_cell(0)]

    info = apply_autofix_pass(original, ki_client=None, cell_types={0: "code"})

    assert info == {"attempts": 0, "succeeded": 0, "fixed_cells": None}
    rerun.assert_not_called()


def test_autofix_pass_skips_markdown_cells(monkeypatch):
    rerun = Mock()
    monkeypatch.setattr(auto_fix_module, "execute_notebook", rerun)
    original = [_error_cell(0)]

    info = apply_autofix_pass(
        original,
        ki_client=_mock_ki_client(),
        cell_types={0: "markdown"},
    )

    assert info == {"attempts": 0, "succeeded": 0, "fixed_cells": None}
    rerun.assert_not_called()
    assert original[0].error == "ZeroDivisionError: division by zero"


def test_autofix_pass_skips_healthy_cells(monkeypatch):
    rerun = Mock()
    monkeypatch.setattr(auto_fix_module, "execute_notebook", rerun)
    healthy = CellOutput(cell_index=0, execution_count=1, source="print(1)", output_text="1")

    info = apply_autofix_pass(
        [healthy],
        ki_client=_mock_ki_client(),
        cell_types={0: "code"},
    )

    assert info == {"attempts": 0, "succeeded": 0, "fixed_cells": None}
    rerun.assert_not_called()


# ---------------------------------------------------------------------------
# apply_manual_fix — manual "Suggest fix" verification (NON-DESTRUCTIVE,
# whole-notebook context; single-cell re-runs are gone — the _00 regression)
# ---------------------------------------------------------------------------


def _manual(original: list[CellOutput], target: int, patched: str) -> dict:
    """Run the manual verifier and return its info dict."""
    return apply_manual_fix(
        original,
        target,
        patched,
        cell_types={i: "code" for i in range(len(original))},
    )


def test_manual_fix_verifies_patch_without_mutating(monkeypatch):
    monkeypatch.setattr(auto_fix_module, "execute_notebook", _fake_rerun(clean=True))
    original = [_error_cell(0), _error_cell(1)]

    info = _manual(original, 1, "x = 42")

    assert info["fixed"] is True
    assert info["fixed_cells"] is not None
    assert len(info["fixed_cells"]) == 2
    assert info["fixed_cells"][1].error is None
    assert info["fixed_cells"][1].source == "x = 42"
    # ORIGINALS untouched — the incident's core guarantee.
    assert original[0].source == "x = 1/0"
    assert original[1].source == "x = 1/0"


def test_manual_fix_no_fixed_cells_when_rerun_not_clean(monkeypatch):
    monkeypatch.setattr(
        auto_fix_module, "execute_notebook", _fake_rerun(clean=False, errors_per_pass=[2])
    )
    original = [_error_cell(0), _error_cell(1)]

    info = _manual(original, 1, "x = 42")

    assert info["fixed"] is False
    assert info["fixed_cells"] is None
    # The target's consequence in context is surfaced honestly.
    assert info["re_run_error"] == "RuntimeError: boom"
    assert info["error_cells"] == 2


def test_manual_fix_out_of_range_target_raises(monkeypatch):
    monkeypatch.setattr(auto_fix_module, "execute_notebook", _fake_rerun(clean=True))
    with pytest.raises(ValueError, match="out of range"):
        _manual([_error_cell(0)], 3, "x = 42")


# ---------------------------------------------------------------------------
# POST /auto-fix — endpoint tests
# ---------------------------------------------------------------------------


def test_auto_fix_endpoint_returns_suggestion_shape(api_client, monkeypatch):
    monkeypatch.setattr(app_module, "_get_ki_client", _mock_ki_client)

    resp = api_client.post(
        "/auto-fix",
        json={
            "cell_source": "x = np.array([1, 2, 3])",
            "cell_error": "NameError: name 'np' is not defined",
            "cell_index": 3,
        },
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["suggestion"] == VALID_FIX["suggestion"]
    assert body["explanation"] == VALID_FIX["explanation"]
    assert body["confidence"] == 0.95
    assert body["fix_type"] == "import_fix"
    assert body["patched_source"] == VALID_FIX["suggestion"]
    assert body["syntax_valid"] is True


def test_auto_fix_endpoint_skipped_when_no_api_key(api_client, monkeypatch):
    monkeypatch.setattr(app_module, "_get_ki_client", lambda: None)

    resp = api_client.post(
        "/auto-fix",
        json={"cell_source": "x = ", "cell_error": "SyntaxError"},
    )

    assert resp.status_code == 200
    assert resp.json() == {"skipped": True}


def test_auto_fix_endpoint_flags_invalid_syntax(api_client, monkeypatch):
    monkeypatch.setattr(app_module, "_get_ki_client", lambda: _mock_ki_client(INVALID_FIX))

    resp = api_client.post(
        "/auto-fix",
        json={"cell_source": "def broken(:", "cell_error": "SyntaxError"},
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["syntax_valid"] is False
    # Not applied: patched_source is omitted entirely (exclude_none)
    assert "patched_source" not in body
    assert body["suggestion"] == INVALID_FIX["suggestion"]


def test_auto_fix_endpoint_discovers_assignment_data_files(
    api_client, monkeypatch
):
    # Assignment data exists under DATA_DIR/materials/soil/input_data
    input_dir = app_module.DATA_DIR / "materials" / "soil" / "input_data"
    input_dir.mkdir(parents=True)
    (input_dir / "soil.csv").write_text("a,b\n1,2", encoding="utf-8")

    client = _mock_ki_client()
    monkeypatch.setattr(app_module, "_get_ki_client", lambda: client)

    resp = api_client.post(
        "/auto-fix",
        json={
            "cell_source": "df = pd.read_csv('soil.csv')",
            "cell_error": "FileNotFoundError",
            "assignment_id": "soil",
        },
    )

    assert resp.status_code == 200
    sent_context = client.autofix.call_args.args[2]
    combined = "\n".join(str(c.get("source", "")) for c in sent_context)
    assert "soil.csv" in combined


# ---------------------------------------------------------------------------
# POST /execute/autofix-run — manual fix verify endpoint tests (real kernels)
# ---------------------------------------------------------------------------


def test_autofix_run_endpoint_verifies_patch_in_whole_notebook(api_client):
    """The `_00` shape: the patched cell depends on earlier kernel state.

    Cell 0 defines ``x``; cell 1 has a syntax error and is patched. The
    whole-notebook re-run keeps cell 0's state, so the patch resolves — an
    isolated single-cell re-run would raise NameError (the regression).
    """
    resp = api_client.post(
        "/execute/autofix-run",
        json={
            "cells": [
                {"source": "x = 5", "cell_type": "code"},
                {"source": "print(x", "cell_type": "code"},
            ],
            "target_cell_index": 1,
            "patched_source": "print(x)",
            "assignment_id": "",
        },
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["patched_source"] == "print(x)"
    assert body["fixed"] is True
    assert body["re_run_error"] is None
    assert "5" in body["re_run_output"]
    # The verified fixed execution is returned (aligned, authentic originals).
    assert body["fixed_cells"] is not None
    assert len(body["fixed_cells"]) == 2
    fixed1 = body["fixed_cells"][1]
    assert fixed1["error"] is None
    assert fixed1["source"] == "print(x)"
    assert fixed1["original_source"] == "print(x"  # student's original, not the patch
    assert body["error_cells"] == 0


def test_autofix_run_endpoint_not_fixed_when_still_failing(api_client):
    resp = api_client.post(
        "/execute/autofix-run",
        json={
            "cells": [
                {"source": "import numpy as np", "cell_type": "code"},
                {"source": "import os", "cell_type": "code"},
            ],
            "target_cell_index": 1,
            "patched_source": "import definitely_not_a_real_module_xyz",
            "assignment_id": "",
        },
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["fixed"] is False
    assert body["re_run_error"] is not None
    assert "ModuleNotFoundError" in body["re_run_error"]
    # No half-fixed artifact is ever published.
    assert body["fixed_cells"] is None
    assert body["error_cells"] == 1


def test_autofix_run_endpoint_rejects_invalid_patched_source(api_client):
    resp = api_client.post(
        "/execute/autofix-run",
        json={
            "cells": [
                {"source": "def broken(:", "cell_type": "code"},
            ],
            "target_cell_index": 0,
            "patched_source": "def still_broken(:",
        },
    )

    assert resp.status_code == 400
    assert "not valid Python" in resp.json()["detail"]


def test_autofix_run_endpoint_rejects_out_of_range_target(api_client):
    resp = api_client.post(
        "/execute/autofix-run",
        json={
            "cells": [
                {"source": "x = 1", "cell_type": "code"},
                {"source": "print(x)", "cell_type": "code"},
            ],
            "target_cell_index": 5,
            "patched_source": "print(x)",
        },
    )

    assert resp.status_code == 400
    assert "out of range" in resp.json()["detail"]


def test_autofix_run_endpoint_rejects_markdown_target(api_client):
    resp = api_client.post(
        "/execute/autofix-run",
        json={
            "cells": [
                {"source": "x = 1", "cell_type": "code"},
                {"source": "# A markdown cell", "cell_type": "markdown"},
            ],
            "target_cell_index": 1,
            "patched_source": "print(x)",
        },
    )

    assert resp.status_code == 400
    assert "not a code cell" in resp.json()["detail"]


# ---------------------------------------------------------------------------
# POST /execute — automatic autofix stage, whole-notebook verify (real kernel)
# ---------------------------------------------------------------------------


def test_execute_autofix_whole_notebook_fixes_dependent_cells(
    api_client, monkeypatch
):
    """The `_00` regression scenario, end-to-end.

    A syntax error in an EARLY cell that a downstream cell depends on. The
    automatic stage must fix the first error and re-run the WHOLE notebook,
    so the downstream cell resolves with real kernel state — an isolated
    single-cell re-run would raise NameError (as happened to `_00`).

    The response keeps the AUTHENTIC original execution in ``cells`` (the
    syntax error is still there) and returns the verified fixed execution
    separately in ``fixed_cells`` — student work is never edited.
    """
    sub_dir = app_module.DATA_DIR / "submissions" / "soil"
    sub_dir.mkdir(parents=True)
    nb = {
        "cells": [
            {"cell_type": "code", "execution_count": None, "metadata": {}, "outputs": [], "source": "x = 5"},
            {"cell_type": "code", "execution_count": None, "metadata": {}, "outputs": [], "source": "y = (x + 1"},
            {"cell_type": "code", "execution_count": None, "metadata": {}, "outputs": [], "source": "print(y)"},
        ],
        "metadata": {"language_info": {"name": "python"}},
        "nbformat": 4,
        "nbformat_minor": 5,
    }
    (sub_dir / "2026SS_01.ipynb").write_text(json.dumps(nb), encoding="utf-8")

    syntax_fix = {
        "suggestion": "y = (x + 1)",
        "explanation": "Close the parenthesis.",
        "confidence": 0.95,
        "fix_type": "syntax_fix",
    }
    monkeypatch.setattr(app_module, "_get_ki_client", lambda: _mock_ki_client(syntax_fix))

    resp = api_client.post(
        "/execute",
        json={
            "notebook_path": "submissions/soil/2026SS_01.ipynb",
            "skip_preprocessing": True,
        },
    )

    assert resp.status_code == 200
    body = resp.json()
    # Original execution is authentic: the syntax error is still there, so
    # the summary honestly shows the pre-fix state (2 errors).
    assert body["autofix"]["attempts"] == 1
    assert body["autofix"]["succeeded"] == 1
    assert body["error_cells"] == 2
    assert body["cells"][1]["error"] is not None
    assert body["cells"][1]["source"] == "y = (x + 1"

    # The verified fixed execution is separate, clean, and carries no
    # provenance comment (the comment approach is superseded).
    assert body["fixed_cells"] is not None
    assert len(body["fixed_cells"]) == 3
    fixed1 = body["fixed_cells"][1]
    assert fixed1["error"] is None
    assert not fixed1["source"].startswith("# auto-fix:")
    assert "y = (x + 1)" in fixed1["source"]

    # The dependent downstream cell executed with real kernel state and its
    # output is present (y == 6).
    fixed2 = body["fixed_cells"][2]
    assert fixed2["execution_count"] is not None
    assert "6" in str(fixed2.get("output_text") or "")
