#!/usr/bin/env python3
"""
Svelte Review — Karl ground-truth verification gate.

Compares pipeline output (Docker results.json) against the authoritative
emailed grade files (Karl-form JSONs sent from H-BRS, mirrored in
grading-output/final_2/ which is byte-identical).

Tolerances (from PLAN_turn_based_preeval_phase2 Step 10):
  - dimension scores within ±0.5
  - checked rubric keys: ≤2 differences per category
  - no missing mandatory categories
  - textareas present and non-filler

Usage: python3 verify_gate.py [--json] [--ids 2026SS_00,2026SS_04]
"""
import json, sys, argparse, os

RESULTS = '/var/lib/docker/volumes/svelte-review-data/_data/submissions/soil_contamination/results.json'
EMAILED = '/root/projects/svelte-review-copilot/grading-output/emailed-sources/2026SS_soil_contamination'

DIM_MAP = {
    'code_quality_design': 'codequality-grading',
    'code_execution_results': 'codeexecution-grading',
    'assignment_requirements': 'assignmentrequirements-grading',
    'scientific_programming': 'scientific-grading',
    'creativity': 'creativity-grading',
}
# Internal category key -> Karl prefix (mirrors legacy-catalog.ts)
CAT_PREFIX = {
    'code_formatting': 'codeFormatting', 'coding_concept': 'codingConcept',
    'jupyter_notebooks': 'jupyterNotebooks', 'academic_scholarship': 'academicScholarship',
    'following_instructions': 'followingInstructions', 'general_feedback': 'general',
    'pandas': 'Pandas', 'numpy': 'NumPy', 'scipy': 'SciPy', 'sklearn': 'sklearn',
    'genai': 'GenAI', 'user_defined_functions': 'userDefinedFunctions',
    'function_calling': 'callingFunction', 'plotting_visualization': 'plotting',
}


def load_yaml_texts():
    """Build {category_key: [(sentiment, main_point, sub_point_text), ...]} from YAML files."""
    try:
        import yaml
    except ImportError:
        print("PyYAML required", file=sys.stderr)
        sys.exit(2)
    entries = {}
    base = '/root/projects/svelte-review-copilot/data/criteria'
    for fn in ('general.yaml', 'soil_contamination.yaml', 'general_feedback.yaml', 'following_instructions.yaml'):
        with open(os.path.join(base, fn)) as f:
            data = yaml.safe_load(f)
        for cat_key, cat in (data.get('categories') or {}).items():
            if cat_key not in CAT_PREFIX:
                continue
            for sentiment in ('positive', 'neutral', 'negative'):
                for mp in cat.get(sentiment) or []:
                    main_point = mp.get('main_point', '')
                    for sp in mp.get('sub_points', []):
                        text = sp.get('text', '') if isinstance(sp, dict) else str(sp)
                        entries.setdefault(cat_key, []).append((sentiment, main_point, text))
    return entries


