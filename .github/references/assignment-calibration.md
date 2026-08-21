# Onboarding a New Assignment — Calibration Guide

How to take a brand-new assignment from "registered" to soil-contamination-quality
pre-evaluation and copilot support. Written for the teacher who will maintain the
system after the original author (anyone).

> The golden rule: **the ground truth is the teacher's own grades, not the system.**
> The pipeline reaches soil-like quality only through the calibration loop below —
> the scoring config is a form, not a silver bullet.

## 1. The five configuration layers

Every assignment is configured through five independent layers. A new assignment
works at every layer without any of them, but quality comes from filling them.

| # | Layer | Where | What it does | Needed for |
|---|---|---|---|---|
| 1 | Registry entry | Assignments UI (`/settings/assignments`) → `data/assignments.yaml` | id, title, enabled, grading dimensions | Everything downstream |
| 2 | Rubric (criteria) | Criteria editor + upload (`/settings/assignments/<id>/criteria`) → `data/criteria/<id>.yaml` | The checklist + option texts. Phase 2b rubric selection and the **copilot** read these | Feedback quality, copilot grounding |
| 3 | Reference key + materials | Materials upload (`/api/assignments/[id]/materials`) | What Phase 1 compares cells against; input data | Cell markers ("same/different/questionable") |
| 4 | Scoring config | Scoring editor (`/settings/assignments/<id>/scoring`) → `data/scoring/<id>.yaml` | Anchors, evidence patterns, disallowed/allowed libraries, Phase 2a dimension guidance | Dimension-score quality, calibration |
| 5 | Docs index coverage | Prebuilt offline index (`docs-index/`) | Docs grounding (signatures/params) for API-fact checks | Grounded API verification — only for the 10-library corpus (numpy, pandas, scipy, scikit-learn, matplotlib, seaborn + stdlib/builtins/typing + curated integration notes; 38,380 chunks); other libraries degrade to BM25-only |

## 2. The calibration loop (the only way to reach soil-like quality)

Soil contamination reached gate-parity through this loop, repeated:

1. **Run the real pipeline on 2-3 submissions** — small-batch live runner (a temp
   vitest spec under `frontend/src/tests/copilot/`, `DATA_DIR` = the Docker volume,
   repo-root `.env` loaded, `preEvaluateSubmission(...)`, delete the file after).
2. **Compare dimension scores and rubric selections against a reference grading**
   for those submissions. Tolerance: ±0.5 per dimension.
3. **Tune the scoring config**: evidence regexes (`evidence_patterns`) and the
   per-dimension guide text (`prompt_anchor_text.dimension_guidance`) via the
   scoring editor. Re-run until within tolerance.
4. **Repeat with more submissions** until the drift is stable.

Strictness is encoded in TWO places, and both matter:
- **The guide text**: "5 = only when X AND Y; 4 = …; 3 = …" — the words encode the
  teacher's scale.
- **The calibration data**: the teacher's actual grades on the sample submissions.
  A stricter teacher grades fewer 5s — the loop measures the gap and the guide
  text gets tuned until the pipeline lands where the teacher lands.

No amount of prompt text replaces the loop. The small-batch runner recipe lives in
the project skill (`svelte-review-copilot` → `references/small-batch-live-runner.md`).

## 3. What does NOT need per-assignment work

- The Phase 2A prompt **template** (raw-points scale, self-check list, example) —
  generic, code-owned.
- The copilot's system prompt (`AGENT_INSTRUCTIONS`) — **assignment-agnostic**;
  its quality comes from the rubric YAML being complete and the docs index
  covering the assignment's libraries.
- The generic per-dimension guide lines (`DEFAULT_DIMENSION_GUIDANCE`) for
  dimensions the assignment does not override.

## 4. The system-prompt nuance (important)

`dimension_guidance` **is** the per-assignment system-prompt text: the Phase 2A
scoring prompt substitutes it into `{DIMENSION_GUIDE}`. Editing it through the
scoring editor **changes the prompt the model sees** — that is the intended
per-assignment prompt-tuning surface. The template scaffold itself is not editable
from the UI.

- soil_contamination's assembled prompt is pinned by a golden test
  (`frontend/src/tests/copilot/fixtures/phase2a-prompt-golden.txt`). If you
  deliberately retune soil's guidance, that test fails until the fixture is
  regenerated — a conscious-act guard, not a wall.
- The other two prompt-ish configs (`reference_anchors` → Phase 2c cohort
  calibration, `evidence_patterns` → deterministic evidence bullets) are **not
  prompt changes** — they are deterministic data consumed before/after the model.

## 5. Drafting help (LLM)

The scoring editor has a **Draft with AI** button (`POST
/api/assignments/[id]/scoring/draft`): it drafts a scoring config from the
assignment's rubric. It **never writes** — review and edit before saving. Save
goes through the compile gate (bad regex / partial anchors → 400).

Use the draft as a starting point, especially the `dimension_guidance` text.
**Do not trust the draft's regexes** — validate them against real executed outputs
in the calibration loop (this is how the soil `sklearn` false-flag bug happened).

## 6. Pitfalls

- **Volume staleness**: the Docker volume (`/var/lib/docker/volumes/svelte-review-data/_data`)
  keeps its own copies of `assignments.yaml`, `criteria/*.yaml`, `scoring/*.yaml`,
  and the docs index. Sync before ANY live run (backup first: `cp -r` the volume
  config dirs). A lagging volume silently falls back to generic semantics.
- **Compile gate**: every `pattern` in the scoring config must compile
  (`new RegExp(p, 'i')`) — a bad regex surfaces as a 400 / failed test, never
  silent degradation.
- **No-op saves** keep the tracked YAML byte-identical when nothing changed.
- **Do not touch** `data/scoring/soil_contamination.yaml` or the golden fixture
  unless deliberately retuning soil — the removed ground-truth gate + calibration findings were
  tuned against them.
- **The reference key** (layer 3) is the comparison ground truth for Phase 1 —
  without it, markers are null and pre-evaluation quality collapses.
