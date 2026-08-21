# Data structures & wiring

This is the companion to [architecture.md](architecture.md): **what the key data
structures are, where they live, and who writes vs reads them**. If you rename
a field, add an interface field, or move a config, update this file and grep
its producers — a required field on a shared interface breaks every object
literal that builds it (test helpers included).

---

## 1. Submission record & the executed notebook

**`SubmissionRecord`** (server) — one metadata entry per submission, read/written
by `frontend/src/lib/server/metadata.ts` (`metadata.json`, keyed by studentId):

```ts
{
  id: string;              // === studentId, e.g. "2026SS_01"
  studentId: string;
  assignmentId: string;
  semester: string;        // derived from the student ID prefix, e.g. "2026SS"
  fileName: string;        // original uploaded file name
  notebookPath: string;    // notebook path relative to DATA_DIR, e.g. "submissions/soil/2026SS_01.ipynb"
  status: SubmissionStatus; // "pending" | "executing" | "executed" | "error" | "pre-evaluated" | "graded" | "archived"
  cellSummary?: string;    // e.g. "6 cells, 1 diff"
  teacherGrade?: number;
  error?: string | null;
  grading?: GradingState;  // rubric / dimensions / feedback / notes
  archivedFrom?: SubmissionStatus;
  createdAt: string;
  updatedAt: string;
}
```

**Executed cells** — stored per assignment in `<DATA_DIR>/submissions/<assignment>/results.json`
via `results-store.ts`. Each `ExecutedCell` carries `index`, `type`
(`code`/`markdown`), `source`, and `outputs` (`CellOutput[]`). Rich outputs
(B11) are `image/png` (base64 data URL) and `text/html` — capped server-side,
rendered in a **sandboxed iframe**, and **filtered out before any prompt**.

### 1.1 Write/read matrix

| Structure | Writer | Reader |
| --- | --- | --- |
| `SubmissionRecord` | upload route, process route | dashboard list, detail page |
| `results.json` (msgs + envelopes) | pipeline (pre-eval), executor results | detail page, gate scripts, export |
| executed cell `outputs` | executor `runner.py` | teacher preview; filtered before prompts |

---

## 2. The `PreEvaluation` envelope

The pipeline's output is a single envelope per submission (server type in
`pre-evaluation.ts`, client mirror in `types/submissions.ts`):

```ts
// server — `PreEvaluation` (frontend/src/lib/server/copilot/pre-evaluation.ts)
{
  markers: PreEvaluationMarker[] | null;       // Phase 1; null = no reference key available
  gradeSuggestion: {
    dimensions: Record<string, number>;        // dimension id -> points (0..max_points)
    justification: string;                     // free-form rationale for the suggested grade
  };
  rubricSelections?: { categoryKey: string; optionKey: string }[];  // LLM-selected rubric items
  additionalNotes?: Record<string, string>;    // per-category worksheet notes
  feedbackDraft: string;                       // draft worksheet feedback text
  notebookSummary: string;                     // prose summary for the teacher
  gradingConfidence?: "needs_review" | "review_optional" | "high_confidence"; // optional on legacy
}
```

**Wiring / translation:**
- The **client mirror** `PreEvalData` (`types/submissions.ts`) is what the UI
  reads. The detail endpoint (`api/submissions/[id]/+server.ts`) maps each
  stored marker's `cell_index` → `cellIndex` and passes through
  `gradeSuggestion` / `rubricSelections` / `additionalNotes` /
  `feedbackDraft` / `notebookSummary` / `gradingConfidence` / `evaluatedAt`.
- `gradingConfidence` is **optional** on the stored envelope (legacy rows lack
  it) but the pipeline return always sets it; the list endpoint enriches rows
  with `stored?.preEval?.gradingConfidence`, and legacy rows without it only
  match the "All" confidence filter.
- `calibrationAdjustments` and `overTick` are advisory siblings on the detail
  response: the old→new recalibration notes (B3) and the over-tick flags
  computed from the committed cohort norms (`over-tick.ts`).
- The corrected grading data travels alongside the raw envelope as
  `PreEvaluationWithPostProcess` = `PreEvaluation` & `{ postProcessed:
  PostProcessData, postProcessFixes: PostProcessFix[] }`.
  `PostProcessData` holds `dimensions` (points, 0..max_points),
  `rubricSelections`, and `additionalNotes` after the 7 deterministic passes.

### 2.1 Envelope persist order

`preEvaluateSubmission → setPreEvaluation` (`results-store.ts`) →
`results.json` holds per student: `{ preEval, postProcessed,
postProcessFixes, calibrationAdjustments }` (the raw `preEval` envelope stays
the untouched LLM output; the corrected view is stored as siblings).
`runCohortCalibration` (`pre-evaluation.ts`) overwrites the dimensions in
**both** `preEval.gradeSuggestion.dimensions` and `postProcessed.dimensions`
(calibration is the final authority); the adjustments keep the old→new audit
trail.

---

## 3. Grading state (what the teacher + copilot edit)

Grading is a **merge** of the pre-eval draft with teacher/copilot edits, all
persisted through `saveGrading` (server `frontend/src/lib/server/metadata.ts`;
the client calls it via `frontend/src/lib/services/submissions-api.ts`). The
`GradingState` shape is a subset of the pre-eval merge:

