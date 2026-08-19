"""
Notebook Executor — FastAPI microservice.

Executes .ipynb files on demand and returns structured results.
Pre-processes notebooks before execution (Colab stripping, path
normalization, optional LLM analysis).

Endpoints:
    GET  /health          — Readiness probe
    POST /execute         — Execute a single notebook
    POST /execute/batch   — Execute multiple notebooks sequentially
    POST /auto-fix        — Suggest a fix for a failed cell (Phase 3c)
    POST /execute/autofix-run — Re-run a patched cell, max 1 attempt (3c.2)

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
from auto_fix import apply_autofix_pass, apply_manual_fix, autofix_cell, is_valid_python
from logs import install as install_log_buffer, snapshot as logs_snapshot, total as logs_total
from preprocessor import PreprocessingResult, preprocess_notebook
from runner import (
    CellOutput,
    _DATA_EXTENSIONS,
    execute_notebook as run_notebook,
)

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
log_level = os.getenv("EXECUTOR_LOG_LEVEL", "info").upper()
logging.basicConfig(
    level=getattr(logging, log_level, logging.INFO),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
install_log_buffer()
logger = logging.getLogger("executor")

# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------
app = FastAPI(
    title="Notebook Executor",
    version="0.3.0",
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


class RichCellOutput(BaseModel):
    """A preserved rich (non-text) notebook output for the teacher preview.

    ``mime_type`` is ``image/png`` (``data`` is base64) or ``text/html``
    (``data`` is a raw HTML string). Capped in the executor (see
    ``runner.RICH_OUTPUT_MAX_IMAGE_BYTES`` / ``RICH_OUTPUT_MAX_HTML_CHARS``)
    so results.json can never be ballooned by one student cell. Rich output
    never rides inside ``output_text`` — LLM prompts stay text-only.
    """

    mime_type: str
    data: str


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
    cell_type: str = "code"
    """Cell type from the original notebook ("code" | "markdown")."""

    outputs: list[RichCellOutput] = []
    """Rich (non-text) outputs for the teacher preview: image/png (base64) and
    text/html (raw). Never folded into ``output_text`` — prompts stay
    text-only (byte-identity contract). Empty for markdown / plain-text-only
    cells."""


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


class AutofixInfo(BaseModel):
    """Counts from the automatic pipeline autofix stage (whole-notebook verify).

    ``attempts`` counts fixes applied (max one KI suggestion per cell);
    ``succeeded`` is 1 iff the fixed notebook ran clean after the pass —
    in that case ``ExecuteResponse.fixed_cells`` carries the verified fixed
    execution. When 0, no clean fixed version exists (the original cells
    are the only output; the teacher never sees a half-fixed artifact).
    """

    attempts: int = 0
    """Fixes applied (each followed by a whole-notebook re-run)."""
    succeeded: int = 0
    """1 iff a clean fixed version exists (fixed_cells != None), else 0."""


class ExecuteResponse(BaseModel):
    """Result of a notebook execution."""

    success: bool
    notebook_path: str
    cells: list[CellResult]
    fixed_cells: list[CellResult] | None = None
    """Verified fixed execution from the automatic autofix stage, aligned
    by cell_index. None unless the pass produced a clean re-run — the
    original ``cells`` are never modified (student work stays authentic)."""
    total_cells: int
    executed_cells: int
    error_cells: int
    duration_seconds: float = 0.0
    preprocessing: PreprocessingInfo = PreprocessingInfo()
    modified_files: list[str] = []
    """Input-data files the notebook wrote to or overwrote during execution."""
    autofix: AutofixInfo = AutofixInfo()
    """Automatic pipeline autofix stage (max 1 attempt per errored cell)."""


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

    autofix: AutofixInfo = AutofixInfo()
    """Automatic pipeline autofix stage (max 1 attempt per errored cell)."""


class BatchExecuteResponse(BaseModel):
    """Result of a batch execution."""

    results: list[BatchItemResult]
    total_notebooks: int
    succeeded: int
    failed: int
    total_duration_seconds: float


class LogEntry(BaseModel):
    """One captured executor log line (see GET /logs)."""

    id: int
    ts: float
    level: str
    logger: str
    message: str


class LogsResponse(BaseModel):
    """Recent executor pipeline log entries, oldest → newest."""

    entries: list[LogEntry]
    truncated: bool = False
    """True when the buffer held more entries than the requested limit."""


class HealthResponse(BaseModel):
    """Health check response."""

    status: str = "ok"
    version: str = "0.3.0"
    data_dir: str
    ki_connect_available: bool = False


class AutoFixRequest(BaseModel):
    """Request to suggest a fix for a failed cell (Phase 3c.1)."""

    cell_source: str
    """The failing cell's source code (as the student wrote it)."""

    cell_error: str
    """Error message from the failed execution."""

    cell_index: int | None = None
    """Index of the failing cell in the notebook (informational)."""

    traceback: list[str] | None = None
    """Optional traceback lines — appended to the error for the LLM."""

    context_cells: list[dict[str, Any]] | None = None
    """Surrounding notebook cells for LLM context."""

    assignment_context: str | None = None
    """Optional free-text assignment description."""

    assignment_id: str | None = None
    """Assignment id — used to discover available input-data files."""

    notebook_path: str | None = None
    """Path of the notebook the cell belongs to (informational)."""


