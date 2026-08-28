# Pre-Evaluation Quality Statement

What the copilot's pre-evaluation actually does, what it does not do, and how to
tell the difference. This document is the honest baseline: measured facts only,
no aspirations.

> **Privacy notice (2026-08-20):** real student grading data (submission
> notebooks, emailed grades, cohort norms, `grading-output/`) has been removed
> from this repo so it can be open-sourced. The earlier per-student quality
> numbers and the removed ground-truth gate that produced them are **gone** — they
> were anchored in real student grades. This document describes the *design and
> architecture* of the quality story, not a live measurement against real
> grades.

## Purpose & audience

- **Teachers** — what to expect when pre-evaluating an assignment, and what
  "good" means in measurable terms instead of vibes.
- **Reviewers** — where the pipeline's known error budget comes from and how to
  re-establish a quality baseline that doesn't depend on real student data.
- **Successors** — how the deterministic + calibration machinery works after
  the student-data removal.

## What the copilot gets right (design / evidence-backed)

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
- **Docs grounding (live)**: the Phase 2a prompt carries a `{DOCS_FACTS}`
  block citing real docs URLs (pandas.pydata.org, docs.scipy.org,
  scikit-learn.org, matplotlib.org/stable). The offline index covers
  **38,380 chunks across 10 libraries** (numpy, pandas, scipy, scikit-learn,
  matplotlib, seaborn + stdlib/builtins/typing + curated integration notes) at
  4096 dims. Loader never throws — any failure degrades to BM25-only.
- **Detector calibration**: the false "disallowed sklearn" flag was removed
  (2026-08-17) — sklearn (KMeans) is the soil_contamination assignment's **core
  library**. Disallowed libraries now live per-assignment in `data/scoring/*.yaml`.
- **Per-assignment calibration workflow**: scoring configs are per-assignment
  (anchors, evidence patterns, disallowed/allowed libraries, dimension
  guidance). `soil_contamination`'s config carries its own explicit values; new
  assignments get generic fallbacks that **NEVER inherit soil's anchors** (no
  scoring file = no anchors, calibration skipped loudly).

## Quality measurement posture after data removal

The earlier quality story measured the pipeline against **real emailed grades**
(the removed ground-truth gate) and produced per-student residual tables. That is
now gone by design (privacy). The pipeline's quality is measured without real
student data, via:

- **Synthetic grading-quality gate (replaces the removed ground-truth gate).** A deterministic
  gate (`frontend/src/lib/server/copilot/grading-gate.ts`, CLI
  `frontend/scripts/verify-grading-gate.mjs`, vitest
  `src/tests/copilot/grading-gate.test.ts`) validates proposed grading against
  the REAL rubric + grading config over committed synthetic fixtures
  (`src/tests/copilot/fixtures/grading-gate/*.json`). It asserts the invariant
  classes the old gate surfaced — dimension scores within `[0, max_points]`
  (the B7 scale-bug class — an arbitrary [0,1000] scale vs real `max_points` of
  4–6), no unknown rubric options, no
  mutual-exclusion violations. No LLM, no network, no student data — as safe to
  run as a unit test.
- **Unit/integration tests** — the deterministic phases (cell comparison,
  post-processing passes, scoring-config compile gate) are covered by the vitest
  suite; `pnpm check` (0/0) and the full vitest run are the hard gates.
- **Golden prompt contract** — the byte-exact Phase 2a fixture
  (`frontend/src/tests/copilot/fixtures/phase2a-prompt-golden.txt`) pins the
  assembled prompt.
- **Deterministic confidence flags** (below) — tell the teacher which rows to
  look at first.

The single-shot LLM has real variance (dimensions can land a couple of points
off a target), so the teacher remains the residual filter by design: the copilot
produces a well-reviewed draft, the teacher approves the final grade.

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

## Per-assignment calibration (no real grades required)

The calibration loop that keeps the pipeline honest works on **rubric
conformance and deterministic evidence**, not necessarily real student grades:

1. Run the real pipeline on a few submissions with the small-batch live runner
   (temp vitest spec under `frontend/src/tests/copilot/`, `DATA_DIR` = the
   clone's `data/` directory (bind-mounted into both containers), repo-root
   `.env` loaded, `preEvaluateSubmission(...)`, delete the file after).
2. Review the rubric selections and dimension scores in the UI.
3. Tune the per-assignment scoring config (anchors, evidence patterns,
   dimension guidance) via the scoring editor and re-run. The full loop is
   documented in the [Calibration guide](assignment-calibration.md).

> **Config drift pitfall:** pre-2.6 the Docker volume held its own copies of
> `assignments.yaml`, `grading_config.yaml`, and `criteria/*.yaml` and could lag
> the repo, silently degrading measurement runs. 2.6+ compose binds `./data`
> directly — one store, no lag. Migrate old volumes (README), and never keep a
> second copy of the config.

## Rubric-fidelity regression harness (P12, recorded transcripts)

Rubric-fidelity regression harness: `cd frontend && pnpm exec tsx scripts/run-transcript-evals.mjs --dry-run`
lists the grading proposals extracted from the recorded copilot transcripts
(no LLM; this is what CI/docs run) or, without `--dry-run`, replays them
through the live rubric-fidelity judge on the copilot's own KI Connect model
(concurrency 2, the empirical rate-limit ceiling; requires `KI_CONNECT_API_KEY`;
use `--model <id>` when `data/settings.yaml` lags the deployment).
Proposals are grouped per assistant turn from the grading WRITE tools
(`set-rubric-item` → rubric, `update-grade-dimension` → dimensions,
`write-notes`/`draft-notes` → feedback) recorded under
`DATA_DIR/copilot/memory/{threads,messages}/`; threads without grading writes
are skipped. Nothing is written — the harness only reads the store and prints a
table + JSON report. The harness (not any single score) is the deliverable:
scores are single-shot judge noise until many more recorded grading turns exist.