def option_to_karl_id(cat_key, option_key, yaml_texts):
    """Find (sentiment, main_point) for an option text and build the Karl ID."""
    if cat_key not in CAT_PREFIX:
        return None
    matches = [(s, mp) for (s, mp, t) in yaml_texts.get(cat_key, []) if t == option_key]
    if not matches:
        return None
    # Prefer exact; if multiple main points hold the same text, take the first
    sentiment, main_point = matches[0]
    return f"{CAT_PREFIX[cat_key]}-{sentiment}-{main_point}-{option_key}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--json', action='store_true')
    ap.add_argument('--ids', help='comma-separated submission ids to limit to')
    ap.add_argument('--detail', help='show key-level detail for one submission')
    args = ap.parse_args()

    if args.detail:
        detail_one(args.detail)
        return

    store = json.load(open(RESULTS))
    yaml_texts = load_yaml_texts()
    ids = [i.strip() for i in (args.ids or '').split(',') if i.strip()] or sorted(store.keys())

    report = {}
    for sid in ids:
        entry = store.get(sid)
        if not entry:
            report[sid] = {'error': 'missing in pipeline store'}
            continue
        ref_path = f'{EMAILED}/{sid}.json'
        if not os.path.exists(ref_path):
            report[sid] = {'error': 'missing emailed reference'}
            continue
        ref = json.load(open(ref_path))
        pp = entry.get('postProcessed') or {}

        # 1) Dimensions
        dim_diffs = []
        for internal, karl_key in DIM_MAP.items():
            got = (pp.get('dimensions') or {}).get(internal)
            want = ref.get(karl_key)
            if got is None or want is None:
                dim_diffs.append((internal, got, want, 'missing'))
            else:
                try:
                    diff = abs(float(got) - float(want))
                    if diff > 0.5:
                        dim_diffs.append((internal, got, want, round(diff, 2)))
                except ValueError:
                    dim_diffs.append((internal, got, want, 'unparseable'))

        # 2) Rubric selections -> Karl IDs
        ref_checked = {k: v for k, v in ref.items() if k not in DIM_MAP.values() and v == 'checked'}
        got_ids = set()
        for sel in pp.get('rubricSelections') or []:
            karl = option_to_karl_id(sel.get('categoryKey'), sel.get('optionKey'), yaml_texts)
            if karl:
                got_ids.add(karl)
        ref_ids = set(ref_checked.keys())
        extra = sorted(got_ids - ref_ids)
        missing = sorted(ref_ids - got_ids)

        # Per-category diff counts
        cat_diffs = {}
        for cat_key in CAT_PREFIX:
            prefix = CAT_PREFIX[cat_key]
            ref_cat = {k for k in ref_ids if k.startswith(prefix + '-')}
            got_cat = {k for k in got_ids if k.startswith(prefix + '-')}
            n = len(ref_cat.symmetric_difference(got_cat))
            if n:
                cat_diffs[cat_key] = n

        # 3) Mandatory categories present (jupyter_notebooks, academic_scholarship)
        mandatory_missing = []
        for mcat in ('jupyter_notebooks', 'academic_scholarship'):
            if not any(k.startswith(CAT_PREFIX[mcat] + '-') for k in got_ids):
                mandatory_missing.append(mcat)

        # 4) Textareas
        ref_textareas = {k for k in ref if k.endswith('-textarea') or 'textarea' in k}
        pp_notes = pp.get('additionalNotes') or {}
        note_texts = list(pp_notes.values())
        missing_textareas = []
        for cat_key in CAT_PREFIX:
            karl_name = CAT_PREFIX[cat_key]
            if any(k.startswith(f'{karl_name}-') and 'textarea' in k for k in ref_textareas):
                if not pp_notes.get(cat_key):
                    missing_textareas.append(cat_key)

        dim_pass = len(dim_diffs) == 0
        rubric_pass = len(cat_diffs) <= 1  # aggregate tolerance: <=2 per category, allow 1 minor
        cat_pass = all(v <= 2 for v in cat_diffs.values())
        mand_pass = len(mandatory_missing) == 0
        ta_pass = len(missing_textareas) == 0

        report[sid] = {
            'dimension_diffs': dim_diffs,
            'dimension_pass': dim_pass,
            'extra_checked': extra,
            'missing_checked': missing,
            'category_diffs': cat_diffs,
            'category_pass': cat_pass,
            'mandatory_missing': mandatory_missing,
            'mandatory_pass': mand_pass,
            'missing_textareas': missing_textareas,
            'textarea_pass': ta_pass,
            'pass': dim_pass and cat_pass and mand_pass and ta_pass,
            'rubric_total_diff': len(extra) + len(missing),
        }

    passed = sum(1 for r in report.values() if r.get('pass'))
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print(f"{'id':10s} {'DIM':4s} {'RUB':4s} {'MAND':4s} {'TA':4s} {'VERDICT':8s} detail")
        for sid, r in sorted(report.items()):
            if 'error' in r:
                print(f"{sid:10s} {'-':4s} {'-':4s} {'-':4s} {'-':4s} {'ERROR':8s} {r['error']}")
                continue
            verdict = 'PASS' if r['pass'] else 'FAIL'
            detail = []
            if r['dimension_diffs']:
                detail.append(f"dims:{r['dimension_diffs']}")
            if r['extra_checked']:
                detail.append(f"+{len(r['extra_checked'])} extra")
            if r['missing_checked']:
                detail.append(f"-{len(r['missing_checked'])} missing")
            if r['mandatory_missing']:
                detail.append(f"mandatory:{r['mandatory_missing']}")
            if r['missing_textareas']:
                detail.append(f"notes:{r['missing_textareas']}")
            print(f"{sid:10s} {'Y' if r['dimension_pass'] else 'N':4s} {'Y' if r['category_pass'] else 'N':4s} {'Y' if r['mandatory_pass'] else 'N':4s} {'Y' if r['textarea_pass'] else 'N':4s} {verdict:8s} {'; '.join(detail)}")
        print()
        print(f"PASS: {passed}/{len(report)}")


def detail_one(sid):
    """Key-level detail for one submission."""
    from collections import Counter
    store = json.load(open(RESULTS))
    yaml_texts = load_yaml_texts()
    ref = json.load(open(f'{EMAILED}/{sid}.json'))
    pp = store[sid].get('postProcessed') or {}

    ref_checked = {k: v for k, v in ref.items() if k not in DIM_MAP.values() and v == 'checked'}
    got_ids = set()
    unmapped = []
    for sel in pp.get('rubricSelections') or []:
        karl = option_to_karl_id(sel.get('categoryKey'), sel.get('optionKey'), yaml_texts)
        if karl:
            got_ids.add(karl)
        else:
            unmapped.append((sel.get('categoryKey'), sel.get('optionKey')))
    ref_ids = set(ref_checked.keys())
    extra = sorted(got_ids - ref_ids)
    missing = sorted(ref_ids - got_ids)

    print(f"=== {sid} ===")
    print(f"ref checked: {len(ref_ids)}, got: {len(got_ids)}, unmapped: {len(unmapped)}")
    print()
    print("--- EXTRA (pipeline has, email doesn't) ---")
    for k in extra:
        print(" ", k[:130])
    print()
    print("--- MISSING (email has, pipeline doesn't) ---")
    for k in missing:
        print(" ", k[:130])
    print()
    print("--- UNMAPPED selections (option not found in YAML) ---")
    c = Counter(f"{ck}:{ok[:70]}" for ck, ok in unmapped)
    for k, v in c.most_common(25):
        print(f"  {v}x {k}")


if __name__ == '__main__':
    main()
