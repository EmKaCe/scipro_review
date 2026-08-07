"""Auto-fix orchestration for failed notebook cells (Phase 3c, pipeline step 4).

After execution, failed cells are sent to KI Connect for a fix suggestion.
This module orchestrates that call:

- folds the cell's traceback into the error text sent to the LLM
- enriches the LLM context with assignment data files (``available_paths``)
- sanity-checks the suggested fix with a deterministic ``ast.parse`` — a
  syntactically invalid suggestion is returned **flagged** (``syntax_valid``
  false, no ``patched_source``) instead of being applied
- returns ``{"skipped": true}`` when KI Connect is unavailable or returns
  nothing usable

The automatic stage (``apply_autofix_pass``) applies a fix with a visible
``# auto-fix:`` provenance comment and re-runs the WHOLE notebook in a fresh
sandbox, so kernel state built by earlier cells is preserved; if no clean
state is reached it reverts to the original student cells. The teacher-driven
single-cell re-run endpoint lives in ``app.py`` (``/execute/autofix-run``).

Usage:
    result = autofix_cell(
        cell_source="result = curve_fit(m, x, y)",
        cell_error="NameError: name 'curve_fit' is not defined",
        ki_client=client,
    )
    if result.get("skipped"):
        ...  # no suggestion available
    elif result["syntax_valid"]:
        patched = result["patched_source"]  # safe to re-run
"""

from __future__ import annotations

import ast
import copy
import json
import logging
import os
import tempfile
import time
from pathlib import Path
from typing import Any

from ki_connect import KiConnectClient
from runner import CellOutput, ExecutionResult, execute_notebook

logger = logging.getLogger("auto_fix")

PASS_LIMIT = 2
"""Max whole-notebook re-runs in the automatic autofix stage (pipeline step 4).

Each pass costs one KI suggestion call plus one full notebook re-execution,
so the limit bounds worst-case batch runtime. A higher limit fixes deeper
cascades at the cost of time; the per-notebook HTTP budget in the frontend
(``settings.executor.notebookTimeoutMs``) must cover original + re-runs.
"""


def is_valid_python(source: str) -> bool:
    """Return True if ``source`` parses as valid Python.

    Deterministic sanity check for LLM-produced fix suggestions — the only
    gate between a suggested patch and a re-run attempt.
    """
    try:
        ast.parse(source)
    except (SyntaxError, ValueError):
        return False
    return True


def _enrich_context(
    context_cells: list[dict[str, Any]] | None,
    assignment_context: str | None,
    available_paths: set[str] | None,
) -> list[dict[str, Any]]:
    """Extend the LLM context with assignment-level information.

    Appends a pseudo context cell describing the assignment's input data
    files (``available_paths``, relative to the assignment's input_data
    dir) and any free-text assignment context, so the fix suggestion can
    reference the right file names and task description.
    """
    enriched = list(context_cells) if context_cells else []

    notes: list[str] = []
    if assignment_context:
        notes.append(f"Assignment context: {assignment_context}")
    if available_paths:
        files = ", ".join(sorted(available_paths))
        notes.append(f"Available input data files: {files}")

    if notes:
        enriched.append({"type": "markdown", "source": "\n".join(notes)})

    return enriched


def _build_autofix_comment(
    fix_type: str | None,
    original_source: str,
    patched_source: str,
) -> str:
    """Visible provenance comment prepended to a fixed cell.

    A silent mutation is never acceptable — the teacher must see that the
    pipeline changed the cell and what changed (regression: the `_00`
    incident where a stray ``July`` token was removed with no comment).
    """
    orig_lines = [ln.strip() for ln in str(original_source).splitlines()]
    patched_lines = [ln.strip() for ln in str(patched_source).splitlines()]
    changed = ""
    for a, b in zip(orig_lines, patched_lines):
        if a != b:
            changed = a or b
            break
    if not changed and len(orig_lines) != len(patched_lines):
        changed = (patched_lines[0] if patched_lines else "") or (
            orig_lines[0] if orig_lines else ""
        )
    label = fix_type or "error"
    if changed:
        return f"# auto-fix: {label} repaired — changed: {changed[:80]}"
    return f"# auto-fix: {label} repaired by KI suggestion"


def _rebuild_notebook(
    cells: list[CellOutput],
    cell_types: dict[int, str] | None,
) -> dict[str, Any]:
    """Build a fresh notebook dict from the current cell states."""
    types = cell_types or {}
    nb_cells: list[dict[str, Any]] = []
    for c in cells:
        ctype = types.get(c.cell_index, "code")
        entry: dict[str, Any] = {"cell_type": ctype, "metadata": {}, "source": c.source}
        if ctype == "code":
            entry["execution_count"] = None
            entry["outputs"] = []
        nb_cells.append(entry)
    return {
        "cells": nb_cells,
        "metadata": {"language_info": {"name": "python"}},
        "nbformat": 4,
        "nbformat_minor": 5,
    }


