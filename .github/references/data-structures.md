# Data structures & wiring

This is the companion to [architecture.md](architecture.md): **what the key data
structures are, where they live, and who writes vs reads them**. If you rename
a field, add an interface field, or move a config, update this file and grep
its producers — a required field on a shared interface breaks every object
literal that builds it (test helpers included).

---

## 1. Submission record & the executed notebook

**`SubmissionRecord`** (server) — one metadata entry per submission, read/written
by `frontend/src/lib/server/metadata.ts`:

```ts
{
  id: string;            // === studentId, e.g. "2026SS_01"
  studentId: string;
  semester: string;      // e.g. "2026SS"
  assignmentId: string;
  fileName: string;
  relativePath: string;  // e.g. "submissions/soil/2026SS_01.ipynb"
  status: "pending" | "executing" | "executed" | "error" | "pre-evaluated" | "graded" | "archived";
  error?: string;
  executedAt?: string;
  preEvalId?: string;
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

The pipeline's output is a single envelope per submission (type in
`pre-evaluation.ts`, mirrors on the client in `types/submissions.ts`):

```ts
{
  markers: CellMarker[];                 // Phase 1
  dimensionScores: Record<dimensionKey, number>;   // points, 0..max_points
  rubricSelections: Record<categoryKey, string[]>; // checked option keys (verbatim YAML texts)
  additionalNotes: Record<categoryKey, string>;
  feedbackDraft: CategoryFeedback[];
  gradeSuggestion: {
    dimensions: Record<string, number>;
    percentage: number;
    grade: string;                       // e.g. "2.3"
    rubric: Record<string, string>;
    feedback: Record<string, CategoryFeedback>;
    notes: string;
    weightedPercentage?: number;
  };
  evaluatedAt: string;
  gradingConfidence?: "needs_review" | "review_optional" | "high_confidence";  // optional on legacy
  calibrationAdjustments?: CalibrationAdjustment[];  // [{ submissionId, dimension, oldScore, newScore, reason }]
  overTick?: OverTickResult;              // advisory Signals A/B/C
}
```

**Wiring / translation:**
- The **client mirror** `PreEvalData` (`types/submissions.ts`) is what the UI
  reads. The detail endpoint (`api/submissions/[id]/+server.ts`) translates the
  server snake_case → client camelCase (e.g. `cell_index` → `cellIndex`).
- `gradingConfidence` is **optional** on the stored envelope (legacy rows lack
  it) but **required** on the pipeline return; the list endpoint enriches rows
  with `stored?.preEval?.gradingConfidence`, and legacy rows without it only
  match the "All" confidence filter.
- `calibrationAdjustments` is passed through on the detail response so the UI
  can show the old→new recalibration note (B3).

### 2.1 Envelope persist order

`preEvaluateSubmission → setPreEvaluation` (results-store) → `results.json`
holds `{ preEval, postProcessed, postProcessFixes, calibrationAdjustments }`.
`runCohortCalibration` overwrites **both** `preEval` and `postProcessed`
dimensions (calibration is the final authority); the adjustments keep the
old→new audit trail.

---

## 3. Grading state (what the teacher + copilot edit)

Grading is a **merge** of the pre-eval draft with teacher/copilot edits, all
persisted through `saveGrading` (`metadata.ts` / `grading-persistence.ts`):

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
- The **change ledger** shows teacher-facing accept/reject diffs (previous →
  new) and **turn checkpoints** allow reverting a whole copilot turn.

---

## 4. Configuration (tracked, the single source of truth)

| File | Holds | Loaded by |
| --- | --- | --- |
| `data/assignments.yaml` | `assignments:` list (id, title, enabled, criteria_files, dimensions) | `assignments.ts` |
| `data/grading_config.yaml` | **Global** dimensions (key, title, `max_points`, weight) + grade boundaries | `grading-config.ts` (read fresh) |
| `data/criteria/<id>.yaml` | Rubric categories + verbatim option texts (sub-points) | `criteria.ts`, `worksheet.ts` |
| `data/scoring/<id>.yaml` | **Per-assignment** scoring: `reference_anchors`, evidence regexes, `disallowed_libraries`, `allowed_libraries` (Pass 3), Phase 2a dimension guidance | `scoring-config.ts`, `cohort-calibration.ts`, post-process Pass 3 |
| `data/cohort_norms/<id>.yaml` | Cohort norm references for the over-tick guard | `over-tick.ts` |
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
| legacy teacher-side | `review/selection/session/grading/rubric/export` | student routes + old review flows |

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
