"""Notebook execution engine using nbclient.

Core logic:
- Execute a ``.ipynb`` file cell-by-cell with per-cell timeout
- Sandbox: copy notebook + referenced data files to a temp directory before executing
- Kernel lifecycle management (create → execute → shutdown)
- Structured result capture (source, output, error, execution_count)

Usage:
    result = execute_notebook(Path("notebook.ipynb"))
    for cell in result.cells:
        print(cell.cell_index, cell.error)
"""

from __future__ import annotations

import filecmp
import logging
import os
import shutil
import tempfile
import time
from pathlib import Path
from typing import Any

import nbclient
import nbformat

logger = logging.getLogger("runner")

# ---------------------------------------------------------------------------
# Rich output caps (env-configurable)
#
# The teacher preview renders rich notebook outputs (image/png + text/html)
# from the stored results.json. Untrusted student output is rendered in a
# sandboxed iframe on the client, but the SIZE is bounded here in the Python
# executor so a single student cell cannot balloon the stored result. These
# defaults (5 MiB per image, 200k chars of HTML) are sanity caps for storage,
# not a correctness guarantee — the iframe sandbox is the security boundary.
#
# RICH_OUTPUT_MAX_IMAGE_BYTES — decoded image byte size cap. Images over the
#     cap are SKIPPED (logged) rather than stored, so results.json can never
#     be bloated by one oversized plot.
# RICH_OUTPUT_MAX_HTML_CHARS  — character cap for text/html output. HTML over
#     the cap is truncated. (HTML is only ever rendered inside a sandboxed,
#     script-less iframe, so truncation cannot break page isolation.)
# ---------------------------------------------------------------------------

def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name, "")
    try:
        return int(raw) if raw else default
    except ValueError:
        return default


RICH_OUTPUT_MAX_IMAGE_BYTES = _env_int("RICH_OUTPUT_MAX_IMAGE_BYTES", 5 * 1024 * 1024)
RICH_OUTPUT_MAX_HTML_CHARS = _env_int("RICH_OUTPUT_MAX_HTML_CHARS", 200_000)


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------


class CellOutput:
    """Structured output from executing a single notebook cell."""

    __slots__ = (
        "cell_index",
        "execution_count",
        "source",
        "output_text",
        "outputs",
        "error",
        "traceback",
    )

    def __init__(
        self,
        cell_index: int,
        execution_count: int | None,
        source: str,
        output_text: str,
        error: str | None = None,
        traceback: list[str] | None = None,
        # NOTE: `outputs` is deliberately the LAST positional parameter —
        # pre-existing callers (test_auto_fix.py) bind `error`/`traceback`
        # positionally, so inserting a param mid-signature would silently
        # misbind them. New code must use keyword args for `outputs`.
        outputs: list[dict[str, str]] | None = None,
    ) -> None:
        self.cell_index = cell_index
        self.execution_count = execution_count
        self.source = source
        self.output_text = output_text
        # Canonical rich outputs: [{"mime_type": mime, "data": ...}] where
        # data is base64 for image/png and raw HTML for text/html. Never
        # included in `output_text` — prompts / teachers keep reading the
        # plain-text view only (byte-identity contract).
        self.outputs = outputs or []
        self.error = error
        self.traceback = traceback

    def to_dict(self) -> dict[str, Any]:
        return {
            "cell_index": self.cell_index,
            "execution_count": self.execution_count,
            "source": self.source,
            "output_text": self.output_text,
            "outputs": self.outputs,
            "error": self.error,
            "traceback": self.traceback,
        }


