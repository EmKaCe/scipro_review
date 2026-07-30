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
# Models
# ---------------------------------------------------------------------------


class CellOutput:
    """Structured output from executing a single notebook cell."""

    __slots__ = (
        "cell_index",
        "execution_count",
        "source",
        "output_text",
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
    ) -> None:
        self.cell_index = cell_index
        self.execution_count = execution_count
        self.source = source
        self.output_text = output_text
        self.error = error
        self.traceback = traceback

    def to_dict(self) -> dict[str, Any]:
        return {
            "cell_index": self.cell_index,
            "execution_count": self.execution_count,
            "source": self.source,
            "output_text": self.output_text,
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
    )

    def __init__(
        self,
        notebook_path: str,
        cells: list[CellOutput],
        success: bool,
        total_cells: int,
        duration_seconds: float,
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

    def to_dict(self) -> dict[str, Any]:
        return {
            "success": self.success,
            "notebook_path": self.notebook_path,
            "cells": [c.to_dict() for c in self.cells],
            "total_cells": self.total_cells,
            "executed_cells": self.executed_cells,
            "error_cells": self.error_cells,
            "duration_seconds": self.duration_seconds,
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


def create_sandbox(notebook_path: Path, data_dir: Path) -> tuple[Path, Path]:
    """Create a temporary sandbox with the notebook and its data files.

    Copies the notebook and any data files (CSV, TXT, etc.) found in the
    same directory or parent directories (up to ``data_dir``) into a
    temporary directory so execution has the right working directory.

    Args:
        notebook_path: Path to the ``.ipynb`` file.
        data_dir: Root data directory (usually /app/data).

    Returns:
        (sandbox_dir, copied_notebook_path).
    """
    sandbox = Path(tempfile.mkdtemp(prefix="scipro-exec-"))
    logger.debug("Created sandbox: %s", sandbox)

    # Copy the notebook
    dest_nb = sandbox / notebook_path.name
    shutil.copy2(notebook_path, dest_nb)

    # Walk up from the notebook's directory to find data files.
    # Stop at data_dir (don't go above it) or at the filesystem root.
    seen: set[str] = set()
    current = notebook_path.parent
    while (
        current != data_dir.parent
        and current.exists()
        and current != current.parent  # stop at filesystem root (/)
    ):
        for ext in _DATA_EXTENSIONS:
            for f in current.glob(f"*{ext}"):
                if f.stem not in seen:
                    seen.add(f.stem)
                    shutil.copy2(f, sandbox / f.name)
                    logger.debug("Copied data file: %s", f.name)
        if current == data_dir:
            break
        current = current.parent

    return sandbox, dest_nb


def cleanup_sandbox(sandbox_dir: Path) -> None:
    """Remove a sandbox directory and all its contents."""
    if sandbox_dir.exists():
        shutil.rmtree(sandbox_dir, ignore_errors=True)
        logger.debug("Removed sandbox: %s", sandbox_dir)


# ---------------------------------------------------------------------------
# Output extraction
# ---------------------------------------------------------------------------


def _extract_outputs(
    cell: dict[str, Any],
) -> tuple[str, str | None, list[str] | None]:
    """Extract text output, error, and traceback from an executed cell.

    Args:
        cell: A notebook cell dict (nbformat >= 4).

    Returns:
        (output_text, error_message, traceback_lines).
    """
    output_text_parts: list[str] = []
    error: str | None = None
    traceback: list[str] | None = None

    for output in cell.get("outputs", []):
        output_type = output.get("output_type", "")

        if output_type == "stream":
            text = output.get("text", "")
            if isinstance(text, list):
                text = "".join(text)
            if text:
                output_text_parts.append(text)

        elif output_type == "execute_result":
            text = output.get("data", {}).get("text/plain", "")
            if isinstance(text, list):
                text = "".join(text)
            if text:
                output_text_parts.append(text)

        elif output_type == "display_data":
            text = output.get("data", {}).get("text/plain", "")
            if isinstance(text, list):
                text = "".join(text)
            if text:
                output_text_parts.append(text)

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

    return "\n".join(output_text_parts).strip(), error, traceback


# ---------------------------------------------------------------------------
# Core execution
# ---------------------------------------------------------------------------


def execute_notebook(
    notebook_path: Path,
    timeout: int = 300,
    kernel_name: str = "python3",
    data_dir: Path | None = None,
) -> ExecutionResult:
    """Execute a Jupyter notebook and return structured cell-by-cell results.

    The execution flow:
    1. Create a sandbox (temp dir) with the notebook + data files
    2. Load and execute the notebook via nbclient
    3. Extract structured outputs per cell
    4. Clean up the sandbox
    5. Return an :class:`ExecutionResult`

    Args:
        notebook_path: Path to the ``.ipynb`` file.
        timeout: Per-cell timeout in seconds.
        kernel_name: Jupyter kernel name (default ``python3``).
        data_dir: Root data directory for sandbox setup. Falls back to
                  the notebook's parent directory.

    Returns:
        :class:`ExecutionResult` with per-cell data.
    """
    if data_dir is None:
        data_dir = notebook_path.parent

    start_time = time.monotonic()
    sandbox_dir: Path | None = None

    try:
        # 1. Create sandbox
        sandbox_dir, sandbox_nb = create_sandbox(notebook_path, data_dir)

        # 2. Load notebook
        with open(sandbox_nb, "r", encoding="utf-8") as f:
            nb = nbformat.read(f, as_version=4)

        total_cells = len(nb.cells)

        # 3. Configure and run nbclient
        client = nbclient.NotebookClient(
            nb,
            timeout=timeout,
            kernel_name=kernel_name,
            allow_errors=True,  # Continue executing after cell errors
            raise_on_cell_error=False,
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
            output_text, error, traceback = _extract_outputs(cell)

            cells.append(
                CellOutput(
                    cell_index=i,
                    execution_count=getattr(cell, "execution_count", None),
                    source=source_str,
                    output_text=output_text,
                    error=error,
                    traceback=traceback,
                )
            )

        duration = time.monotonic() - start_time
        success = total_cells > 0

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
        )

    finally:
        # 5. Cleanup sandbox
        if sandbox_dir is not None:
            cleanup_sandbox(sandbox_dir)
