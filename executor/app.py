"""
Notebook Executor — FastAPI microservice.

Executes .ipynb files on demand and returns structured results.
Pre-processes notebooks before execution (Colab stripping, path
normalization, optional LLM analysis).

Endpoints:
    GET  /health          — Readiness probe
    POST /execute         — Execute a single notebook
    POST /execute/batch   — Execute multiple notebooks sequentially

Run: uv icon app:app --host 0.0.0.0 --port 8766 --reload
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

import time as _time

from ki_connect import KiConnectClient
from preprocessor import PreprocessingResult, preprocess_notebook
from runner import _DATA_EXTENSIONS, execute_notebook as run_notebook

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
log_level = os.getenv("EXECUTOR_LOG_LEVEL", "info").upper()
logging.basicConfig(
    level=getattr(logging, log_level, logging.INFO),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("executor")

# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------
app = FastAPI(
    title="Notebook Executor",
    version="0.2.0",
    description=(
        "Executes Jupyter notebook submissions, pre-processes them, "
        "and returns structured cell-by-cell results."
    ),
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Data directory
# ---------------------------------------------------------------------------
DATA_DIR = Path(os.getenv("DATA_DIR", "/app/data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)

# ---------------------------------------------------------------------------
# KI Connect client (lazy)
# ---------------------------------------------------------------------------
_ki_client: KiConnectClient | None = None


def _get_ki_client() -> KiConnectClient | None:
    """Return a cached KiConnectClient or None if no API key is set."""
    global _ki_client  # noqa: PLW0603
    if _ki_client is None:
        key = os.getenv("KI_CONNECT_API_KEY", "")
        if key:
            _ki_client = KiConnectClient(api_key=key)
        else:
            logger.info("KI_CONNECT_API_KEY not set — LLM features disabled")
    return _ki_client if _ki_client and _ki_client.api_key else None


# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------


class ExecuteRequest(BaseModel):
    """Request to execute a single notebook."""

    notebook_path: str
    """Relative path inside the shared data directory."""

    timeout: int = 30
    """Per-cell execution timeout in seconds (default 30)."""

    kernel_name: str = "python3"
    """Jupyter kernel to use."""

    skip_preprocessing: bool = False
    """If true, skip both deterministic and LLM pre-processing."""

    assignment_context: str | None = None
    """Optional assignment description for LLM analysis."""


class BatchExecuteRequest(BaseModel):
    """Request to execute multiple notebooks sequentially."""

    notebooks: list[ExecuteRequest]
    """List of notebooks to execute. Processed in order."""

    stop_on_first_error: bool = False
    """If true, stop processing after the first notebook that fails."""


class CellResult(BaseModel):
    """Result of a single executed cell."""

    cell_index: int
    execution_count: int | None
    source: str
    """CLEANED + annotated source (what actually ran)."""

    original_source: str
    """NEW: student's untouched source for this cell (what the review UI shows)."""

    output_text: str
    error: str | None = None
    traceback: list[str] | None = None


class PreprocessingInfo(BaseModel):
    """Metadata about pre-processing applied to a notebook."""

    cells_modified: int = 0
    """Number of cells that had at least one edit applied."""

    total_edits: int = 0
    """Total number of individual edits across all cells."""

    edit_types: dict[str, int] = {}
    """Count of edits by type (removed_colab_import, normalized_absolute_path, …)."""

    llm_preprocessing: str = "skipped"
    """Status of LLM pre-processing: completed | skipped | error."""

    llm_analysis: bool = False
    """Whether LLM analysis data is available."""

    cell_edits: dict[int, list[dict]] = {}
    """Maps cell_index → list of edits. Each edit: {edit_type, note, …}."""


class ExecuteResponse(BaseModel):
    """Result of a notebook execution."""

    success: bool
    notebook_path: str
    cells: list[CellResult]
    total_cells: int
    executed_cells: int
    error_cells: int
    duration_seconds: float = 0.0
    preprocessing: PreprocessingInfo = PreprocessingInfo()
    modified_files: list[str] = []
    """Input-data files the notebook wrote to or overwrote during execution."""