def _rerun_whole_notebook(
    cells: list[CellOutput],
    *,
    cell_types: dict[int, str] | None,
    assignment_id: str,
    data_dir: Path | None,
    timeout: int,
    kernel_name: str,
) -> ExecutionResult:
    """Execute the current notebook state end-to-end in a fresh sandbox.

    A single-cell re-run loses the kernel state built by earlier cells
    (regression: `_00` — cell 18 used ``measured_a`` defined earlier in the
    notebook, but the isolated re-run raised ``NameError``). Re-running the
    whole notebook keeps dependencies intact and produces a coherent,
    reviewable result.
    """
    nb = _rebuild_notebook(cells, cell_types)
    tmp_fd, tmp_path_str = tempfile.mkstemp(suffix=".ipynb", prefix="scipro-autofix-")
    os.close(tmp_fd)
    tmp_path = Path(tmp_path_str)
    try:
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(nb, f)
        return execute_notebook(
            notebook_path=tmp_path,
            timeout=timeout,
            kernel_name=kernel_name,
            data_dir=data_dir,
            assignment_id=assignment_id,
        )
    finally:
        if tmp_path.exists():
            tmp_path.unlink()


def apply_autofix_pass(
    cells: list[CellOutput],
    *,
    ki_client: KiConnectClient | None,
    cell_types: dict[int, str] | None = None,
    assignment_id: str = "",
    data_dir: Path | None = None,
    timeout: int = 30,
    kernel_name: str = "python3",
    available_paths: set[str] | None = None,
    max_passes: int = PASS_LIMIT,
    time_budget_seconds: int | None = None,
) -> dict[str, int]:
    """Automatic pipeline autofix stage (pipeline step 4), whole-notebook verify.

    Runs after notebook execution. Loop (max ``max_passes``):

    1. Take the FIRST errored code cell — an early failure poisons every
       downstream cell, so fixing it first resolves cascading errors without
       wasting fixes on symptoms.
    2. Ask KI Connect for a suggestion; skip when unavailable/invalid.
    3. Apply it to the cell with a visible ``# auto-fix:`` provenance
       comment (the student's original stays in ``original_source``).
    4. Re-run the WHOLE notebook end-to-end (fresh sandbox, all cells) so
       kernel state from earlier cells is present.
    5. Clean re-run → succeeded. More errors than before → revert. Same or
       fewer errors → next pass fixes the next root cause.

    If no clean state is reached (passes/budget/skip), ALL applied fixes are
    reverted so the teacher sees the authentic student work — never a
    half-fixed, silently-mutated notebook.

    Returns ``{"attempts": n, "succeeded": 0|1}`` where ``attempts`` counts
    fixes applied and ``succeeded`` is 1 iff the final notebook is clean.
    """
    if ki_client is None or not ki_client.api_key:
        logger.info("autofix pass skipped — KI Connect unavailable")
        return {"attempts": 0, "succeeded": 0}

    types = cell_types or {}
    original_state = copy.deepcopy(cells)
    attempts = 0
    succeeded = 0
    reverted = False
    attempted_indices: set[int] = set()
    started = time.monotonic()

    for pass_no in range(1, max_passes + 1):
        if time_budget_seconds is not None and (
            time.monotonic() - started
        ) > time_budget_seconds:
            logger.warning(
                "auto-fix: time budget (%ds) exceeded — reverting", time_budget_seconds
            )
            reverted = True
            break

        errors = [
            c
            for c in cells
            if c.error is not None and types.get(c.cell_index, "code") == "code"
        ]
        if not errors:
            break  # already clean (or cleared by the previous re-run)

        target = errors[0]
        if target.cell_index in attempted_indices:
            logger.info(
                "auto-fix: cell %d still failing after its fix — stopping",
                target.cell_index,
            )
            reverted = True
            break

        context = [
            {"type": types.get(c.cell_index, "code"), "source": c.source}
            for c in cells
            if c is not target
        ]
        result = autofix_cell(
            cell_source=target.source,
            cell_error=target.error or "",
            traceback=target.traceback,
            context_cells=context[:8] or None,
            available_paths=available_paths,
            ki_client=ki_client,
        )
        if result.get("skipped") or not result.get("patched_source"):
            logger.info(
                "auto-fix: cell %d skipped (no usable suggestion)",
                target.cell_index,
            )
            reverted = True
            break

        attempted_indices.add(target.cell_index)
        patched = str(result["patched_source"])
        comment = _build_autofix_comment(
            result.get("fix_type"), target.source, patched
        )
        target.source = f"{comment}\n{patched}"
        attempts += 1

        prev_error_count = sum(1 for c in cells if c.error is not None)
        try:
            rerun = _rerun_whole_notebook(
                cells,
                cell_types=types,
                assignment_id=assignment_id,
                data_dir=data_dir,
                timeout=timeout,
                kernel_name=kernel_name,
            )
        except Exception as e:  # pragma: no cover — kernel failures surface as cells
            logger.warning("auto-fix: whole-notebook re-run failed: %s", e)
            reverted = True
            break

        cells[:] = rerun.cells
        new_error_count = sum(1 for c in cells if c.error is not None)

        if new_error_count == 0:
            succeeded = 1
            logger.info(
                "auto-fix: pass %d — cell %d fixed; full re-run clean (%d errors → 0)",
                pass_no,
                target.cell_index,
                prev_error_count,
            )
            break
        if new_error_count > prev_error_count:
            logger.warning(
                "auto-fix: pass %d made errors worse (%d → %d) — reverting",
                pass_no,
                prev_error_count,
                new_error_count,
            )
            reverted = True
            break
        logger.info(
            "auto-fix: pass %d — cell %d fixed; %d error(s) remain",
            pass_no,
            target.cell_index,
            new_error_count,
        )

    if succeeded == 0 and not reverted:
        logger.warning(
            "auto-fix: no clean fix within %d passes — reverting", max_passes
        )
        reverted = True

    if reverted:
        cells[:] = original_state
        logger.info("auto-fix: reverted to original student cells")

    return {"attempts": attempts, "succeeded": succeeded}