class AutoFixResponse(BaseModel):
    """Fix suggestion for a failed cell."""

    skipped: bool = False
    """True when KI Connect is unavailable or returned nothing usable."""

    suggestion: str | None = None
    """Corrected cell source proposed by the LLM."""

    explanation: str | None = None
    """Brief explanation of what was wrong and how the fix works."""

    confidence: float | None = None
    """Model confidence in the fix (0–1)."""

    fix_type: str | None = None
    """Categorization of the fix (import_fix, syntax_fix, …)."""

    patched_source: str | None = None
    """Suggestion when it parses as valid Python — safe to re-run. None
    when the suggestion failed the syntax sanity check."""

    syntax_valid: bool | None = None
    """Result of the deterministic ast.parse sanity check."""


class AutoFixRunCell(BaseModel):
    """One notebook cell sent as context for manual fix verification."""

    source: str
    """The cell source as executed (index-aligned with the notebook)."""

    cell_type: str = "code"
    """``code`` or ``markdown`` — only code cells can be patched."""


class AutoFixRunRequest(BaseModel):
    """Verify a teacher-supplied patch for one cell in FULL notebook context.

    The manual flow gets the same guarantee as the automatic autofix stage:
    the patch is verified by re-running the WHOLE notebook (a single-cell
    re-run loses kernel state built by earlier cells — the ``_00``
    regression). The request carries the notebook's executed cells so the
    executor can rebuild it; nothing is ever mutated.
    """

    cells: list[AutoFixRunCell]
    """The full notebook, index-aligned, as executed (before the patch)."""

    target_cell_index: int
    """Index of the cell being patched (must be a code cell)."""

    patched_source: str
    """The fixed source to verify. Must parse as valid Python."""

    assignment_id: str | None = None
    """Assignment id — stages the assignment's input data in the sandbox."""

    notebook_path: str | None = None
    """Path of the notebook the cell belongs to (informational)."""

    timeout: int = 30
    """Per-cell execution timeout in seconds."""

    kernel_name: str = "python3"
    """Jupyter kernel to use."""