class BatchItemResult(BaseModel):
    """Result of a single notebook within a batch."""

    notebook_path: str
    success: bool
    total_cells: int
    executed_cells: int
    error_cells: int
    duration_seconds: float
    error: str | None = None
    """Top-level error message if the notebook itself failed to execute."""

    modified_files: list[str] = []
    """Input-data files the notebook wrote to or overwrote during execution."""


class BatchExecuteResponse(BaseModel):
    """Result of a batch execution."""

    results: list[BatchItemResult]
    total_notebooks: int
    succeeded: int
    failed: int
    total_duration_seconds: float


class HealthResponse(BaseModel):
    """Health check response."""

    status: str = "ok"
    version: str = "0.2.0"
    data_dir: str
    ki_connect_available: bool = False


# ---------------------------------------------------------------------------
# Helper — load & pre-process a notebook
# ---------------------------------------------------------------------------


def _assignment_from_path(notebook_path: Path) -> str | None:
    """Derive the assignment id from a notebook path.

    Canonical layout: ``submissions/<assignment>/<file>.ipynb`` — the
    assignment is the path segment directly after ``submissions``. Returns
    None when the path doesn't match the canonical layout.

    Args:
        notebook_path: Path to the ``.ipynb`` file (may be relative).

    Returns:
        Assignment id, or None if the path has no ``submissions/`` segment.
    """
    parts = notebook_path.parts
    try:
        idx = parts.index("submissions")
    except ValueError:
        return None
    if idx + 1 < len(parts):
        return parts[idx + 1]
    return None


def _discover_data_files(assignment_id: str, data_dir: Path) -> set[str]:
    """Return the set of input-data file paths for an assignment.

    Scans ``materials/<assignment_id>/input_data/`` (canonical layout) and
    returns paths relative to the input_data dir. Used **only** as Step 2
    LLM context — the regex preprocessor never sees this set.

    Args:
        assignment_id: Assignment id.
        data_dir: Root data directory (usually /app/data).

    Returns:
        Set of relative paths (e.g. ``{"soil.csv", "nested/ref.csv"}``).
    """
    paths: set[str] = set()
    input_dir = data_dir / "materials" / assignment_id / "input_data"
    if input_dir.exists():
        for f in input_dir.rglob("*"):
            if f.is_file() and f.suffix.lower() in _DATA_EXTENSIONS:
                paths.add(str(f.relative_to(input_dir)))
    return paths


def _load_and_preprocess(
    notebook_path: Path,
    skip_preprocessing: bool,
    assignment_context: str | None,
) -> tuple[str | None, dict[str, Any], PreprocessingResult, Path]:
    """Load a .ipynb, run preprocessing, return the modified notebook dict.

    Args:
        notebook_path: Absolute path to the .ipynb file.
        skip_preprocessing: If True, skip all preprocessing steps.
        assignment_context: Optional context for LLM analysis.

    Returns:
        (assignment_id, notebook_dict, preprocessing_result,
         temp_path_for_execution). The assignment id is derived from the
        **original** notebook path (``submissions/<assignment>/…``) — the
        executed temp file's path cannot be parsed.

    Raises HTTPException (404/400/500) on errors.
    """
    if not notebook_path.exists():
        raise HTTPException(
            status_code=404,
            detail=f"Notebook not found: {notebook_path}",
        )

    if notebook_path.suffix not in (".ipynb",):
        raise HTTPException(
            status_code=400,
            detail=f"Not a Jupyter notebook: {notebook_path}",
        )

    try:
        with open(notebook_path, "r", encoding="utf-8") as f:
            notebook = json.load(f)
    except json.JSONDecodeError as e:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid notebook JSON: {e}",
        )

    assignment_id = _assignment_from_path(notebook_path)

    # Pre-processing
    if not skip_preprocessing:
        ki_client = _get_ki_client()
        available_paths = (
            _discover_data_files(assignment_id, DATA_DIR)
            if assignment_id
            else set()
        )
        pre_result = preprocess_notebook(
            notebook=notebook,
            assignment_context=assignment_context,
            ki_client=ki_client,
            available_paths=available_paths,
        )
    else:
        # Build a minimal PreprocessingResult with raw cells
        cells = notebook.get("cells", [])
        original_cells: dict[int, str] = {}
        normalized_cells: list[dict[str, Any]] = []
        for i, c in enumerate(cells):
            source = (
                "".join(c.get("source", []))
                if isinstance(c.get("source"), list)
                else str(c.get("source", ""))
            )
            original_cells[i] = source
            normalized_cells.append(
                {
                    "index": i,
                    "type": c.get("cell_type", "code"),
                    "source": source,
                }
            )
        pre_result = PreprocessingResult(
            normalized_cells=normalized_cells,
            original_cells=original_cells,
        )

    # Write the (possibly modified) notebook to a temp file for execution
    # so the sandbox uses the cleaned version
    tmp_fd, tmp_path_str = tempfile.mkstemp(
        suffix=".ipynb", prefix="scipro-norm-"
    )
    os.close(tmp_fd)
    tmp_path = Path(tmp_path_str)
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(notebook, f)

    return assignment_id, notebook, pre_result, tmp_path


