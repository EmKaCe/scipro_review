"""Notebook pre-processing pipeline.

Two layers:
1. **Deterministic sanitization** (always runs, no external deps):
   - Strip Google Colab imports (``from google.colab``, ``import google.drive``)
   - Normalize absolute file paths to relative
   - Comment out shell commands (``!pip install``, ``!wget``, etc.)
   - Annotate each change with a ``# SciPro: …`` comment in the source

2. **LLM pre-processing** (KI Connect, skipped if unavailable):
   - Analyze notebook structure, segment into tasks, generate per-cell annotations
   - Returns structured JSON with task segments and cell groupings
   - If KI Connect returns error/timeout → skip gracefully, flag as "skipped"

Usage:
    result = preprocess_notebook(notebook_dict)
    result.normalized_cells  # list of cleaned cells
    result.edits             # list of applied changes
    result.analysis          # LLM analysis dict or None
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from typing import Any

from ki_connect import KiConnectClient

logger = logging.getLogger("preprocessor")

# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------


@dataclass
class CellEdit:
    """A single edit applied to a cell during deterministic sanitization."""

    cell_index: int
    edit_type: str
    old_text: str | None
    new_text: str | None
    note: str


@dataclass
class PreprocessingResult:
    """Result of preprocessing a complete notebook."""

    normalized_cells: list[dict[str, Any]]
    edits: list[CellEdit] = field(default_factory=list)
    analysis: dict[str, Any] | None = None
    llm_preprocessing: str = "skipped"  # "completed" | "skipped" | "error"


# ---------------------------------------------------------------------------
# Deterministic sanitization — patterns
# ---------------------------------------------------------------------------

# Google Colab import lines
COLAB_IMPORT_RE = re.compile(
    r"^\s*((?:from\s+google\.colab\s+import)|(?:import\s+google\.drive\b)).*$",
    re.MULTILINE,
)

# Absolute paths in quoted strings — Colab Drive mounts, /content/, /tmp/, etc.
ABSOLUTE_PATH_RE = re.compile(
    r"""(?P<quote>['"])(?P<prefix>
        /content/drive/|
        /content/|
        /tmp/|
        /data/|
        /home/
    ).*?(?P<filename>[^/'"]+\.[a-zA-Z]{2,4})(?P=quote)""",
    re.VERBOSE,
)

# Shell command lines starting with !
SHELL_CMD_LINE_RE = re.compile(
    r"^\s*!(pip|wget|curl|apt-get|apt|git|conda|npm|pip3)\s.*$",
    re.MULTILINE,
)

# ---------------------------------------------------------------------------
# Colab imports
# ---------------------------------------------------------------------------


def _strip_colab_imports(source: str) -> tuple[str, bool]:
    """Strip Google Colab import lines.

    Returns (modified_source, was_modified).
    """
    new_source, count = COLAB_IMPORT_RE.subn("", source)
    if count:
        # Clean up triple-newlines left by removed lines
        new_source = re.sub(r"\n{3,}", "\n\n", new_source)
    return new_source, count > 0


# ---------------------------------------------------------------------------
# Absolute path normalization
# ---------------------------------------------------------------------------


def _normalize_paths(source: str) -> tuple[str, list[tuple[str, str]]]:
    """Replace absolute paths with bare filenames.

    Returns (modified_source, [(old_path, new_path), ...]).
    """
    changes: list[tuple[str, str]] = []

    def _replace(m: re.Match) -> str:
        quote = m.group("quote")
        filename = m.group("filename")
        old = m.group(0)
        new = f"{quote}{filename}{quote}"
        changes.append((old.strip(quote), filename))
        return new

    result = ABSOLUTE_PATH_RE.sub(_replace, source)
    return result, changes


# ---------------------------------------------------------------------------
# Shell commands
# ---------------------------------------------------------------------------


def _comment_shell_commands(
    source: str,
) -> tuple[str, list[str]]:
    """Comment out shell commands (!pip, !wget, etc.).

    Returns (modified_source, [original_command, ...]).
    """
    commented: list[str] = []

    def _replace(m: re.Match) -> str:
        line = m.group(0).strip()
        commented.append(line.lstrip("!"))
        return (
            f"# SciPro: commented out shell command\n"
            f"# {line}"
        )

    result = SHELL_CMD_LINE_RE.sub(_replace, source)
    return result, commented


# ---------------------------------------------------------------------------
# Cell source helpers
# ---------------------------------------------------------------------------


def _get_cell_source(cell: dict[str, Any]) -> str:
    """Extract source string from a notebook cell dict (handles list/str)."""
    source = cell.get("source", "")
    if isinstance(source, list):
        return "".join(source)
    return str(source)


def _set_cell_source(cell: dict[str, Any], source: str) -> None:
    """Set source on a notebook cell, preserving the original format type."""
    original = cell.get("source", "")
    if isinstance(original, list):
        cell["source"] = source.splitlines(keepends=True)
    else:
        cell["source"] = source


# ---------------------------------------------------------------------------
# Layer 1: Deterministic sanitization (per-cell)
# ---------------------------------------------------------------------------


def sanitize_cell(source: str, cell_index: int = -1) -> tuple[str, list[CellEdit]]:
    """Apply all deterministic sanitization steps to a single code cell.

    Args:
        source: Raw cell source code string.
        cell_index: Index for labelling edits (default -1 = unknown).

    Returns:
        (sanitized_source, list_of_edits).
    """
    edits: list[CellEdit] = []
    modified = source

    # 1. Strip Colab imports
    stripped, was_modified = _strip_colab_imports(modified)
    if was_modified:
        edits.append(
            CellEdit(
                cell_index=cell_index,
                edit_type="colab_import_removed",
                old_text="(colab import line)",
                new_text="",
                note="Removed Google Colab import(s)",
            )
        )
        modified = stripped

    # 2. Normalize absolute paths
    normalized, path_changes = _normalize_paths(modified)
    for old_path, new_path in path_changes:
        edits.append(
            CellEdit(
                cell_index=cell_index,
                edit_type="path_normalized",
                old_text=old_path,
                new_text=new_path,
                note=f"Normalized path: {old_path} → {new_path}",
            )
        )
    modified = normalized

    # 3. Comment out shell commands
    commented, shell_cmds = _comment_shell_commands(modified)
    for cmd in shell_cmds:
        edits.append(
            CellEdit(
                cell_index=cell_index,
                edit_type="shell_cmd_commented",
                old_text=cmd,
                new_text=None,
                note=f"Commented out shell command: {cmd[:60]}",
            )
        )
    modified = commented

    return modified, edits


# ---------------------------------------------------------------------------
# Full notebook preprocessing
# ---------------------------------------------------------------------------


def preprocess_notebook(
    notebook: dict[str, Any],
    assignment_context: str | None = None,
    ki_client: KiConnectClient | None = None,
) -> PreprocessingResult:
    """Run the full preprocessing pipeline on a notebook dict.

    Layer 1 (deterministic sanitization) **always** runs and modifies
    the notebook *in place* so the caller can persist the cleaned version.

    Layer 2 (LLM pre-processing) is optional — pass a ``ki_client`` with
    a valid API key to enable it.

    Args:
        notebook: Loaded ``.ipynb`` content (dict with ``cells`` key).
        assignment_context: Optional assignment description for the LLM.
        ki_client: Optional :class:`KiConnectClient` instance.

    Returns:
        :class:`PreprocessingResult` with normalized cells, edits, and
        optional LLM analysis.
    """
    cells = notebook.get("cells", [])
    all_edits: list[CellEdit] = []

    # -- Layer 1: Deterministic sanitization --
    for i, cell in enumerate(cells):
        if cell.get("cell_type") != "code":
            continue

        source = _get_cell_source(cell)
        sanitized, edits = sanitize_cell(source, cell_index=i)
        all_edits.extend(edits)

        if sanitized != source:
            _set_cell_source(cell, sanitized)

    # Build normalized cell list (what runners / frontend need)
    normalized_cells: list[dict[str, Any]] = []
    for i, cell in enumerate(cells):
        normalized_cells.append(
            {
                "index": i,
                "type": cell.get("cell_type", "code"),
                "source": _get_cell_source(cell),
            }
        )

    # -- Layer 2: LLM pre-processing --
    analysis: dict[str, Any] | None = None
    llm_status = "skipped"

    if ki_client is not None and ki_client.api_key:
        try:
            analysis = ki_client.analyze(
                notebook_cells=normalized_cells,
                assignment_context=assignment_context,
            )
            llm_status = "completed" if analysis is not None else "error"
        except Exception:
            logger.exception("LLM pre-processing failed")
            llm_status = "error"
    else:
        logger.debug("LLM pre-processing skipped (no KI Connect client / key)")

    return PreprocessingResult(
        normalized_cells=normalized_cells,
        edits=all_edits,
        analysis=analysis,
        llm_preprocessing=llm_status,
    )