```ts
{
  rubric: Record<string, string>;   // categoryKey -> optionKey (checked)
  dimensions: Record<string, number>; // dimensionKey -> points (0..max_points)
  feedback: Record<string, CategoryFeedback>;
  notes: string;
}
```

- **Dimension values are points, not 0-1000.** `update-grade-dimension` and
  `save-grading` reject out-of-range values against `grading_config.yaml`
  `max_points` at run time (B7). The UI slider max is `dimension.max_points`;
  `calculateGrade` clamps and computes weighted percentage/grade.
- `frontend/src/lib/services/grading-persistence.ts` bridges the live
  `CategorySelections` (Sets) and the persisted `CategoryFeedback` shape
  (`selectionsToFeedback` / `feedbackToSelections`), losslessly.
- The **change ledger** shows teacher-facing accept/reject diffs (previous →
  new) and **turn checkpoints** allow reverting a whole copilot turn.

---

## 4. Configuration (tracked, the single source of truth)

| File | Holds | Loaded by |
| --- | --- | --- |
| `data/assignments.yaml` | `assignments:` list (id, title, enabled, criteria_files, dimensions) | `assignments.ts` |
| `data/grading_config.yaml` | **Global** dimensions (key, title, `max_points`, weight) + grade boundaries | `services/grading-config.ts` (teacher mode via `GET /api/config/grading`); read directly by copilot modules (grading-gate, tools, pipeline `validate`/`context`) |
| `data/criteria/<id>.yaml` | Rubric categories + verbatim option texts (sub-points) | `criteria.ts`, `worksheet.ts` |
| `data/scoring/<id>.yaml` | **Per-assignment** scoring: `reference_anchors`, evidence regexes, `disallowed_libraries`, `allowed_libraries` (Pass 3), Phase 2a dimension guidance | `scoring-config.ts`, `cohort-calibration.ts`, post-process Pass 3 |
| `data/cohort_norms/<id>.yaml` | Cohort norm references for the over-tick guard. **No longer tracked** (removed 2026-08-20 with the student-data strip) — `over-tick.ts` still reads `DATA_DIR/cohort_norms/<assignment>.yaml` at runtime; absent → no flags (best-effort guard) | `over-tick.ts` |
| `data/settings.yaml` | llm (base_url/model/timeout), executor, copilot (approval mode, tool allow/deny, TTL…) | `settings.ts` (read fresh every request) |
| `frontend/src/routes/layout.css` | Design tokens (colors/radii) — **the only place literals live** | every component via `var(--…)` |

**Rules:**
- **Worksheet option texts are verbatim from `data/criteria/*.yaml`** — not from
  `legacy-catalog.ts` (which maps category → legacy prefix only). A checkbox must
  match the YAML text byte-for-byte (typos included: "separatation",
  "encode ideas", "PEP8 guidelines- followed").
- An assignment **without** a scoring file must never inherit soil's anchors —
  `runCohortCalibration` skips loudly when no `reference_anchors` resolve.
- Never commit `data/submissions/`, `data/plagiarism/`, `data/copilot/`,
  `data/materials/`, `grading-output/`, or `.env`.

---

## 5. Client-side stores & wiring

| Store | State | What watches it |
| --- | --- | --- |
| `submissions-store.svelte.ts` | list, selected, detail cache, assignmentId, includeArchived; 2s polling loop; `uploadMany`/`process`/… | dashboard, list page, upload panel |
| `plagiarism-store.svelte.ts` | `result`, `assignmentId`; **sequence-guarded** `load` (BUG-019) | dashboard badge, plagiarism modal, per-submission tab |
| `run-state.svelte.ts` | **shared registry** of process + pre-eval run state (`markRunStarted`/`markRunFinished`/`setRunSummary`) | list page (progress bar, Reset-disable, log live), dashboard, store polling (B4) |
| `autofix-store.svelte.ts` | autofix dispositions / fixed-view set | detail page |
| review-side stores (`stores/`) | `review` / `selection` / `session` / `grading` / `rubric` / `export` — review worksheet, selections, and export flows; `header` / `settings` / `toast` — app chrome | review + export UI |

**Wiring rule of thumb:** the **API client** (`submissions-api.ts`) is the only
place that knows URL/JSON contracts; the **stores** own reactive state; the
**components** only read stores + props. New endpoints go in `submissions-api.ts`
first.

---

## 6. Checklist: editing these

- Adding a **required field** to an exported interface → update every producer
  (grep `search_files pattern "<InterfaceName>"` across `src/`; test helpers
  build full literals).
- Changing a **rubric option text** → update the YAML, the worksheet, AND any
  verbatim-text constant in post-process/pre-analysis in the same change.
- Changing the **Phase 2a prompt** → regenerate
  `frontend/src/tests/copilot/fixtures/phase2a-prompt-golden.txt` **deliberately**;
  the gate asserts byte equality.
- Growing a hard-coded array → grep `[0]` / `?.[0]` consumers and switch them
  to semantic lookup (`.find(p => p.a === …)`).
- Removing an exported symbol → update its importers and any `{@link …}`
  doc references in the same pass.