def _build_preprocessing_info(pre: PreprocessingResult) -> PreprocessingInfo:
    """Convert a PreprocessingResult to the API response model."""
    edit_types: dict[str, int] = {}
    for edit in pre.edits:
        edit_types[edit.edit_type] = edit_types.get(edit.edit_type, 0) + 1

    modified_cells = len({e.cell_index for e in pre.edits if e.cell_index >= 0})

    # Per-cell edit details: {edit_type, note, old_text?, new_text?}
    # (old/new text truncated to 200 chars when present)
    cell_edits: dict[int, list[dict]] = {}
    for edit in pre.edits:
        entry: dict[str, Any] = {"edit_type": edit.edit_type, "note": edit.note}
        if edit.old_text is not None:
            entry["old_text"] = edit.old_text[:200]
        if edit.new_text is not None:
            entry["new_text"] = edit.new_text[:200]
        cell_edits.setdefault(edit.cell_index, []).append(entry)

    return PreprocessingInfo(
        cells_modified=modified_cells,
        total_edits=len(pre.edits),
        edit_types=edit_types,
        llm_preprocessing=pre.llm_preprocessing,
        llm_analysis=pre.analysis is not None,
        cell_edits=cell_edits,
    )


def _cells_to_response(
    cells: list,
    original_sources: dict[int, str] | None = None,
) -> list[CellResult]:
    """Convert runner CellOutput objects to Pydantic models.

    Args:
        cells: Runner CellOutput objects.
        original_sources: Map of cell_index → student's untouched source
            (from ``PreprocessingResult.original_cells``). Falls back to
            the executed source when a cell has no recorded original.
    """
    if original_sources is None:
        original_sources = {}
    return [
        CellResult(
            cell_index=c.cell_index,
            execution_count=c.execution_count,
            source=c.source,
            original_source=original_sources.get(c.cell_index, c.source),
            output_text=c.output_text,
            error=c.error,
            traceback=c.traceback,
        )
        for c in cells
    ]


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    """Readiness probe for Docker health checks."""
    ki_client = _get_ki_client()
    return HealthResponse(
        data_dir=str(DATA_DIR),
        ki_connect_available=ki_client is not None,
    )


@app.post("/execute", response_model=ExecuteResponse)
async def execute_notebook(req: ExecuteRequest) -> ExecuteResponse:
    """
    Execute a Jupyter notebook and return cell-by-cell results.

    The pipeline is:
    1. Load the .ipynb from disk
    2. Pre-process (deterministic sanitization + optional LLM analysis)
    3. Execute cell-by-cell via nbclient (with sandbox)
    4. Return structured results + pre-processing metadata
    """
    logger.info(
        "execute: path=%s timeout=%d skip_preprocessing=%s",
        req.notebook_path,
        req.timeout,
        req.skip_preprocessing,
    )

    full_path = DATA_DIR / req.notebook_path

    # Load and pre-process (derives assignment_id from the original path)
    assignment_id, notebook, pre_result, exec_path = _load_and_preprocess(
        full_path,
        skip_preprocessing=req.skip_preprocessing,
        assignment_context=req.assignment_context,
    )

    pre_info = _build_preprocessing_info(pre_result)

    # Execute
    try:
        exec_result = run_notebook(
            notebook_path=exec_path,
            timeout=req.timeout,
            kernel_name=req.kernel_name,
            data_dir=DATA_DIR,
            assignment_id=assignment_id or "",
        )
    except Exception as e:
        logger.exception("Execution failed for %s", req.notebook_path)
        raise HTTPException(
            status_code=500,
            detail=f"Execution failed: {e}",
        )
    finally:
        # Clean up temp file
        if exec_path.exists():
            exec_path.unlink()

    return ExecuteResponse(
        success=exec_result.success,
        notebook_path=req.notebook_path,
        cells=_cells_to_response(exec_result.cells, pre_result.original_cells),
        total_cells=exec_result.total_cells,
        executed_cells=exec_result.executed_cells,
        error_cells=exec_result.error_cells,
        duration_seconds=exec_result.duration_seconds,
        preprocessing=pre_info,
        modified_files=exec_result.modified_files,
    )


