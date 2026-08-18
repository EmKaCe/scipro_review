#!/usr/bin/env python3
"""
compute-cohort-norms.py — regenerate data/cohort_norms/soil_contamination.yaml
from the emailed ground-truth files.

Source of truth: grading-output/emailed-sources/2026SS_soil_contamination/*.json
(gitignored; read-only). Each file is the professor's final graded worksheet for
one submission: rubric keys like "plotting-positive-..." map to "checked", plus
dimension keys ("codequality-grading" etc.) and the "evaluation-textbox" note.

The committed YAML is what the app reads at runtime — this script only
regenerates it when the emailed sources change. It carries:

  - global checked-count stats (min/max/mean/median/distribution)
  - per-category medians + max (Signal B thresholds: median + 3)
  - the "typical review" set: sub-point texts checked in >= 50% of the
    cohort (Signal C overlap comparison)

Usage:
    python3 scripts/compute-cohort-norms.py [--check]
  --check: verify the committed YAML matches a fresh computation; exit 1 on drift.
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import statistics
import sys
from collections import Counter, defaultdict

# Keys that are not rubric sub-points (dimension scores, free-text notes).
NON_RUBRIC_SUFFIXES = ("-grading",)
NON_RUBRIC_PREFIXES = ("evaluation",)

# Emailed-file category names (camelCase) -> criteria YAML category keys
# (snake_case). The pipeline's rubricSelections use the YAML keys; the
# norms YAML is keyed by the professor's form names.
EMailed_TO_YAML = {
    "codeFormatting": "code_formatting",
    "codingConcept": "coding_concept",
    "jupyterNotebooks": "jupyter_notebooks",
    "academicScholarship": "academic_scholarship",
    "followingInstructions": "following_instructions",
    "general": "general_feedback",
    "userDefinedFunctions": "user_defined_functions",
    "callingFunction": "function_calling",
    "plotting": "plotting_visualization",
    "Pandas": "pandas",
    "NumPy": "numpy",
    "SciPy": "scipy",
    "sklearn": "sklearn",
}

CRITERIA_FILES = ("general.yaml", "soil_contamination.yaml")

EMailed_DIR = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "..",
    "grading-output", "emailed-sources", "2026SS_soil_contamination",
)
CRITERIA_DIR = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "..", "data", "criteria",
)
OUT_YAML = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "..",
    "data", "cohort_norms", "soil_contamination.yaml",
)

# ---------------------------------------------------------------------------
# Criteria YAML loading (sub-point texts per category)
# ---------------------------------------------------------------------------


def load_criteria_subpoints() -> dict[str, list[str]]:
    """snake_case category key -> all sub-point texts (positive/neutral/negative)."""
    import yaml  # local import: script may run without the frontend venv

    out: dict[str, list[str]] = {}
    for name in CRITERIA_FILES:
        path = os.path.join(CRITERIA_DIR, name)
        if not os.path.exists(path):
            continue
        with open(path, encoding="utf-8") as fh:
            doc = yaml.safe_load(fh)
        for cat_key, cat in (doc or {}).get("categories", {}).items():
            texts = out.setdefault(cat_key, [])
            for sentiment in ("positive", "neutral", "negative"):
                for mp in cat.get(sentiment, []) or []:
                    for sp in mp.get("sub_points", []) or []:
                        texts.append(sp["text"])
    return out


# ---------------------------------------------------------------------------
# Emailed ground-truth parsing
# ---------------------------------------------------------------------------


def is_rubric_key(key: str) -> bool:
    """True for rubric sub-point keys (e.g. 'plotting-positive-...')."""
    if key.endswith(NON_RUBRIC_SUFFIXES):
        return False
    if key.startswith(NON_RUBRIC_PREFIXES):
        return False
    return "-" in key


def category_of(key: str) -> str:
    return key.split("-", 1)[0]


def load_submissions() -> dict[str, Counter[str]]:
    """sid -> {category -> checked count}, from the emailed ground-truth files."""
    files = sorted(glob.glob(os.path.join(EMailed_DIR, "*.json")))
    if not files:
        raise SystemExit(
            f"no emailed ground-truth files found under {EMailed_DIR} "
            "(gitignored — run on the machine that holds them)"
        )
    out: dict[str, Counter[str]] = {}
    for path in files:
        sid = os.path.basename(path)[: -len(".json")]
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
        counts: Counter[str] = Counter()
        for key, value in data.items():
            if is_rubric_key(key) and value == "checked":
                counts[category_of(key)] += 1
        out[sid] = counts
    return out


def resolve_subpoint_text(key: str, subpoints: dict[str, list[str]]) -> str | None:
    """
    Recover the sub-point text from an emailed key like
    'codeFormatting-positive-Formatting is done well, which includes-f-string - properly used'.

    The key is `category-sentiment-mainpoint-subpoint`; the sub-point text is
    the longest YAML sub-point text the key ends with (sub-points may contain
    '-' themselves, so a plain split is ambiguous).
    """
    cat = category_of(key)
    yaml_key = EMailed_TO_YAML.get(cat)
    if yaml_key is None:
        return None
    candidates = subpoints.get(yaml_key, [])
    best: str | None = None
    for text in candidates:
        if key.endswith(text) and (best is None or len(text) > len(best)):
            best = text
    return best


# ---------------------------------------------------------------------------
# Norm computation
# ---------------------------------------------------------------------------


def compute_norms() -> dict:
    subs = load_submissions()
    subpoints = load_criteria_subpoints()
    totals = [sum(c.values()) for c in subs.values()]
    categories: set[str] = set()
    for c in subs.values():
        categories.update(c.keys())
    per_category = {
        cat: sorted(c.get(cat, 0) for c in subs.values()) for cat in categories
    }

    # Typical review set: sub-point texts checked in >= 50% of the cohort,
    # grouped by the emailed (camelCase) category name.
    item_counts: Counter[tuple[str, str]] = Counter()
    for path in sorted(glob.glob(os.path.join(EMailed_DIR, "*.json"))):
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
        for key, value in data.items():
            if not (is_rubric_key(key) and value == "checked"):
                continue
            text = resolve_subpoint_text(key, subpoints)
            if text is not None:
                item_counts[(category_of(key), text)] += 1
    threshold = len(subs) / 2
    typical: dict[str, list[str]] = defaultdict(list)
    for (cat, text), count in sorted(item_counts.items()):
        if count >= threshold:
            typical[cat].append(text)

    return {
        "assignment": "soil_contamination",
        "source": "grading-output/emailed-sources/2026SS_soil_contamination/*.json",
        "submissions": len(subs),
        "global": {
            "min": min(totals),
            "max": max(totals),
            "mean": round(statistics.mean(totals), 1),
            "median": int(statistics.median(totals)),
            "distribution": sorted(totals),
        },
        "categories": {
            cat: {
                "median": int(statistics.median(vals)),
                "max": max(vals),
            }
            for cat, vals in sorted(per_category.items())
        },
        "typical_checked": {cat: texts for cat, texts in sorted(typical.items())},
    }


def render_yaml(norms: dict) -> str:
    lines = [
        "# Cohort norms for soil_contamination — per-category medians of the",
        "# professor's checked-item counts across the 19 emailed ground-truth",
        "# files (grading-output/emailed-sources/2026SS_soil_contamination/).",
        "#",
        "# Regenerate with: python3 frontend/scripts/compute-cohort-norms.py",
        "# Thresholds (signed off 2026-08-18):",
        "#   Signal A: total > max(median*1.5, median+10)",
        "#   Signal B: category count > category_median + 3",
        "#   Signal C: total within +-10 of median AND overlap < 60%",
        "# typical_checked: sub-point texts checked in >= 50% of the cohort",
        "# (the 'typical review' Signal C compares the pipeline selection against).",
        f"assignment: {norms['assignment']}",
        f"source: {norms['source']}",
        f"submissions: {norms['submissions']}",
        "global:",
        f"  min: {norms['global']['min']}",
        f"  max: {norms['global']['max']}",
        f"  mean: {norms['global']['mean']}",
        f"  median: {norms['global']['median']}",
        "  distribution: [" + ", ".join(map(str, norms["global"]["distribution"])) + "]",
        "categories:",
    ]
    for cat, stats in norms["categories"].items():
        lines.append(f"  {cat}:")
        lines.append(f"    median: {stats['median']}")
        lines.append(f"    max: {stats['max']}")
    lines.append("typical_checked:")
    for cat, texts in norms["typical_checked"].items():
        lines.append(f"  {cat}:")
        for text in texts:
            lines.append(f"    - {json.dumps(text, ensure_ascii=False)}")
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check", action="store_true",
        help="verify the committed YAML matches a fresh computation; exit 1 on drift",
    )
    args = parser.parse_args()

    norms = compute_norms()
    rendered = render_yaml(norms)

    if args.check:
        if not os.path.exists(OUT_YAML):
            print(f"missing committed norm: {OUT_YAML}", file=sys.stderr)
            return 1
        with open(OUT_YAML, encoding="utf-8") as fh:
            committed = fh.read()
        if committed == rendered:
            print("cohort norms up to date")
            return 0
        print("cohort norms DRIFTED — re-run compute-cohort-norms.py", file=sys.stderr)
        return 1

    os.makedirs(os.path.dirname(OUT_YAML), exist_ok=True)
    with open(OUT_YAML, "w", encoding="utf-8") as fh:
        fh.write(rendered)
    print(f"wrote {OUT_YAML}")
    print(f"  submissions: {norms['submissions']}")
    print(
        "  global: min={min} max={max} mean={mean} median={median}".format(
            **norms["global"]
        )
    )
    print("  distribution:", norms["global"]["distribution"])
    for cat, stats in norms["categories"].items():
        print(f"  {cat}: median={stats['median']} max={stats['max']}")
    print("  typical_checked categories:", len(norms["typical_checked"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
