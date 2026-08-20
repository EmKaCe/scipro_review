# Developer guide & glossary

How the pieces are wired together on a day-to-day level, how to verify, and
what the terms mean. Architecture and data structures have their own docs
([architecture.md](architecture.md), [data-structures.md](data-structures.md));
this file is about **how to work here** and **what things are called**.

---

## 1. The workflow loop (verification-first)

1. **Read the conventions** — `AGENTS.md` (root + `frontend/`, `executor/`,
   `data/`) encode the build commands, the per-package **local-commit
   discipline** (never push until reviewed), and the key invariants.
2. **Write a test first** where it's a behavior change; for pre-eval/copilot
   changes, the relevant suite lives in `frontend/src/tests/copilot/`.
3. **Verify before claiming done:**
   ```bash
   cd frontend
   pnpm check                 # svelte-check — MUST be 0 errors AND 0 warnings
   pnpm vitest run <file>     # one file (see §3 gotcha)
   # whole-project canonical verify (from repo root): pnpm install →
   # pnpm build:student → unset ADAPTER NODE_ENV KI_CONNECT_API_KEY →
   # pnpm vitest run → preview probe on http://127.0.0.1:4173/svelte_review/ (HTTP 200)
   ```
4. **Commit per package, locally only.** No push until the human reviews.

> **Important invariants to never break silently:** the Phase 2a golden prompt
> is **byte-exact**; no real student grading data may be reintroduced (privacy);
> KI Connect concurrency stays at **2** (measured rate limit); student notebook
> content is **screened** before any prompt.

---

## 2. How the async run-state works (the "three loops")

Batch runs (Process, Pre-evaluate) are polled, not pushed. The single source of
truth is **`run-state.svelte.ts`** (a module-level `$state` registry): the
dashboard's "Pre-evaluate All" handler arms it, and the list page derives its
progress bar, log live-mode, stopwatch, Reset-disable, and store polling from
it. There are three cadences:

| Loop | Cadence | Who drives it |
| --- | --- | --- |
| Store list polling | 2 s | `submissions-store` — alive while rows are pending/executing OR `runRegistry.preEval.running` (BUG-020) |
| Page run polling | 2 s | the list page `$effect` while a process/pre-eval run is active (logs + status) |
| Dashboard pre-eval polling | 2 s | the dashboard while `runRegistry.preEval.running` or status `running` |

**Rules the careful reader should preserve:** a run that finishes before the
first status poll still refreshes (the POST handler refreshes directly +
`markRunFinished` keeps the summary); a stale/superseded status observation
must never disarm an active run; a page reload mid-run re-arms the registry
from the unified `GET /api/pipeline/status`.

---

## 3. Testing conventions

- **Vitest narrowing gotcha:** `pnpm test -- <file>` runs the WHOLE suite —
  vitest ignores the positional filter. Always use `pnpm vitest run <file>` for
  one file.
- **Test layout** mirrors `src/`: `tests/copilot/` (pipeline, pre-analysis,
  scoring, worksheet, post-process, tools), `tests/stores/`, `tests/services/`,
  `tests/components/`, `tests/routes/`.
- **Fixtures vs production tables:** the pre-eval/copilot tests use local YAML
  fixtures (`CRITERIA_YAML`, `ASSIGNMENTS_YAML`) — extending them ripples into
  hard-coded occurrence counts and round-trip assertions. Re-check counts when
  a fixture grows.
- **Whole-project gate** is the canonical verify above (`pnpm check` + full
  `vitest run` + preview probe); report green only when every phase passes.

---

## 4. Git / repo hygiene (no direct pushes)

Every change follows the chain: implementer → spec review → quality review →
controller verify → **local** commit (`git commit`, no push). Branches sit ahead
of `origin/` until the human reviews and pushes. Never commit runtime state
(`data/submissions/`, `data/plagiarism/`, `data/copilot/`, `data/materials/`,
`grading-output/`, `.env`).

---

## 5. Glossary

| Term | Meaning |
| --- | --- |
| **Pre-evaluation / pre-eval** | The deterministic+LLM pipeline that drafts a full grade worksheet from an executed notebook (markers → dimension scores → turn-based rubric → feedback → post-process → calibration). |
| **Phase 1** | Per-cell marker classification (marker label + reason). |
| **Phase 2a** | Dimension scoring; prompt is byte-exact (golden fixture). |
| **Phase 2b** | Turn-based rubric worksheet selection — one category per LLM call, edited markdown, retry loop ≤ 3 = verification. |
| **Worksheet** | The markdown rubric a category selection edits (`generateWorksheet` / `validateWorksheetSection`). |
| **Post-process / passes** | 7 deterministic correction passes over the worksheet (see architecture §3.2). |
| **Cohort calibration** | Cross-submission re-centering of dimension scores toward reference anchors; writes `calibrationAdjustments` (old→new). |
| **Pre-analysis** | Deterministic detectors that feed facts into prompts (imports, non-descriptive names, kwarg-assign). |
| **PreAnalysis / envelope** | The `PreEvaluation` output object (markers, dimensionScores, rubricSelections, feedbackDraft, gradeSuggestion, gradingConfidence, calibrationAdjustments). |
| **gradingConfidence** | `needs_review` / `review_optional` / `high_confidence` — the human-review flag. |
| **grading-gate** | The deterministic **synthetic grading gate** (`verify-grading-gate.mjs` / `grading-gate.test.ts`) — validates proposed grading over committed synthetic fixtures against the real rubric + config (no student data). Replaces the removed Karl gate. |
| **DOCS_FACTS** | The docs-RAG-grounded block in the Phase 2a prompt. |
| **search-docs** | Copilot tool (docs-rag) the agent must call before flagging API usage. |
| **Run-state registry** | `run-state.svelte.ts` — single source of truth for batch-run progress (B4). |
| **Change ledger** | Teacher-facing accept/reject list of grading edits (with turn checkpoints). |
| **Screening** | B13 — small-LLM gate that scrubs notebook content for instruction-smuggling before prompts; fails open. |
| **KI Connect** | The OpenAI-compatible endpoint abstraction (`ki-connect.ts`); systems (grading, copilot, embeddings) all speak it. |
| **Rich outputs** | image/html cell outputs preserved per B11, rendered sandboxed, never in prompts. |
| **Dual adapter** | `ADAPTER=static` (student SPA) vs `ADAPTER=node` (teacher server). |
| **Turn** | One copilot exchange (prompt → tool calls → result). Phase-grouped in the transcript. |