@app.post("/execute/batch", response_model=BatchExecuteResponse)
async def execute_batch(req: BatchExecuteRequest) -> BatchExecuteResponse:
    """
    Execute multiple notebooks sequentially.

    Accepts a list of ``ExecuteRequest`` objects. Each notebook is
    pre-processed and executed in order. If ``stop_on_first_error`` is set,
    processing stops after the first 5xx-level failure.
    """
    logger.info(
        "batch execute: %d notebooks, stop_on_first_error=%s",
        len(req.notebooks),
        req.stop_on_first_error,
    )

    results: list[BatchItemResult] = []
    total_start = _time.monotonic()

    for i, nb_req in enumerate(req.notebooks):
        nb_start = _time.monotonic()
        full_path = DATA_DIR / nb_req.notebook_path
        exec_path: Path | None = None

        try:
            # Load and pre-process (derives assignment_id from the path)
            assignment_id, _, _, exec_path = _load_and_preprocess(
                full_path,
                skip_preprocessing=nb_req.skip_preprocessing,
                assignment_context=nb_req.assignment_context,
            )

            # Execute
            exec_result = run_notebook(
                notebook_path=exec_path,
                timeout=nb_req.timeout,
                kernel_name=nb_req.kernel_name,
                data_dir=DATA_DIR,
                assignment_id=assignment_id or "",
            )

            duration = _time.monotonic() - nb_start

            results.append(
                BatchItemResult(
                    notebook_path=nb_req.notebook_path,
                    success=exec_result.success,
                    total_cells=exec_result.total_cells,
                    executed_cells=exec_result.executed_cells,
                    error_cells=exec_result.error_cells,
                    duration_seconds=duration,
                    modified_files=exec_result.modified_files,
                )
            )

        except HTTPException as e:
            duration = _time.monotonic() - nb_start
            results.append(
                BatchItemResult(
                    notebook_path=nb_req.notebook_path,
                    success=False,
                    total_cells=0,
                    executed_cells=0,
                    error_cells=0,
                    duration_seconds=duration,
                    error=e.detail,
                )
            )
            if req.stop_on_first_error and e.status_code >= 500:
                logger.warning(
                    "Batch stopping after %s due to %s",
                    nb_req.notebook_path,
                    e.detail,
                )
                break
        except Exception as e:
            duration = _time.monotonic() - nb_start
            logger.exception("Batch item failed: %s", nb_req.notebook_path)
            results.append(
                BatchItemResult(
                    notebook_path=nb_req.notebook_path,
                    success=False,
                    total_cells=0,
                    executed_cells=0,
                    error_cells=0,
                    duration_seconds=duration,
                    error=str(e),
                )
            )
            if req.stop_on_first_error:
                break
        finally:
            # Clean up temp file — never leak scipro-norm-*.ipynb
            if exec_path is not None and exec_path.exists():
                exec_path.unlink()

    total_duration = _time.monotonic() - total_start
    succeeded = sum(1 for r in results if r.success)
    failed = sum(1 for r in results if not r.success)

    return BatchExecuteResponse(
        results=results,
        total_notebooks=len(results),
        succeeded=succeeded,
        failed=failed,
        total_duration_seconds=total_duration,
    )


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("PORT", "8766"))
    uvicorn.run(
        "app:app",
        host="0.0.0.0",
        port=port,
        log_level=log_level.lower(),
        reload=os.getenv("EXECUTOR_RELOAD", "false").lower() == "true",
    )
