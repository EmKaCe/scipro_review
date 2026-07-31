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

The re-run side of the loop (max 1 attempt per cell) lives in
:func:`runner.execute_single_cell` and is wired up in ``app.py``.

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
import logging
from typing import Any

from ki_connect import KiConnectClient

logger = logging.getLogger("auto_fix")


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