class ExecutionResult:
    """Complete result of executing a notebook."""

    __slots__ = (
        "notebook_path",
        "cells",
        "success",
        "total_cells",
        "duration_seconds",
        "executed_cells",
        "error_cells",
        "modified_files",
    )

    def __init__(
        self,
        notebook_path: str,
        cells: list[CellOutput],
        success: bool,
        total_cells: int,
        duration_seconds: float,
        modified_files: list[str] | None = None,
    ) -> None:
        self.notebook_path = notebook_path
        self.cells = cells
        self.success = success
        self.total_cells = total_cells
        self.duration_seconds = duration_seconds
        self.executed_cells = sum(
            1 for c in cells if c.execution_count is not None
        )
        self.error_cells = sum(1 for c in cells if c.error is not None)
        self.modified_files = modified_files or []

    def to_dict(self) -> dict[str, Any]:
        return {
            "success": self.success,
            "notebook_path": self.notebook_path,
            "cells": [c.to_dict() for c in self.cells],
            "total_cells": self.total_cells,
            "executed_cells": self.executed_cells,
            "error_cells": self.error_cells,
            "duration_seconds": self.duration_seconds,
            "modified_files": self.modified_files,
        }


# ---------------------------------------------------------------------------
# Sandbox
# ---------------------------------------------------------------------------

# File extensions likely to be input data for notebooks
_DATA_EXTENSIONS = frozenset({
    ".csv",
    ".txt",
    ".tsv",
    ".npy",
    ".npz",
    ".json",
    ".xlsx",
    ".xls",
    ".yaml",
    ".yml",
    ".xml",
})


def create_sandbox(
    notebook_path: Path,
    data_dir: Path,
    assignment_id: str,
) -> tuple[Path, Path]:
    """Create a temporary sandbox scoped to an assignment.

    Copies the notebook plus **that assignment's input data only**
    (``materials/<assignment_id>/input_data/``) into a temporary directory,
    preserving the input data's relative directory structure, so execution
    has the right working directory. Data from other assignments is never
    staged — no cross-assignment leakage.

    The assignment is derived by the caller (``app.py``) from the **original**
    notebook path (``submissions/<assignment>/…``); the executed notebook is
    a system temp file whose path carries no assignment information.

    Args:
        notebook_path: Path to the ``.ipynb`` file.
        data_dir: Root data directory (usually /app/data).
        assignment_id: Assignment the notebook belongs to. Sandbox data is
            copied from ``materials/<assignment_id>/input_data/``. If empty
            or the input_data dir is missing/empty, the sandbox contains
            only the notebook (data-access cells will fail naturally — a
            WARNING is logged for diagnostics).

    Returns:
        (sandbox_dir, copied_notebook_path).
    """
    sandbox = Path(tempfile.mkdtemp(prefix="scipro-exec-"))
    logger.debug("Created sandbox: %s", sandbox)

    # Copy the notebook
    dest_nb = sandbox / notebook_path.name
    shutil.copy2(notebook_path, dest_nb)

    # Copy the assignment's input data, preserving relative structure
    input_dir = data_dir / "materials" / assignment_id / "input_data"
    if assignment_id and input_dir.exists():
        files = [f for f in input_dir.rglob("*") if f.is_file()]
        if files:
            for f in files:
                rel = f.relative_to(input_dir)
                dest = sandbox / rel
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(f, dest)
                logger.debug("Copied data file: %s", rel)
        else:
            logger.warning(
                "input_data empty for assignment %s — data-access cells "
                "will fail",
                assignment_id,
            )
    else:
        logger.warning(
            "input_data missing for assignment %s — data-access cells "
            "will fail",
            assignment_id,
        )

    return sandbox, dest_nb


def _detect_modified_files(
    sandbox_dir: Path,
    data_dir: Path,
    assignment_id: str,
) -> list[str]:
    """Return input-data files in the sandbox that differ from their originals.

    Compares every file in the sandbox against its counterpart in
    ``materials/<assignment_id>/input_data/`` (same relative path) using
    ``filecmp.cmp(shallow=False)``. Files with no counterpart in the
    assignment's input data (the notebook itself, student-created files)
    are ignored.

    Returns:
        List of relative paths (relative to the input_data dir) that the
        notebook wrote to or overwrote during execution.
    """
    modified: list[str] = []
    input_dir = data_dir / "materials" / assignment_id / "input_data"
    if not input_dir.exists():
        return modified

    for f in sorted(sandbox_dir.rglob("*")):
        if not f.is_file():
            continue
        rel = f.relative_to(sandbox_dir)
        original = input_dir / rel
        if original.is_file() and not filecmp.cmp(f, original, shallow=False):
            modified.append(str(rel))
    return modified


