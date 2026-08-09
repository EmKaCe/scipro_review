"""Task E tests: strip_legacy_autofix_comments migration script.

The pre-4b autofix engine wrote "# auto-fix: <name> repaired — changed:
<details>" bookkeeping comments into stored cell sources in results.json.
The script removes exactly those lines (full old-engine marker, em-dash
U+2014) from every assignment's results.json under DATA_DIR — never
genuine student comments and never the original .ipynb files. Dry-run is
the default; --apply rewrites affected files atomically.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "strip_legacy_autofix_comments.py"

EM_DASH = "\u2014"
LEGACY_LINE = f'# auto-fix: syntax_fix repaired {EM_DASH} changed: ylabel="old"'
STUDENT_LINE = "# auto-fix: my own note"
CLEAN_LINE = "import numpy as np\nx = np.array([1, 2, 3])"


def _write_fixture(tmp_path: Path) -> Path:
    """Write DATA_DIR/submissions/soil_contamination/results.json fixture."""
    results = {
        "student_01": {
            "success": True,
            "cells": [
                # Legacy artifact: source is a LIST whose first line carries
                # the old-engine marker (em-dash U+2014).
                {"index": 0, "type": "code", "source": [LEGACY_LINE, "x = 1", ""]},
                # Genuine student comment: fails the full marker pattern.
                {"index": 1, "type": "code", "source": f"{STUDENT_LINE}\nprint('hi')"},
                # Untouched control cell.
                {"index": 2, "type": "code", "source": CLEAN_LINE},
            ],
            "totalCells": 3,
        }
    }
    results_path = tmp_path / "submissions" / "soil_contamination" / "results.json"
    results_path.parent.mkdir(parents=True)
    results_path.write_text(json.dumps(results, indent=2), encoding="utf-8")
    return results_path


def _run_script(tmp_path: Path, *args: str) -> subprocess.CompletedProcess:
    env = {**os.environ, "DATA_DIR": str(tmp_path)}
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        capture_output=True,
        text=True,
        env=env,
    )


def test_dry_run_reports_legacy_cell_and_writes_nothing(tmp_path):
    results_path = _write_fixture(tmp_path)
    before = results_path.read_bytes()

    proc = _run_script(tmp_path, "--dry-run")

    assert proc.returncode == 0, proc.stderr
    assert "cell 0" in proc.stdout  # 0-based index of the legacy cell
    assert "dry run" in proc.stdout
    assert results_path.read_bytes() == before  # nothing written


def test_apply_strips_only_legacy_comment(tmp_path):
    _write_fixture(tmp_path)
    results_path = tmp_path / "submissions" / "soil_contamination" / "results.json"

    proc = _run_script(tmp_path, "--apply")

    assert proc.returncode == 0, proc.stderr
    results = json.loads(results_path.read_text(encoding="utf-8"))  # still valid JSON
    cells = results["student_01"]["cells"]
    # Legacy comment line removed; list source keeps its type and order.
    assert cells[0]["source"] == ["x = 1", ""]
    # Genuine student comment untouched.
    assert cells[1]["source"] == f"{STUDENT_LINE}\nprint('hi')"
    # Clean cell untouched.
    assert cells[2]["source"] == CLEAN_LINE


def test_clean_results_noop_even_with_apply(tmp_path):
    results_path = _write_fixture(tmp_path)
    results = json.loads(results_path.read_text(encoding="utf-8"))
    # Remove the only legacy marker → nothing left to strip.
    results["student_01"]["cells"][0]["source"] = ["x = 1", ""]
    results_path.write_text(json.dumps(results, indent=2), encoding="utf-8")
    before = results_path.read_bytes()

    proc = _run_script(tmp_path, "--apply")

    assert proc.returncode == 0, proc.stderr
    assert "clean" in proc.stdout  # no-op report
    assert results_path.read_bytes() == before  # no write on clean data
