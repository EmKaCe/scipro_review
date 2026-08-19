# Pre-Evaluation Quality Statement & the Karl Gate

What the copilot's pre-evaluation actually does, what it does not do, and how to
tell the difference. This document is the honest baseline: measured facts only,
no aspirations. Numbers below were measured on **2026-08-17/18** against the
soil_contamination assignment's ground truth and are a **point-in-time
snapshot** — deliberately **not** re-measured here.

## Purpose & audience

- **Karl** — the teacher whose emailed grades are the authoritative ground
  truth (zip emailed 2026-08-11, H-BRS Sent 238). This is what your tool
  currently gets right, where it still needs you, and how the gate that
  measures it works.
- **Successor teachers** — what to expect when pre-evaluating new assignments,
  and what "good" means in measurable terms instead of vibes.
- **Reviewers** — the residual-gap table below is the current, known error
  budget. If a change claims to improve quality, this is the baseline it must
  beat.

> The golden rule: **the ground truth is the teacher's own grades, not the
> system.** The numbers below are a snapshot of the gap between the two.

## What the copilot gets right (evidence-backed)

- **Deterministic cell comparison vs the reference key** (Phase 1): every cell
  is marked `same` / `different` / `questionable` against the reference key
  materials — no LLM involved, fully reproducible.
- **Dimension scores + justification via the turn-based Phase 2a pipeline**:
  one rubric category per LLM call, output is the **EDITED markdown worksheet**
  (not JSON), validation-failure retry loop capped at **max 3**, no `N/A`
  escape hatch.
- **7 deterministic post-processing passes**
  (`frontend/src/lib/server/copilot/post-process.ts`) that fix
  evidence-grounded rubric selections, sync textareas/checkboxes, fill short
  notes, and strip plagiarism/filler. Every correction is a **visible fix
  record** (`PostProcessFix[]`) — nothing is silently rewritten.
- **Docs grounding is LIVE and verified (2026-08-18)**: the Phase 2a prompt
  carries a `{DOCS_FACTS}` block citing real docs URLs. Smoke-tested on
  2026SS_00 + 2026SS_04 — **6 URLs cited** from pandas.pydata.org,
  docs.scipy.org, scikit-learn.org. The offline index covers **12,054 chunks ×
  4096 dims** for numpy/pandas/scipy/sklearn (matplotlib is BM25-only).
- **Detector calibration**: the false "disallowed sklearn" flag was removed
  (2026-08-17) — sklearn (KMeans) is the assignment's **core library**. After
  the fix, on a small-batch re-run: `code_quality_design` 2→4,
  `scientific_programming` 2→4/5, confidence `needs_review`→`review_optional`.
- **Per-assignment calibration workflow**: scoring configs are per-assignment
  (anchors, evidence patterns, disallowed/allowed libraries, dimension
  guidance). `soil_contamination`'s config carries its own explicit values; new
  assignments get generic fallbacks that **NEVER inherit soil's anchors** (no
  scoring file = no anchors, calibration skipped loudly).

## What needs teacher review (measured residuals)

The gate passes only when the pipeline lands within ±0.5 of the teacher's sent
grade on every dimension **and** the rubric selections match. Current measured
residuals:

| Residual | Measured value | Notes |
|---|---|---|
| Karl gate, full batch | **0/19 PASS** (baseline 2026-08-17) | dimensions under-scored 1.0–3.5 before the sklearn fix |
| Karl gate, docs grounding re-measure | **0/2 PASS** (2026-08-18, 2026SS_00 + 2026SS_04) | unchanged within the known noise floor — not improved, not regressed |
| `creativity` dimension | consistently **1.5–2.5 under** (max 4) | systematic under-scoring |
| `coding_concept` / `plotting` | **over-ticking positives** | rubric selection drift |
| `general-neutral` vs `general-positive` | drift | sentiment-class distinction unreliable |
| 3 unmapped option texts | `built-in function(s)`, `code cells - good separation of encoded ideas` (YAML: `encode ideas`), `C³` vs `C^3` | string mismatch, one per submission |
| Single-shot LLM variance | **±2–3 points** | larger than the ±0.5 gate tolerance |
| 2026SS_00 `code_execution_results` | **2 vs sent 4 (Δ2.0)** | the one dimension outside tolerance, same as baseline |

The design accepts teacher review as the residual filter: variance is larger
than the gate tolerance, so the gate **cannot** be the acceptance criterion for
individual submissions — it is the measurement instrument that tells you where
the pipeline stands.

## The Karl gate

### What it measures

`frontend/scripts/verify-karl-gate.py` compares the pipeline's output — read
from the Docker volume's `results.json` (no LLM) — against
`grading-output/final_2/`, which is **byte-identical** to the zip emailed to
Karl (2026-08-11). Two tiers:

| Tier | Check | Tolerance |
|---|---|---|
| **Dimensions (hard)** | each of the 5 dimensions vs the teacher's sent grade | ±0.5 |
| **Rubric (soft)** | checked rubric keys per category, mandatory categories present, textareas present and non-filler | ≤ 2 key differences per category |

A submission passes **only when both tiers pass**.

### How to run it