def autofix_cell(
    cell_source: str,
    cell_error: str,
    traceback: list[str] | None = None,
    context_cells: list[dict[str, Any]] | None = None,
    assignment_context: str | None = None,
    available_paths: set[str] | None = None,
    ki_client: KiConnectClient | None = None,
) -> dict[str, Any]:
    """Suggest a fix for a failed cell via KI Connect.

    Args:
        cell_source: The failing cell's source code.
        cell_error: The error message from execution.
        traceback: Optional traceback lines — appended to the error text.
        context_cells: Surrounding notebook cells for LLM context.
        assignment_context: Optional free-text assignment description.
        available_paths: Input-data file paths (relative to the
            assignment's input_data dir) available to the notebook.
        ki_client: KI Connect client. None (or a client without an API
            key) short-circuits to ``{"skipped": true}``.

    Returns:
        On success: ``{"suggestion", "explanation", "confidence",
        "fix_type", "patched_source", "syntax_valid"}`` where
        ``patched_source`` is the suggestion itself when it parses as
        valid Python, else None and ``syntax_valid`` is False (the
        suggestion is returned for the teacher to review, not applied).
        On failure/unavailability: ``{"skipped": true}``.
    """
    if ki_client is None or not ki_client.api_key:
        logger.info("KI Connect unavailable — autofix skipped")
        return {"skipped": True}

    # Fold the traceback into the error text for better LLM context
    error_text = cell_error
    if traceback:
        error_text = f"{cell_error}\n" + "\n".join(traceback)

    ctx = _enrich_context(context_cells, assignment_context, available_paths)
    response = ki_client.autofix(cell_source, error_text, ctx)
    if not response or response.get("skipped"):
        return {"skipped": True}

    suggestion = str(response.get("suggestion", "")).strip()
    if not suggestion:
        logger.warning("KI Connect autofix returned an empty suggestion")
        return {"skipped": True}

    confidence = response.get("confidence")
    try:
        confidence_f = float(confidence) if confidence is not None else None
    except (TypeError, ValueError):
        confidence_f = None

    result: dict[str, Any] = {
        "skipped": False,
        "suggestion": suggestion,
        "explanation": str(response.get("explanation", "")).strip(),
        "confidence": confidence_f,
        "fix_type": response.get("fix_type"),
    }

    if is_valid_python(suggestion):
        result["patched_source"] = suggestion
        result["syntax_valid"] = True
    else:
        # Deterministic guard: never apply a suggestion that cannot parse.
        # Return it flagged so the caller can show it without re-running.
        result["patched_source"] = None
        result["syntax_valid"] = False
        logger.warning(
            "Autofix suggestion is not valid Python — flagged, not applied"
        )

    return result
