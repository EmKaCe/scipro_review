"""Phase 3c tests: autofix orchestration + /auto-fix + whole-notebook verify.

Covers (mocked ki_connect): valid fix applied with a visible provenance
comment, dependent-cell cascade (first error fixed → downstream resolves),
revert-on-failure (never leave a half-fixed notebook), skip cases, endpoint
response shapes, and the single-cell re-run endpoint. The automatic pass
re-runs the WHOLE notebook after each applied fix — a single-cell re-run
loses kernel state built by earlier cells (`_00` regression). Re-run
endpoint tests execute real kernels like the Phase 3b suite; autofix-LLM
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
from auto_fix import apply_autofix_pass, autofix_cell, is_valid_python
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
# apply_autofix_pass — automatic pipeline autofix stage
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

    Reads the temp notebook the pass wrote (so the provenance comment is
    reflected in the re-run cells) and returns an ``ExecutionResult``.
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


def test_autofix_pass_fixes_cell_and_reruns_whole_notebook(monkeypatch):
    fake = _fake_rerun(clean=True)
    monkeypatch.setattr(auto_fix_module, "execute_notebook", fake)
    cells = [_error_cell(0)]

    info = apply_autofix_pass(
        cells,
        ki_client=_mock_ki_client(),
        cell_types={0: "code"},
    )

    assert info == {"attempts": 1, "succeeded": 1}
    assert cells[0].error is None
    assert cells[0].output_text == "ok"


def test_autofix_pass_adds_visible_provenance_comment(monkeypatch):
    fake = _fake_rerun(clean=True)
    monkeypatch.setattr(auto_fix_module, "execute_notebook", fake)
    cells = [_error_cell(0, source="y = (x + 1")]

    apply_autofix_pass(
        cells,
        ki_client=_mock_ki_client({"suggestion": "y = (x + 1)", "fix_type": "syntax_fix"}),
        cell_types={0: "code"},
    )

    # The fix is applied WITH a visible comment — never a silent mutation
    # (the `_00` regression: "July" removed with no comment).
    assert cells[0].source.startswith("# auto-fix: syntax_fix repaired")
    assert "y = (x + 1)" in cells[0].source


def test_autofix_pass_reverts_when_rerun_still_failing(monkeypatch):
    fake = _fake_rerun(clean=False)  # re-run still errors
    monkeypatch.setattr(auto_fix_module, "execute_notebook", fake)
    cells = [_error_cell(0)]

    info = apply_autofix_pass(cells, ki_client=_mock_ki_client(), cell_types={0: "code"})

    assert info == {"attempts": 1, "succeeded": 0}
    # Reverted: the teacher sees the authentic student state, not a
    # half-fixed cell (the `_00` worst-of-both-worlds state).
    assert cells[0].error == "ZeroDivisionError: division by zero"
    assert not cells[0].source.startswith("# auto-fix:")


def test_autofix_pass_reverts_when_rerun_makes_errors_worse(monkeypatch):
    fake = _fake_rerun(clean=False, errors_per_pass=[2])
    monkeypatch.setattr(auto_fix_module, "execute_notebook", fake)
    cells = [_error_cell(0)]

    info = apply_autofix_pass(cells, ki_client=_mock_ki_client(), cell_types={0: "code"})

    assert info == {"attempts": 1, "succeeded": 0}
    assert cells[0].error == "ZeroDivisionError: division by zero"
    assert not cells[0].source.startswith("# auto-fix:")


def test_autofix_pass_reverts_when_no_clean_fix_within_passes(monkeypatch):
    # Every re-run leaves an error → the same cell is attempted again, then
    # the loop stops and reverts everything.
    fake = _fake_rerun(clean=False, errors_per_pass=[1, 1])
    monkeypatch.setattr(auto_fix_module, "execute_notebook", fake)
    cells = [_error_cell(0)]

    info = apply_autofix_pass(cells, ki_client=_mock_ki_client(), cell_types={0: "code"})

    assert info == {"attempts": 1, "succeeded": 0}
    assert cells[0].error == "ZeroDivisionError: division by zero"
    assert not cells[0].source.startswith("# auto-fix:")


def test_autofix_pass_fixes_first_error_only_cascade(monkeypatch):
    """Dependent-cell cascade (the `_00` regression scenario).

    Cell 0 errors and cell 1 only fails because of it. The pass fixes the
    FIRST error; the whole-notebook re-run resolves the downstream cell —
    KI is never asked about the symptom.
    """
    fake = _fake_rerun(clean=True)
    monkeypatch.setattr(auto_fix_module, "execute_notebook", fake)
    client = _mock_ki_client()
    cells = [
        _error_cell(0, source="y = (x + 1"),
        _error_cell(1, source="print(y)"),
    ]

    info = apply_autofix_pass(
        cells,
        ki_client=client,
        cell_types={0: "code", 1: "code"},
    )

    assert info == {"attempts": 1, "succeeded": 1}
    assert client.autofix.call_count == 1  # only the root cause was fixed


def test_autofix_pass_skips_when_suggestion_not_usable(monkeypatch):
    rerun = Mock()
    monkeypatch.setattr(auto_fix_module, "execute_notebook", rerun)
    cells = [_error_cell(0)]

    info = apply_autofix_pass(
        cells,
        ki_client=_mock_ki_client(INVALID_FIX),  # syntax-invalid → no patch
        cell_types={0: "code"},
    )

    assert info == {"attempts": 0, "succeeded": 0}
    rerun.assert_not_called()
    assert cells[0].error == "ZeroDivisionError: division by zero"


def test_autofix_pass_skips_without_ki_client(monkeypatch):
    rerun = Mock()
    monkeypatch.setattr(auto_fix_module, "execute_notebook", rerun)
    cells = [_error_cell(0)]

    info = apply_autofix_pass(cells, ki_client=None, cell_types={0: "code"})

    assert info == {"attempts": 0, "succeeded": 0}
    rerun.assert_not_called()


def test_autofix_pass_skips_markdown_cells(monkeypatch):
    rerun = Mock()
    monkeypatch.setattr(auto_fix_module, "execute_notebook", rerun)
    cells = [_error_cell(0)]

    info = apply_autofix_pass(
        cells,
        ki_client=_mock_ki_client(),
        cell_types={0: "markdown"},
    )

    assert info == {"attempts": 0, "succeeded": 0}
    rerun.assert_not_called()
    assert cells[0].error == "ZeroDivisionError: division by zero"


def test_autofix_pass_skips_healthy_cells(monkeypatch):
    rerun = Mock()
    monkeypatch.setattr(auto_fix_module, "execute_notebook", rerun)
    healthy = CellOutput(cell_index=0, execution_count=1, source="print(1)", output_text="1")

    info = apply_autofix_pass(
        [healthy],
        ki_client=_mock_ki_client(),
        cell_types={0: "code"},
    )

    assert info == {"attempts": 0, "succeeded": 0}
    rerun.assert_not_called()


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
# POST /execute/autofix-run — re-run endpoint tests (real kernels)
# ---------------------------------------------------------------------------


def test_autofix_run_endpoint_fixed_when_patched_cell_passes(api_client):
    resp = api_client.post(
        "/execute/autofix-run",
        json={
            "cell_source": "x = 1 / 0",
            "cell_error": "ZeroDivisionError: division by zero",
            "patched_source": "x = 21\nprint(x)",
            "assignment_id": "",
        },
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["original_error"] == "ZeroDivisionError: division by zero"
    assert body["patched_source"] == "x = 21\nprint(x)"
    assert body["fixed"] is True
    assert body["re_run_error"] is None
    assert "21" in body["re_run_output"]


def test_autofix_run_endpoint_not_fixed_when_still_failing(api_client):
    resp = api_client.post(
        "/execute/autofix-run",
        json={
            "cell_source": "import numpy as np",
            "cell_error": "ModuleNotFoundError: No module named 'numpy'",
            "patched_source": "import definitely_not_a_real_module_xyz",
            "assignment_id": "",
        },
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["fixed"] is False
    assert body["re_run_error"] is not None
    assert "ModuleNotFoundError" in body["re_run_error"]
    # Max-1-attempt semantics: the original error is preserved alongside
    assert body["original_error"].startswith("ModuleNotFoundError")


def test_autofix_run_endpoint_rejects_invalid_patched_source(api_client):
    resp = api_client.post(
        "/execute/autofix-run",
        json={
            "cell_source": "def broken(:",
            "cell_error": "SyntaxError: invalid syntax",
            "patched_source": "def still_broken(:",
        },
    )

    assert resp.status_code == 400
    assert "not valid Python" in resp.json()["detail"]


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
    # One fix applied; the whole-notebook re-run came back clean.
    assert body["autofix"]["attempts"] == 1
    assert body["autofix"]["succeeded"] == 1
    assert body["error_cells"] == 0

    # The fixed cell carries a visible provenance comment — never silent.
    fixed = body["cells"][1]
    assert fixed["source"].startswith("# auto-fix: syntax_fix repaired")
    assert "y = (x + 1)" in fixed["source"]

    # The dependent downstream cell executed with real kernel state and its
    # output is present (y == 6).
    downstream = body["cells"][2]
    assert downstream["execution_count"] is not None
    assert "6" in str(downstream.get("output_text") or "")
