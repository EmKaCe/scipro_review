"""
Notebook Executor — FastAPI microservice.

Executes .ipynb files on demand and returns structured results.
In Phase 4 this will also support LLM-based pre-evaluation.

Run: uvicorn app:app --host 0.0.0.0 --port 8766 --reload
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

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
    version="0.1.0",
    description="Executes Jupyter notebook submissions and returns results.",
)

# Allow the SvelteKit frontend (wherever it's served from)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # tighten in production: ["http://localhost:4174"]
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Data directory (shared named volume)
# ---------------------------------------------------------------------------
DATA_DIR = Path(os.getenv("DATA_DIR", "/app/data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)

# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------


class ExecuteRequest(BaseModel):
    """Request to execute a notebook."""

    notebook_path: str
    """Relative path inside the shared data directory."""

    timeout: int = 300
    """Per-cell execution timeout in seconds."""

    kernel_name: str = "python3"
    """Jupyter kernel to use."""


class CellResult(BaseModel):
    """Result of a single executed cell."""

    cell_index: int
    execution_count: int | None
    source: str
    output_text: str
    error: str | None = None
    traceback: list[str] | None = None


class ExecuteResponse(BaseModel):
    """Result of a notebook execution."""

    success: bool
    notebook_path: str
    cells: list[CellResult]
    total_cells: int
    executed_cells: int
    error_cells: int


class HealthResponse(BaseModel):
    """Health check response."""

    status: str = "ok"
    version: str = "0.1.0"
    data_dir: str


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@app.get("/health", response_model=HealthResponse)
async def health():
    """Readiness probe for Docker health checks."""
    return HealthResponse(data_dir=str(DATA_DIR))


@app.post("/execute", response_model=ExecuteResponse)
async def execute_notebook(req: ExecuteRequest):
    """
    Execute a Jupyter notebook and return cell-by-cell results.

    This is a stub — real notebook execution will be implemented
    using nbclient once the service is operational.
    """
    logger.info(
        "execute request: path=%s timeout=%d", req.notebook_path, req.timeout
    )

    full_path = DATA_DIR / req.notebook_path

    if not full_path.exists():
        raise HTTPException(
            status_code=404,
            detail=f"Notebook not found: {req.notebook_path}",
        )

    if full_path.suffix not in (".ipynb",):
        raise HTTPException(
            status_code=400,
            detail=f"Not a Jupyter notebook: {req.notebook_path}",
        )

    # TODO(Phase 3): implement nbclient-based execution
    raise HTTPException(
        status_code=501,
        detail=f"Not implemented — nbclient execution is pending Phase 3 ({req.notebook_path})",
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
