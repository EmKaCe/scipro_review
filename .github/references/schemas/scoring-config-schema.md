# Scoring Config Schema

> **Status**: v1 — added 2026-08-18 (design signed off; see
> `.hermes/plans/2026-08-18-scoring-config-schema.md` for the full design
> rationale, coverage table, and atom_interaction proof).
>
> Makes the scoring semantics that were hardcoded in `cohort-calibration.ts`
> and `pre-evaluation.ts` data-driven per assignment: calibration anchors,
> evidence regexes, disallowed libraries, and Phase 2a prompt-anchor text.
> Without a scoring file an assignment gets **generic fallbacks** — notably
> calibration is skipped, which fixes the atom_interaction bug where it
> silently inherited soil_contamination's anchors.

## File

`data/scoring/<assignment_id>.yaml`, referenced from `data/assignments.yaml`
via the optional `scoring_file` key:

```yaml
assignments:
  - id: soil_contamination
    enabled: true
    scoring_file: data/scoring/soil_contamination.yaml   # NEW, optional
    criteria_files: [...]
    dimensions: [...]
```

## Structure

```yaml
scoring:
  reference_anchors:        # OPTIONAL — all-or-nothing map; absent → calibration skipped
    A: <number>             # reference slope
    B: <number>             # reference intercept
    x0: <number>
    y0: <number>
    L: <number>
    r_squared: <number>     # in [0,1]
    rmse: <number>          # > 0
  evidence_patterns:        # OPTIONAL map of pattern name → pattern spec
    <name>:
      pattern: <string | string[]>   # regex source; list = AND group (test_all)
      semantics: <test | test_all | capture_value | distinct_count>
      haystack: <output | code | markdown | output+code | markdown+code>
      capture_group: <int 1..9>      # REQUIRED for capture_value / distinct_count
  disallowed_libraries:     # OPTIONAL string[] — absent → [] (nothing disallowed)
    - <library>
  prompt_anchor_text:       # OPTIONAL
    dimension_guidance:     # per-dimension Phase 2a suffix text; {A} {B} {L} … substituted from anchors
      scientific_programming: <string>
      creativity: <string>
```

## Field Definitions

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `scoring.reference_anchors` | map | ⭕ | Reference-fit facts used ONLY to identify the reference-fit cluster during cohort calibration — never score targets. **All-or-nothing** (partial anchors are a hard error). Absent → `runCohortCalibration` skips (0 adjustments). |
| `scoring.evidence_patterns` | map | ⭕ | Compiled at load time with `new RegExp(pattern, 'i')` — invalid regex throws with the pattern key. `test` → boolean bullet; `test_all` → list of patterns, ALL must match; `capture_value` → first capture group value; `distinct_count` → distinct values of the capture group (matchAll). |
| `scoring.disallowed_libraries` | string[] | ⭕ | Imports flagged by pre-analysis. Absent → `[]` (no assignment-specific disallowed libraries). |
| `scoring.prompt_anchor_text.dimension_guidance` | map | ⭕ | Per-dimension suffix text for the Phase 2a PER-DIMENSION GUIDE. `{A} {B} {L} {x0} {y0} {r_squared} {rmse}` placeholders substitute from `reference_anchors` so each reference value exists in exactly one place. Unlisted dimensions fall back to `DEFAULT_DIMENSION_GUIDANCE` (code constant). |

## Contract Rules (enforced by `frontend/src/lib/server/copilot/scoring-config.ts`)

1. **Compile gate (hard fail):** every pattern compiles; unknown `semantics` /
   `haystack` values throw; `capture_group` required and bounded for capture
   semantics; `r_squared ∈ [0,1]`, `rmse > 0`, all numbers finite.
2. **Byte-equality contract:** the Phase 2a prompt assembled for
   soil_contamination must stay byte-identical to the pre-config hardcoded
   prompt (golden test: `frontend/src/tests/copilot/scoring-config.test.ts`,
   fixture `phase2a-prompt-golden.txt`). Trailing whitespace or a bad
   `{A}` substitution changes the model's input → score drift.
3. **No-soil-leakage fallback:** an assignment WITHOUT a scoring file must
   never inherit another assignment's anchors. `runCohortCalibration` skips
   loudly (log line) when no anchors resolve.
4. **Evidence equivalence:** config patterns must be equivalent to the
   builtin regexes on the stored outputs (tested against the 19 stored
   results; skips gracefully on fresh clones where the gitignored mirror is
   absent).

## Consumers

| Consumer | Reads |
|----------|-------|
| `pre-evaluation.ts` (`preEvaluateSubmission`) | `disallowed_libraries` (pre-analysis), `evidence_patterns` + `reference_anchors` (via `buildExtraAnalysisEvidence`), `dimension_guidance` (Phase 2a prompt) |
| `pre-evaluation.ts` (`runCohortCalibration`) | `reference_anchors` (cluster band); skips when absent |
| `cohort-calibration.ts` (`extractFitMetricsFromResults`) | `fit_metrics_*` / `bounds_assignment` patterns (single source for R²/RMSE parsing; code constants as fallback) |
| `pipeline/context.ts` (`buildExtraAnalysisEvidence`) | `evidence_patterns` + anchors for the evidence bullet |

## Relationship

```
assignments.yaml ──► scoring_file ──► scoring/*.yaml (this schema)
                 ──► criteria_files ──► criteria/*.yaml (Criteria Schema)
```
