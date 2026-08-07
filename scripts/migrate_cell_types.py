#!/usr/bin/env python3
"""One-off migration: restore cell `type` in stored execution results.

The executor response model previously dropped `cell_type`, so every stored
cell in results.json was translated as "code". This patches each stored
result's cells from the original submission notebook (index-aligned),
restoring markdown/code rendering without re-executing anything.

Usage: python3 migrate_cell_types.py [data_dir]
"""
from __future__ import annotations

import json
import sys
from pathlib import Path


def main() -> int:
    data_dir = Path(sys.argv[1] if len(sys.argv) > 1 else "data")
    results_path = data_dir / "submissions" / "soil_contamination" / "results.json"
    if not results_path.exists():
        print(f"no results file: {results_path}")
        return 1

    results = json.loads(results_path.read_text(encoding="utf-8"))
    patched = 0
    changed_records = 0
    for student_id, record in results.items():
        if not isinstance(record, dict) or not isinstance(record.get("cells"), list):
            continue
        nb_path = data_dir / "submissions" / "soil_contamination" / f"{student_id}.ipynb"
        if not nb_path.exists():
            continue
        nb = json.loads(nb_path.read_text(encoding="utf-8"))
        types = {i: c.get("cell_type", "code") for i, c in enumerate(nb.get("cells", []))}
        for cell in record["cells"]:
            idx = cell.get("index")
            if idx is not None and idx in types and cell.get("type") != types[idx]:
                cell["type"] = types[idx]
                patched += 1
        if patched:
            changed_records += 1

    results_path.write_text(json.dumps(results, indent=2), encoding="utf-8")
    print(f"patched {patched} cells across {changed_records} records in {results_path.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
