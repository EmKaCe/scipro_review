#!/usr/bin/env python3
"""One-off migration: strip legacy "# auto-fix:" engine comments from results.

The pre-4b autofix engine wrote a bookkeeping comment of the form

    # auto-fix: <fix_name> repaired — changed: <details>

into stored cell sources in results.json. That engine's code is already
gone — only the data artifact remains. This script removes exactly those
lines, and nothing else, from every stored execution result under
DATA_DIR/submissions/<assignment>/results.json.

The FULL old-engine marker is required (the em-dash — is U+2014, not a
hyphen), so genuine student comments like "# auto-fix: my own note" are
never touched. Original .ipynb files are never modified.

Usage:
    python3 scripts/strip_legacy_autofix_comments.py            # dry-run (default)
    python3 scripts/strip_legacy_autofix_comments.py --apply    # rewrite files
    DATA_DIR=/path python3 scripts/strip_legacy_autofix_comments.py --apply
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import re
import sys
import tempfile
from pathlib import Path

logger = logging.getLogger("strip_legacy_autofix_comments")

# Full old-engine marker: "# auto-fix: <name> repaired — changed: <details>".
# The em-dash is U+2014 — a hyphen-only comment fails this pattern, so a
# loose "^# auto-fix:" match would never be used (that would strip
# legitimate student comments).
LEGACY_MARKER = re.compile(r"^# auto-fix:\s+\w+\s+repaired\s+—\s+changed:")


def _strip_legacy_comments(source: str | list[str]) -> tuple[str | list[str] | None, int]:
    """Drop legacy marker lines, preserving the source's type and line order.

    Returns ``(rewritten, n_stripped)`` — or ``(None, 0)`` when nothing
    matched so the caller can skip the file entirely.
    """
    if isinstance(source, str):
        lines = source.split("\n")
        keep = [ln for ln in lines if not LEGACY_MARKER.match(ln)]
        if len(keep) == len(lines):
            return None, 0
        return "\n".join(keep), len(lines) - len(keep)
    if isinstance(source, list):
        keep = [ln for ln in source if not LEGACY_MARKER.match(ln)]
        if len(keep) == len(source):
            return None, 0
        return keep, len(source) - len(keep)
    return None, 0


def _atomic_write(path: Path, results) -> None:
    """Write JSON via tmp file + rename, matching the repo's file style."""
    fd, tmp_name = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(results, f, indent=2)
        os.replace(tmp_name, path)
    except BaseException:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


def _process_file(assignment: str, results_path: Path, apply: bool) -> tuple[int, int]:
    """Scan one results.json; report and (optionally) rewrite affected cells."""
    results = json.loads(results_path.read_text(encoding="utf-8"))
    changed = False
    cells_affected = 0
    lines_stripped = 0
    for record in results.values():
        if not isinstance(record, dict):
            continue
        cells = record.get("cells")
        if not isinstance(cells, list):
            continue
        for position, cell in enumerate(cells):
            if not isinstance(cell, dict):
                continue
            source = cell.get("source")
            if not isinstance(source, (str, list)):
                continue
            rewritten, n = _strip_legacy_comments(source)
            if n == 0:
                continue
            changed = True
            cells_affected += 1
            lines_stripped += n
            index = cell.get("index") if isinstance(cell.get("index"), int) else position
            logger.info(
                "%s: %s: cell %s (0-based, source: %s): %d legacy auto-fix comment(s)",
                assignment,
                results_path,
                index,
                "list" if isinstance(source, list) else "string",
                n,
            )
            if apply:
                cell["source"] = rewritten
    if changed:
        if apply:
            _atomic_write(results_path, results)
            logger.info(
                "%s: %s: rewrote (%d cell(s), %d line(s) stripped)",
                assignment,
                results_path.name,
                cells_affected,
                lines_stripped,
            )
        else:
            logger.info(
                "%s: %s: %d cell(s) would change (%d line(s)) — dry run, nothing written",
                assignment,
                results_path.name,
                cells_affected,
                lines_stripped,
            )
    else:
        logger.info("%s: %s: clean, no legacy auto-fix comments", assignment, results_path.name)
    return cells_affected, lines_stripped


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Strip legacy '# auto-fix: … repaired — changed:' comments "
        "from stored execution results (dry-run by default)."
    )
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--apply",
        action="store_true",
        help="rewrite affected results.json files (default is a dry run)",
    )
    mode.add_argument(
        "--dry-run",
        action="store_true",
        help="report affected cells without writing (this is the default)",
    )
    parser.add_argument(
        "--data-dir",
        default=None,
        help="data directory (default: $DATA_DIR or ./data)",
    )
    args = parser.parse_args()

    # Report on stdout (like the repo's other migration scripts, which
    # print() their reports) so the affected-cell report is the command's
    # visible output, not an error stream.
    logging.basicConfig(
        level=logging.INFO, format="%(levelname)s %(message)s", stream=sys.stdout
    )

    data_dir = Path(args.data_dir or os.environ.get("DATA_DIR", "./data"))
    submissions = data_dir / "submissions"
    if not submissions.is_dir():
        logger.error("no submissions directory: %s", submissions)
        return 1

    files = sorted(
        (d.name, d / "results.json")
        for d in submissions.iterdir()
        if d.is_dir() and (d / "results.json").is_file()
    )
    if not files:
        logger.warning("no results.json files found under %s", submissions)
        return 0

    total_cells = 0
    total_lines = 0
    for assignment, results_path in files:
        cells, lines = _process_file(assignment, results_path, apply=args.apply)
        total_cells += cells
        total_lines += lines

    mode = "applied" if args.apply else "would change (dry run)"
    logger.info(
        "total: %d cell(s) across %d file(s) %s (%d line(s))",
        total_cells,
        len(files),
        mode,
        total_lines,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
