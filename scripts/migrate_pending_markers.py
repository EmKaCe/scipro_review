#!/usr/bin/env python3
"""One-off migration: reset fabricated cell markers to "pending".

Phase 3 `translateCell` emitted `marker: "different"` for every non-error
cell even though no reference comparison had run (markers are a Phase 4
pre-evaluation feature). This rewrites stored results so non-error cells
are "pending" — the honest state — and the UI shows the Phase 4 notice
instead of misleading "Different approach" badges.

Usage: python3 scripts/migrate_pending_markers.py [data_dir]
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

VALID_REAL = {"same", "different", "questionable"}


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
        record_changed = False
        for cell in record["cells"]:
            # Only fabricated "different" markers are rewritten. "error" is
            # real (execution status) and stays. A real Phase 4 marker never
            # exists yet — if one shows up, leave it alone.
            if cell.get("marker") == "different":
                cell["marker"] = "pending"
                patched += 1
                record_changed = True
        if record_changed:
            changed_records += 1

    results_path.write_text(json.dumps(results, indent=2), encoding="utf-8")
    print(f"reset {patched} markers to 'pending' across {changed_records} records in {results_path.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