def cleanup_sandbox(sandbox_dir: Path) -> None:
    """Remove a sandbox directory and all its contents."""
    if sandbox_dir.exists():
        shutil.rmtree(sandbox_dir, ignore_errors=True)
        logger.debug("Removed sandbox: %s", sandbox_dir)


# ---------------------------------------------------------------------------
# Output extraction
# ---------------------------------------------------------------------------


def _coerce_output_text(value: Any) -> str:
    """Coerce a notebook output value (str or list[str]) to a plain string."""
    if isinstance(value, list):
        return "".join(str(v) for v in value)
    return str(value)


def _extract_rich_outputs(data_map: dict[str, Any]) -> list[dict[str, str]]:
    """Extract rich (non-text) outputs from a cell's ``data`` map.

    Preserves ``image/png`` (as base64, size-capped) and ``text/html``
    (as a raw HTML string, length-capped). Base64 images over
    ``RICH_OUTPUT_MAX_IMAGE_BYTES`` are SKIPPED (logged); HTML over
    ``RICH_OUTPUT_MAX_HTML_CHARS`` is truncated. Rich data is NEVER folded
    back into ``output_text`` — the plain-text contract drives prompts.
    """
    rich: list[dict[str, str]] = []

    png = data_map.get("image/png")
    if png:
        b64 = _coerce_output_text(png)
        # base64 is ~4/3 the length of the decoded bytes; use that as a
        # cheap size estimate without decoding every plot into memory.
        if len(b64) * 3 // 4 <= RICH_OUTPUT_MAX_IMAGE_BYTES:
            rich.append({"mime_type": "image/png", "data": b64})
        else:
            logger.warning(
                "Skipping image/png output of ~%d bytes (> RICH_OUTPUT_MAX_IMAGE_BYTES=%d)",
                len(b64) * 3 // 4,
                RICH_OUTPUT_MAX_IMAGE_BYTES,
            )

    html = data_map.get("text/html")
    if html:
        html_str = _coerce_output_text(html)
        if len(html_str) > RICH_OUTPUT_MAX_HTML_CHARS:
            logger.warning(
                "Truncating text/html output to %d chars (RICH_OUTPUT_MAX_HTML_CHARS)",
                RICH_OUTPUT_MAX_HTML_CHARS,
            )
            html_str = html_str[:RICH_OUTPUT_MAX_HTML_CHARS]
        if html_str:
            rich.append({"mime_type": "text/html", "data": html_str})

    return rich


def _extract_cell_output(
    cell: dict[str, Any],
) -> tuple[str, list[dict[str, str]], str | None, list[str] | None]:
    """Extract text output, rich outputs, error, and traceback from a cell.

    Args:
        cell: A notebook cell dict (nbformat >= 4).

    Returns:
        (output_text, rich_outputs, error_message, traceback_lines).
    """
    output_text_parts: list[str] = []
    outputs: list[dict[str, str]] = []
    error: str | None = None
    traceback: list[str] | None = None

    for output in cell.get("outputs", []):
        output_type = output.get("output_type", "")
        data = output.get("data", {})

        if output_type == "stream":
            text = output.get("text", "")
            text = _coerce_output_text(text)
            if text:
                output_text_parts.append(text)

        elif output_type in ("execute_result", "display_data"):
            if not isinstance(data, dict):
                data = {}
            text = data.get("text/plain", "")
            text = _coerce_output_text(text)
            if text:
                output_text_parts.append(text)
            # Rich mime types ride alongside the plain-text view.
            outputs.extend(_extract_rich_outputs(data))

        elif output_type == "error":
            ename = output.get("ename", "")
            evalue = output.get("evalue", "")
            if ename and evalue:
                error = f"{ename}: {evalue}"
            else:
                error = ename or evalue or "Unknown error"
            tb = output.get("traceback", [])
            if tb:
                # Strip ANSI escape codes from traceback lines
                traceback = [str(line) for line in tb]

    return "\n".join(output_text_parts).strip(), outputs, error, traceback


# ---------------------------------------------------------------------------
# Core execution
# ---------------------------------------------------------------------------