class AutoFixRunResponse(BaseModel):
    """Result of verifying a patched cell against the whole notebook."""

    fixed: bool
    """True only when the whole-notebook re-run came back clean."""

    patched_source: str
    """The fixed source that was verified."""

    re_run_output: str = ""
    """The patched cell's output after the whole-notebook re-run."""

    re_run_error: str | None = None
    """The patched cell's error after the re-run — None when it ran clean."""

    fixed_cells: list[CellResult] | None = None
    """The verified fixed execution when the re-run was clean, else None
    (no half-fixed artifact is ever published)."""

    total_cells: int = 0
    executed_cells: int = 0
    error_cells: int = 0


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
    cell_types: dict[int, str] | None = None,
) -> list[CellResult]:
    """Convert runner CellOutput objects to Pydantic models.

    Args:
        cells: Runner CellOutput objects.
        original_sources: Map of cell_index → student's untouched source
            (from ``PreprocessingResult.original_cells``). Falls back to
            the executed source when a cell has no recorded original.
        cell_types: Map of cell_index → original cell type
            (from ``PreprocessingResult.normalized_cells``). Falls back to
            "code" when a cell has no recorded type.
    """
    if original_sources is None:
        original_sources = {}
    if cell_types is None:
        cell_types = {}
    return [
        CellResult(
            cell_index=c.cell_index,
            execution_count=c.execution_count,
            source=c.source,
            original_source=original_sources.get(c.cell_index, c.source),
            output_text=c.output_text,
            error=c.error,
            traceback=c.traceback,
            cell_type=cell_types.get(c.cell_index, "code"),
            outputs=[
                RichCellOutput(mime_type=o["mime_type"], data=o["data"])
                for o in getattr(c, "outputs", []) or []
            ],
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


@app.get("/logs", response_model=LogsResponse)
async def logs(limit: int = 200) -> LogsResponse:
    """Recent pipeline log entries (oldest → newest) for the teacher UI.

    Backed by an in-memory ring buffer (``logs.py``) that captures the
    executor/runner/preprocessor/auto-fix/ki-connect loggers. The panel
    polls this while a batch runs so the teacher sees what the pipeline
    is doing in real time.
    """
    clamped = max(1, min(limit, 1000))
    entries = [LogEntry(**e) for e in logs_snapshot(clamped)]
    return LogsResponse(
        entries=entries,
        truncated=logs_total() > clamped,
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

    # Pipeline step 4 — automatic autofix (max 1 attempt per errored code
    # cell). Replaces fixed cells with the re-run outcome; counts reported.
    cell_types = {
        nc["index"]: nc["type"]
        for nc in pre_result.normalized_cells
        if nc.get("type") is not None
    }
    autofix_info = apply_autofix_pass(
        exec_result.cells,
        ki_client=_get_ki_client(),
        cell_types=cell_types,
        assignment_id=assignment_id or "",
        data_dir=DATA_DIR,
        timeout=req.timeout,
        kernel_name=req.kernel_name,
        available_paths=(
            _discover_data_files(assignment_id, DATA_DIR) if assignment_id else set()
        ),
        # Rough wall-clock guard for the autofix re-runs: the per-cell
        # timeout scaled up. The frontend's per-notebook HTTP budget
        # (settings.executor.notebookTimeoutMs) must cover the original run
        # plus up to PASS_LIMIT re-runs; raise it for heavy notebooks.
        time_budget_seconds=max(60, req.timeout * 5),
    )

    # The autofix pass is non-destructive — `cells` still describe the
    # ORIGINAL execution, so the summary honestly shows the pre-fix state
    # (a fixed submission reads e.g. "3 cells, 2 errors" + autofix 1/1).
    # The verified fixed execution (if any) travels separately in
    # fixed_cells; the pass's private working copy is discarded.
    fixed_cells_raw = autofix_info.pop("fixed_cells", None)

    error_cells = sum(1 for c in exec_result.cells if c.error is not None)
    executed_cells = sum(
        1 for c in exec_result.cells if c.execution_count is not None
    )

    return ExecuteResponse(
        success=exec_result.success,
        notebook_path=req.notebook_path,
        cells=_cells_to_response(
            exec_result.cells,
            pre_result.original_cells,
            cell_types,
        ),
        fixed_cells=(
            _cells_to_response(fixed_cells_raw, pre_result.original_cells, cell_types)
            if fixed_cells_raw
            else None
        ),
        total_cells=exec_result.total_cells,
        executed_cells=executed_cells,
        error_cells=error_cells,
        duration_seconds=exec_result.duration_seconds,
        preprocessing=pre_info,
        modified_files=exec_result.modified_files,
        autofix=AutofixInfo(**autofix_info),
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
            assignment_id, _, pre_result, exec_path = _load_and_preprocess(
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

            # Pipeline step 4 — automatic autofix (whole-notebook verify),
            # same as the single-notebook /execute path.
            cell_types = {
                nc["index"]: nc["type"]
                for nc in pre_result.normalized_cells
                if nc.get("type") is not None
            }
            autofix_info = apply_autofix_pass(
                exec_result.cells,
                ki_client=_get_ki_client(),
                cell_types=cell_types,
                assignment_id=assignment_id or "",
                data_dir=DATA_DIR,
                timeout=nb_req.timeout,
                kernel_name=nb_req.kernel_name,
                available_paths=(
                    _discover_data_files(assignment_id, DATA_DIR)
                    if assignment_id
                    else set()
                ),
                time_budget_seconds=max(60, nb_req.timeout * 5),
            )

            duration = _time.monotonic() - nb_start

            results.append(
                BatchItemResult(
                    notebook_path=nb_req.notebook_path,
                    success=exec_result.success,
                    total_cells=exec_result.total_cells,
                    executed_cells=sum(
                        1 for c in exec_result.cells if c.execution_count is not None
                    ),
                    error_cells=sum(1 for c in exec_result.cells if c.error is not None),
                    duration_seconds=duration,
                    modified_files=exec_result.modified_files,
                    autofix=AutofixInfo(**autofix_info),
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


@app.post(
    "/auto-fix",
    response_model=AutoFixResponse,
    response_model_exclude_none=True,
)
async def auto_fix(req: AutoFixRequest) -> AutoFixResponse:
    """Suggest a fix for a failed notebook cell (Phase 3c.1).

    Sends the failing source + error (+ optional context cells) to KI
    Connect. The suggested fix is sanity-checked with ``ast.parse`` —
    when invalid, it is returned flagged (``syntax_valid=false``, no
    ``patched_source``) instead of being applied. Responds 200 with
    ``{"skipped": true}`` when KI Connect is unavailable (no API key or
    upstream failure).
    """
    logger.info(
        "auto-fix: cell_index=%s assignment=%s error=%s",
        req.cell_index,
        req.assignment_id,
        req.cell_error.splitlines()[0] if req.cell_error else "",
    )

    # Reuse the /execute data-discovery pattern: the assignment's input
    # files give the LLM the file names the fix may need to reference.
    available_paths: set[str] = set()
    if req.assignment_id:
        available_paths = _discover_data_files(req.assignment_id, DATA_DIR)

    result = autofix_cell(
        cell_source=req.cell_source,
        cell_error=req.cell_error,
        traceback=req.traceback,
        context_cells=req.context_cells,
        assignment_context=req.assignment_context,
        available_paths=available_paths,
        ki_client=_get_ki_client(),
    )
    if result.get("skipped"):
        return AutoFixResponse(skipped=True)

    return AutoFixResponse(
        skipped=False,
        suggestion=result.get("suggestion"),
        explanation=result.get("explanation"),
        confidence=result.get("confidence"),
        fix_type=result.get("fix_type"),
        patched_source=result.get("patched_source"),
        syntax_valid=result.get("syntax_valid"),
    )


@app.post(
    "/execute/autofix-run",
    response_model=AutoFixRunResponse,
)
async def autofix_run(req: AutoFixRunRequest) -> AutoFixRunResponse:
    """Verify a teacher-supplied cell patch in FULL notebook context (3c.2).

    The manual "Suggest fix" flow gets the same guarantee as the automatic
    autofix stage: the patch is applied to a private working copy and the
    WHOLE notebook is re-run in a fresh sandbox — a single-cell re-run
    loses kernel state built by earlier cells (the ``_00`` regression).
    Nothing is ever mutated; ``fixed`` is True only when the whole re-run
    came back clean. Exactly one attempt: the patch is teacher-chosen.
    """
    # Deterministic guard: refuse to verify a patch that cannot parse.
    if not is_valid_python(req.patched_source):
        raise HTTPException(
            status_code=400,
            detail="patched_source is not valid Python — refusing to verify",
        )
    if not 0 <= req.target_cell_index < len(req.cells):
        raise HTTPException(
            status_code=400,
            detail=f"target_cell_index {req.target_cell_index} out of range (len {len(req.cells)})",
        )
    if req.cells[req.target_cell_index].cell_type != "code":
        raise HTTPException(
            status_code=400,
            detail="target cell is not a code cell — refusing to verify",
        )

    logger.info(
        "autofix-run: assignment=%s target=%d/%d timeout=%d kernel=%s",
        req.assignment_id,
        req.target_cell_index,
        len(req.cells),
        req.timeout,
        req.kernel_name,
    )

    # Rebuild the executed notebook state (sources + types only — outputs
    # are not needed to re-run) and hand it to the non-destructive verifier.
    cells = [
        CellOutput(
            cell_index=i,
            execution_count=None,
            source=c.source,
            output_text="",
        )
        for i, c in enumerate(req.cells)
    ]
    cell_types = {i: c.cell_type for i, c in enumerate(req.cells)}

    try:
        info = apply_manual_fix(
            cells,
            req.target_cell_index,
            req.patched_source,
            cell_types=cell_types,
            assignment_id=req.assignment_id or "",
            data_dir=DATA_DIR,
            timeout=req.timeout,
            kernel_name=req.kernel_name,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("Manual autofix verify failed")
        raise HTTPException(
            status_code=500,
            detail=f"Manual autofix verify failed: {e}",
        )

    return AutoFixRunResponse(
        fixed=bool(info["fixed"]),
        patched_source=req.patched_source,
        re_run_output=info.get("re_run_output") or "",
        re_run_error=info.get("re_run_error"),
        fixed_cells=(
            _cells_to_response(
                info["fixed_cells"],
                {i: c.source for i, c in enumerate(req.cells)},
                cell_types,
            )
            if info["fixed_cells"]
            else None
        ),
        total_cells=info["total_cells"],
        executed_cells=info["executed_cells"],
        error_cells=info["error_cells"],
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
