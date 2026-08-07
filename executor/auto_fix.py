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

The automatic stage (``apply_autofix_pass``) is NON-DESTRUCTIVE: it
iterates on a private working copy and returns the verified fixed
execution (``fixed_cells``) separately when the whole-notebook re-run
comes back clean; the input cells are never modified. The teacher-driven
manual flow (``apply_manual_fix`` + ``/execute/autofix-run`` in
``app.py``) gets the same guarantee: a teacher-supplied patch is verified
by re-running the WHOLE notebook — single-cell re-runs are gone (they
lose kernel state built by earlier cells, the ``_00`` regression).

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
) -> dict[str, Any]:
    """Automatic pipeline autofix stage (pipeline step 4) — NON-DESTRUCTIVE.

    The input ``cells`` (the student's original execution) is NEVER
    modified. The stage verifies fixes on a private working copy:

    1. Take the FIRST errored code cell — an early failure poisons every
       downstream cell, so fixing it first resolves cascading errors
       without wasting fixes on symptoms.
    2. Ask KI Connect for a suggestion; skip when unavailable/invalid.
    3. Apply it to the working copy (no comment, no file writes).
    4. Re-run the WHOLE notebook end-to-end (fresh sandbox, all cells) so
       kernel state from earlier cells is present.
    5. Clean re-run → ``fixed_cells`` = the verified fixed execution.
       More errors than before → stop. Same/fewer errors → next pass.

    Returns ``{"attempts": n, "succeeded": 0|1, "fixed_cells": [...] | None}``
    where ``fixed_cells`` is the verified fixed execution when the notebook
    ran clean, else None — the teacher only ever sees the original plus a
    proposal, never a half-fixed artifact.
    """
    if ki_client is None or not ki_client.api_key:
        logger.info("autofix pass skipped — KI Connect unavailable")
        return {"attempts": 0, "succeeded": 0, "fixed_cells": None}

    types = cell_types or {}
    working = copy.deepcopy(cells)  # iteration state; originals untouched
    attempts = 0
    succeeded = 0
    fixed_cells: list[CellOutput] | None = None
    attempted_indices: set[int] = set()
    started = time.monotonic()

    for pass_no in range(1, max_passes + 1):
        if time_budget_seconds is not None and (
            time.monotonic() - started
        ) > time_budget_seconds:
            logger.warning(
                "auto-fix: time budget (%ds) exceeded", time_budget_seconds
            )
            break

        errors = [
            c
            for c in working
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
            break

        context = [
            {"type": types.get(c.cell_index, "code"), "source": c.source}
            for c in working
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
            break

        attempted_indices.add(target.cell_index)
        # Apply the fix to the working copy (index-aligned like the re-run).
        target.source = str(result["patched_source"])
        attempts += 1

        prev_error_count = sum(1 for c in working if c.error is not None)
        try:
            rerun = _rerun_whole_notebook(
                working,
                cell_types=types,
                assignment_id=assignment_id,
                data_dir=data_dir,
                timeout=timeout,
                kernel_name=kernel_name,
            )
        except Exception as e:  # pragma: no cover — kernel failures surface as cells
            logger.warning("auto-fix: whole-notebook re-run failed: %s", e)
            break

        working = rerun.cells
        new_error_count = sum(1 for c in working if c.error is not None)

        if new_error_count == 0:
            succeeded = 1
            fixed_cells = working
            logger.info(
                "auto-fix: pass %d — cell %d fixed; full re-run clean (%d errors → 0)",
                pass_no,
                target.cell_index,
                prev_error_count,
            )
            break
        if new_error_count > prev_error_count:
            logger.warning(
                "auto-fix: pass %d made errors worse (%d → %d) — no fixed version",
                pass_no,
                prev_error_count,
                new_error_count,
            )
            break
        logger.info(
            "auto-fix: pass %d — cell %d fixed; %d error(s) remain",
            pass_no,
            target.cell_index,
            new_error_count,
        )

    if succeeded == 0:
        logger.info("auto-fix: no clean fixed version — original cells only")
        fixed_cells = None

    return {"attempts": attempts, "succeeded": succeeded, "fixed_cells": fixed_cells}


def apply_manual_fix(
    cells: list[CellOutput],
    target_cell_index: int,
    patched_source: str,
    *,
    cell_types: dict[int, str] | None = None,
    assignment_id: str = "",
    data_dir: Path | None = None,
    timeout: int = 30,
    kernel_name: str = "python3",
) -> dict[str, Any]:
    """Verify a teacher-supplied cell patch in FULL notebook context.

    The manual "Suggest fix" flow gets the same guarantee as the automatic
    stage (the _00 regression): a single-cell re-run loses kernel state
    built by earlier cells, so a patch is verified by re-running the WHOLE
    notebook in a fresh sandbox. NON-DESTRUCTIVE — the input ``cells`` are
    never modified; the patch is applied to a private working copy.

    Exactly one attempt: the patch is teacher-chosen (there is no LLM loop).

    Returns:
        ``{"fixed", "fixed_cells", "re_run_error", "re_run_output",
        "total_cells", "executed_cells", "error_cells"}`` where ``fixed``
        is True only when the whole re-run came back clean; ``fixed_cells``
        is the verified fixed execution then, else None (no half-fixed
        artifact is ever published); ``re_run_error``/``re_run_output``
        describe the TARGET cell after the re-run so the teacher sees the
        real consequence in context.

    Raises:
        ValueError: when ``target_cell_index`` is out of range.
    """
    if not 0 <= target_cell_index < len(cells):
        raise ValueError(
            f"target_cell_index {target_cell_index} out of range (len {len(cells)})"
        )

    types = cell_types or {}
    working = copy.deepcopy(cells)  # private copy; originals untouched
    working[target_cell_index].source = patched_source

    rerun = _rerun_whole_notebook(
        working,
        cell_types=types,
        assignment_id=assignment_id,
        data_dir=data_dir,
        timeout=timeout,
        kernel_name=kernel_name,
    )

    fixed = not any(c.error is not None for c in rerun.cells)
    target_after = rerun.cells[target_cell_index] if target_cell_index < len(rerun.cells) else None

    return {
        "fixed": fixed,
        "fixed_cells": rerun.cells if fixed else None,
        "re_run_error": target_after.error if target_after and not fixed else None,
        "re_run_output": target_after.output_text if target_after else "",
        "total_cells": rerun.total_cells,
        "executed_cells": sum(1 for c in rerun.cells if c.execution_count is not None),
        "error_cells": sum(1 for c in rerun.cells if c.error is not None),
    }


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