```bash
cd frontend
python3 scripts/verify-karl-gate.py            # full batch table + PASS count
python3 scripts/verify-karl-gate.py --ids 2026SS_00,2026SS_04   # subset
python3 scripts/verify-karl-gate.py --detail 2026SS_00          # key-level diff
```

### Current numbers (measured 2026-08-17/18)

- Baseline (2026-08-17): **0/19 PASS**.
- Docs grounding active (2026-08-18), 2026SS_00 + 2026SS_04: **0/2 PASS** —
  unchanged within the known noise floor.
- Representative failure: 2026SS_00 `code_execution_results` **2 vs 4
  (Δ2.0)** — the one dimension outside tolerance, same as baseline.

## The noise floor — why 0/N is a property, not a bug

0/19 (and 0/2) is a **documented property** of the current design, not a
defect: the pipeline is a single-shot LLM with ±2–3 point variance against a
±0.5 gate tolerance, and the teacher is the residual filter by design. The
gate is a **measurement instrument**, not an acceptance criterion: it exists
to show where the pipeline stands after each change, and it stays at 0 until
variance shrinks to gate tolerance or the gate's tolerance is revisited.

The teacher (Karl) is the residual filter — and the calibration loop in the
[Calibration guide](assignment-calibration.md) is the path to shrinking the
residuals above.

## The confidence flags (deterministic, not an LLM judgement)

`derivedGradingConfidence` in `frontend/src/lib/server/copilot/pre-evaluation.ts`
computes each flag from **deterministic thresholds only**, **after
post-processing**, and persists it on the envelope as
`preEval.gradingConfidence` (surfaced on the dashboard list):

| Flag | Threshold |
|---|---|
| `needs_review` | any `[needs review]` retry-loop flag, **or** ≥ 5 post-process fixes, **or** any execution error, **or** any disallowed import |
| `high_confidence` | zero fixes, no retry flags, clean execution, no naming/ordering/dead-code findings |
| `review_optional` | everything in between |

These are **not** an LLM judgement; they are a deterministic summary of the
pipeline's own audit trail. They tell the teacher which rows to look at first,
not what the grade should be.

## How to re-measure

1. Run the real pipeline on 2–3 submissions with the small-batch live runner
   (temp vitest spec under `frontend/src/tests/copilot/`, `DATA_DIR` = the
   Docker volume; delete the file after). Recipe: the project skill's
   `references/small-batch-live-runner.md`.
2. Run the gate: `cd frontend && python3 scripts/verify-karl-gate.py --ids <ids>`.
3. Compare against the numbers above — same values = unchanged; any delta is
   the measured effect of the change.
4. Tune the per-assignment scoring config (anchors, evidence patterns,
   dimension guidance) and repeat — the full calibration loop is documented in
   the [Calibration guide](assignment-calibration.md).

> **Volume staleness pitfall:** the Docker volume holds its own copies of
> `assignments.yaml`, `grading_config.yaml`, and `criteria/*.yaml` and can lag
> the repo. Diff volume vs repo and sync before any measurement run; back up
> the volume config first (`cp -r /var/lib/docker/volumes/svelte-review-data/_data`).

## Rubric-fidelity regression harness (P12, recorded transcripts)

Rubric-fidelity regression harness: `cd frontend && pnpm exec tsx scripts/run-transcript-evals.mjs --dry-run`
lists the grading proposals extracted from the recorded copilot transcripts
(no LLM; this is what CI/docs run) or, without `--dry-run`, replays them
through the live rubric-fidelity judge on the copilot's own KI Connect model
(concurrency 2, the empirical rate-limit ceiling; requires `KI_CONNECT_API_KEY`;
use `--model <id>` when `data/settings.yaml` lags the deployment — the live
baseline below was measured with `--model openai-gpt-oss-120b`).
Proposals are grouped per assistant turn from the grading WRITE tools
(`set-rubric-item` → rubric, `update-grade-dimension` → dimensions,
`write-notes`/`draft-notes` → feedback) recorded under
`DATA_DIR/copilot/memory/{threads,messages}/`; threads without grading writes
(e.g. the `e2e-smoke` context-only thread) are skipped. Nothing is written —
the harness only reads the store and prints a table + JSON report.

Baseline (2026-08-19, dry-run extraction): **2 proposals from 2 recorded
threads** — `9f4ccf99-b1eb-4a2e-a45a-9e49c2a53812` (turn 2: rubric
`assignment_requirements`/`code_execution_results` = `complete`, dimensions
`code_quality_design` 600 / `scientific_programming` 600, feedback present) and
`46f266bd-56bf-4418-9e54-21dd257e390b` (turn 2: dimension
`code_quality_design` 500 + feedback), both assignment `soil_contamination`.
Live fidelity baseline (2026-08-19, `openai-gpt-oss-120b`, concurrency 2):
**mean 0.00 / 2 proposals** (reproduced on a controller re-run the same night;
one of three runs scored 0.5 — single-shot judge variance is the dominant
signal at n=2). The recorded sessions' `update-grade-dimension` writes carry
slider-scale values (600/500 on the tool's [0,1000] bound) far above the
rubric's `max_points` (4–6), so the judge tends to flag both proposals as
over-scoring. Treat any single live score as noise until more recorded
grading turns exist; the harness (not the number) is the deliverable.
