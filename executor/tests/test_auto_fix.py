"""Phase 3c tests: autofix orchestration + /auto-fix + autofix re-run.

Covers (mocked ki_connect): valid fix applied, syntax-invalid fix flagged
not applied, no-key → skipped, endpoint response shapes, and the single-cell
re-run endpoint (max 1 attempt: patched cell passes → fixed, still fails →
fixed=false). Re-run endpoint tests execute real kernels like the Phase 3b
suite; autofix-LLM calls are always mocked.
"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient

import app as app_module
from auto_fix import autofix_cell, is_valid_python

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