def execute_notebook(
    notebook_path: Path,
    timeout: int = 300,
    kernel_name: str = "python3",
    data_dir: Path | None = None,
    assignment_id: str = "",
) -> ExecutionResult:
    """Execute a Jupyter notebook and return structured cell-by-cell results.

    The execution flow:
    1. Create a sandbox (temp dir) with the notebook + the assignment's
       input data (``materials/<assignment_id>/input_data/``)
    2. Load and execute the notebook via nbclient
    3. Extract structured outputs per cell
    4. Detect input-data files the notebook modified during execution
    5. Clean up the sandbox
    6. Return an :class:`ExecutionResult`

    Args:
        notebook_path: Path to the ``.ipynb`` file.
        timeout: Per-cell timeout in seconds.
        kernel_name: Jupyter kernel name (default ``python3``).
        data_dir: Root data directory for sandbox setup. Falls back to
                  the notebook's parent directory.
        assignment_id: Assignment the notebook belongs to (derived by the
                  caller from the original ``submissions/<assignment>/…``
                  path). Scopes the sandbox's data copy. If empty, the
                  sandbox contains only the notebook.

    Returns:
        :class:`ExecutionResult` with per-cell data.
    """
    if data_dir is None:
        data_dir = notebook_path.parent

    start_time = time.monotonic()
    sandbox_dir: Path | None = None

    try:
        # 1. Create sandbox
        sandbox_dir, sandbox_nb = create_sandbox(
            notebook_path, data_dir, assignment_id
        )

        # 2. Load notebook
        with open(sandbox_nb, "r", encoding="utf-8") as f:
            nb = nbformat.read(f, as_version=4)

        total_cells = len(nb.cells)

        # 3. Configure and run nbclient
        # resources.metadata.path = sandbox root → the kernel's working
        # directory, so bare/relative data references resolve against the
        # sandbox copy of the assignment's input data.
        client = nbclient.NotebookClient(
            nb,
            timeout=timeout,
            kernel_name=kernel_name,
            allow_errors=True,  # Continue executing after cell errors
            raise_on_cell_error=False,
            resources={"metadata": {"path": str(sandbox_dir)}},
        )

        logger.info(
            "Executing: %s (%d cells, timeout=%ds, kernel=%s)",
            notebook_path.name,
            total_cells,
            timeout,
            kernel_name,
        )

        try:
            client.execute()
        except Exception as e:
            # nbclient with allow_errors=True should finish even with errors,
            # but we handle unexpected kernel-level failures gracefully
            logger.warning(
                "nbclient raised %s: %s", type(e).__name__, e
            )

        # 4. Extract per-cell results
        cells: list[CellOutput] = []
        for i, cell in enumerate(nb.cells):
            raw_source = cell.source
            source_str = (
                raw_source
                if isinstance(raw_source, str)
                else "".join(raw_source)
            )
            output_text, outputs, error, traceback = _extract_cell_output(cell)

            cells.append(
                CellOutput(
                    cell_index=i,
                    execution_count=getattr(cell, "execution_count", None),
                    source=source_str,
                    output_text=output_text,
                    outputs=outputs,
                    error=error,
                    traceback=traceback,
                )
            )

        duration = time.monotonic() - start_time
        success = total_cells > 0

        # 4. Detect input-data modifications (sandbox copy vs original)
        modified_files = _detect_modified_files(
            sandbox_dir, data_dir, assignment_id
        )
        if modified_files:
            logger.warning(
                "Input data modified during execution of %s: %s",
                notebook_path.name,
                ", ".join(modified_files),
            )

        logger.info(
            "Completed: %s (%d/%d executed, %d errors, %.1fs)",
            notebook_path.name,
            sum(1 for c in cells if c.execution_count is not None),
            total_cells,
            sum(1 for c in cells if c.error is not None),
            duration,
        )

        return ExecutionResult(
            notebook_path=str(notebook_path),
            cells=cells,
            success=success,
            total_cells=total_cells,
            duration_seconds=duration,
            modified_files=modified_files,
        )

    finally:
        # 5. Cleanup sandbox
        if sandbox_dir is not None:
            cleanup_sandbox(sandbox_dir)
