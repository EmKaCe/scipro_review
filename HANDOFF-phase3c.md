# Handoff — SciPro Review Copilot: what is LEFT to finish Phase 3

> Updated 2026-08-03 after commit `4846ef8`. This document is the source of
> truth for the next session: **what remains, what already exists to build on,
> and how to verify.** Stay untracked (session doc — repo convention).

---

## 1. TL;DR

- **Committed:** `4846ef8` on branch `phase-3b` — `feat(phase-3c): plagiarism review, autofix cards, export split, teacher backup`. All gates green at commit time: vitest 375 · pytest 43 · tsc · svelte-check 0/0 · eslint/prettier.
- **Everything in plan sub-phases 3a–3e, 3g, 3h is delivered.** What remains is the **3f remainder** (three UI stubs) + **3i backlog**:
  1. **Upload UI panel** — real upload works only via API; the panel is a Phase-2 stub.
  2. **Process All button** — stub toast; batch API exists. (Pre-evaluate All is Phase 4 by design — leave it.)
  3. **Rubric persistence** — checkboxes work in-memory; comments/deductions/notes/sliders don't persist; Save Grade sends only zeros. This also unlocks the student-copy `feedback` section.
  4. **3i (backlog): teacher-side YAML import** — apply a grading YAML to a re-uploaded notebook.
- **Naming warning:** git session labels (`phase-3b`, `phase-3c` commits) DO NOT match plan sub-phase numbers (`3a`–`3i` in `.hermes/plans/2026-07-29_phase-3-execution-and-data.md`). The plan doc is the source of truth. Future commits should use plan-aligned labels (e.g. `feat(phase-3f)`).

---

## 2. What is left to build (ordered by dependency)

### 2.1 Rubric persistence (biggest item — do first)

**Why it matters:** without it, grading state never survives reload, the export's `feedback` section is empty, and Phase 4 pre-evaluation has no rubric state to consume.

**Current state (verified line refs):**
- `frontend/src/lib/components/submissions/right-panel-tabs.svelte:107-117` — `handleUpdateComment` / `handleUpdateDeduction` / `handleUpdateNotes` are `// Phase 2 stub` no-ops. Checkbox toggles ARE live (`handleToggleCheckbox` + `categorySelections = $bindable()`), but only in memory.
- `frontend/src/routes/submissions/[id]/+page.svelte:262-264` — `handleUpdateDimension` no-op → grading sliders never update `gradingInputs`.
- `doSaveGrade` (same file, ~line 312) sends only `{ dimensions: {...gradingInputs} }` → always zeros.
- Page does not restore grading state on load (no `gradingInputs`/`categorySelections` initialization from `submission.grading`).

**Backend already supports it:**
- `POST /api/submissions/[id]/save` → `saveGrading()` in `lib/server/metadata.ts:268` **merges per-field**: `rubric` (criterion→option), `dimensions`, `notes` (replaces whole notes when provided — autofix already appends to it).
- Wire shape: `GradingPatch` in `lib/services/submissions-api.ts:82-89` (`rubric?`, `dimensions?`, `notes?`).

**To do:**
1. Wire `handleUpdateDimension(key, value)` → update `gradingInputs[key]` in the page (5 sliders exist; values = points deducted per the grading config).
2. Wire the three right-panel handlers → update `categorySelections[category].comments/deductions/notes` (same immutable pattern as `handleToggleCheckbox`; the `key` is the sub-point text; notes is per-category).
3. Extend `doSaveGrade` to send `rubric` + `notes`:
   - `rubric` mapping design decision: the record stores `criterion_key → selected_option_key` (see `GradingState`), but selections are **sub-point texts**. Decide + implement the mapping (find the option whose sub-points contain the checked text — needs the merged rubric client-side, which the page already loads via `getCriteriaForAssignment`).
   - `notes`: decide whether Save Grade writes a top-level notes field (the teacher-facing notes area — the Notes editor in the page? There is no top-level notes editor in the UI yet; only autofix appends `[Cell N]` blocks. Consider adding one or deferring — see "open questions".)
4. **Restore on load:** after `submissionsStore.select(id)`, initialize `gradingInputs` from `record.grading.dimensions`, and `categorySelections` from `record.grading.rubric` (reverse-map option keys → sub-point texts via the rubric) + comments/deductions/notes if they get persisted (they aren't in `GradingState` yet — see open question).
5. **Student-copy export `feedback`:** `buildStudentYaml` in `lib/server/export-service.ts` currently emits `feedback: {}`. Once selections persist, emit per-category `checked/comments/deductions/notes` (v2 schema, `CategoryFeedback` in `lib/types/evaluation.ts`). Server-side mapping needs the criteria files (available under `data/criteria/` — the loader is client-side today; either load server-side or pass through).

**Acceptance:** check a box, write a comment, set a slider, Save Grade → reload the page → everything restored; export student copy → YAML contains non-empty `feedback` with checked texts/comments.

**Open questions to resolve in the new plan:** (a) comments/deductions/notes are NOT in `GradingState` today — extend the schema + `saveGrading` merge, or keep them client-session-only? (b) top-level notes editor — add one? (c) rubric mapping semantics (multiple checked items in one criterion → last-wins? or option with the most checked items?).

### 2.2 Upload UI panel

**Current state:** `frontend/src/lib/components/submissions/upload-panel.svelte` — stub flag at line 12; toasts "Phase 3: real file upload" / "classification pipeline execution" (lines 72/77/82); simulated detection. `upload-bar.svelte` (compact drop zone below the table) opens the panel via `handleToggleUploadPanel`.

**Backend already exists:** `POST /api/submissions/upload` (multipart `files` + `assignmentId`) classifies each file (`submission` / `material-data` / `material-file`) and persists. Client: `uploadSubmissions(files, assignmentId)` in `lib/services/submissions-api.ts` (already returns `SubmissionUploadResult[]`); store wrapper exists.

**To do:** replace the stub flow: real file input → `uploadSubmissions` → show per-file classification results (the API returns kind + persisted path + errors) → refresh the submission list (and plagiarism cache is per-assignment, unaffected). Keep the existing visual structure if the mockup allows (mockup `upload-panel.html` was marked "unchanged" in Phase 3c — the new session decides whether to follow the existing stub UI or request a mockup update).

**Acceptance:** drop/select 1–3 .ipynb files in the browser → they appear in the dashboard table with status `pending` (server-side), no manual API calls.

### 2.3 Process All button

**Current state:** `frontend/src/routes/submissions/+page.svelte:134-136` — `handleProcessAll` toast "Processing pipeline coming in Phase 3".

**Backend already exists:** batch processing client `processSubmissions(ids, assignmentId)` (submissions-api) + store wrapper; per-submission `processSubmission` is proven (used in E2E). Executor runs the 4-step pipeline; `status` transitions server-side (`pending → executing → executed/error`).

**To do:** wire to the batch endpoint, then **poll/refetch** the list until no submission is `executing` (a small interval refetch of `fetchSubmissions`; the store's `load()` is the refetch path). Handle partial failures (per-submission error statuses, toast summary). Disable while running; show progress (count done/total in the button or a status line).

**Acceptance:** 3 pending submissions → Process All → statuses become `executed` (or `error`) without manual per-row processing; UI reflects progress; errors visible per row.

**Pre-evaluate All** stays a stub toast ("Pre-evaluation coming in Phase 4") — do NOT build it (Phase 4 scope).

### 2.4 3i backlog — teacher YAML import (optional, lower priority)

Apply a teacher grading YAML (`<id>-teacher.yaml`, which now carries the full record + plagiarism audit) to a re-uploaded notebook: upload notebook via the existing path → import route applies scores/notes/grade (+ optionally rubric + plagiarism statuses). This closes the per-submission teacher-to-teacher handoff gap (today only the whole-`data/` backup works). Blocked on 2.1 for rubric fields. **Not required for the 3f finish** — plan it explicitly or defer.

---

## 3. Phase 4 boundary (do NOT build in the 3f finish)

- **Copilot tab** — surface exists (`copilot-store.svelte.ts` is a stub that replies "not yet active"; Phase 4 = Mastra agent).
- **Pre-evaluation / cell comparison / grade suggestions** — Phase 4 LLM call (subsumes Pre-evaluate All).
- `Suggest` / `Draft Notes` buttons switch to the Copilot tab — leave as-is.

---

## 4. Final manual verification checklist (for the new session, after the 3f work)

### 4.1 Stack setup (repeatable)

```bash
cd /root/projects/svelte-review-copilot/frontend
cp -r ../data static/                                  # static data copy for /data/*.yaml fetches
# terminal 1 — executor:
cd ../executor && export DATA_DIR=/root/projects/svelte-review-copilot/data \
  && export KI_CONNECT_API_KEY=$(grep -oP '^KI_CONNECT_API_KEY=\K.*' ../.env | tr -d '"') \
  && .venv/bin/uvicorn app:app --host 127.0.0.1 --port 8766
# terminal 2 — teacher dev server:
cd ../frontend && export DATA_DIR=/root/projects/svelte-review-copilot/data \
  EXECUTOR_URL=http://127.0.0.1:8766 \
  && export KI_CONNECT_API_KEY=$(grep -oP '^KI_CONNECT_API_KEY=\K.*' ../.env | tr -d '"') \
  && ADAPTER=node npx vite dev --port 5173 --host 127.0.0.1
```

**Test data already on disk** (gitignored): submissions `2026SS_01/02/03.ipynb` (01↔02 = flagged plagiarism pair; 03 has a failing cell + saved autofix note), `data/plagiarism/soil_contamination.json`. All statuses/state persisted from the last E2E session.

### 4.2 Regression pass (everything already delivered — must still work)

Teacher app = `http://127.0.0.1:5173/submissions` (root `/` is the student home in dev — by design; teacher redirect is production-only).

1. Dashboard: 3 submissions listed, statuses real; Plagiarism button + badge.
2. Plagiarism modal (760px): pair card, chips, Re-run check.
3. `2026SS_01` → Plagiarism tab → Accept → Undo → both work, status persists (PATCH round-trip).
4. Export guard: with the pair unreviewed → Export → modal → Go to review / Export anyway.
5. `2026SS_03` → Cell 3 autofix card → Suggest fix (KI, ~10 s) → Copy to notes → edit → Save → `[Cell 3] …` in notes; Reset restores.
6. Rubric tab: tick checkboxes → sentiment counts live (pos/neu/neg).
7. Export split button (header + mobile bottom bar): primary = student copy `<id>.yaml` (v2, importable, no plagiarism); caret → teacher `<id>-teacher.yaml` (has `plagiarism:` block for 01).
8. Backup button (dashboard): Download → zip; Restore → `{"restored":N}`.
9. Student loop: import the student copy via `/` → Import → review opens → evaluation page shows the Notes section.
10. Mobile 390px: 5-tab bar, icons hidden, bottom-bar Export/Save, guard modal.

### 4.3 New-feature pass (the 3f work — write these before/after implementing)

- [ ] **Upload UI:** pick 2 notebooks → classified + listed as `pending`; no console errors; list refreshes.
- [ ] **Process All:** run on pending → statuses become `executed`/`error`, progress visible, partial errors shown; row stays clickable.
- [ ] **Sliders persist:** change Grading sliders → Save Grade → reload → values restored (and `GET /api/submissions/[id]` shows `grading.dimensions`).
- [ ] **Rubric state persists:** tick items + comments/deductions/notes → Save → reload → all restored.
- [ ] **Student copy feedback:** export student copy after rubric state → `feedback` contains checked texts/comments/deductions/notes; still no plagiarism/status.
- [ ] **Autofix note survives rubric saves:** `[Cell 3]` note still present after Save Grade (notes merge, not clobber).
- [ ] (If 2.4 built) Teacher YAML import round-trip: upload notebook + import `<id>-teacher.yaml` → scores/notes restored.

---

## 5. Environment & toolchain facts (do not rediscover)

- **Tests:** `frontend/src/tests/` (vitest, jsdom default). Run with `unset ADAPTER NODE_ENV KI_CONNECT_API_KEY` before vitest/pytest — `.env` sets `ADAPTER=node NODE_ENV=production` and breaks jsdom tests.
- **Gate:** `pnpm vitest run` → executor `.venv/bin/python -m pytest -q` (unset `PORT EXECUTOR_URL EXECUTOR_PORT EXECUTOR_LOG_LEVEL KI_CONNECT_BASE_URL KI_CONNECT_API_KEY COMPOSE_PROJECT_NAME` too) → `npx tsc --noEmit -p tsconfig.json` → `pnpm check` (svelte-check 0/0) → `npx eslint .` → `npx prettier --check .`.
- **New `.svelte.ts` stores must be imported with the explicit `.svelte.js` extension** (`$lib/services/x.svelte.js`) — plain `.js` fails svelte-check on new files.
- **Svelte 5:** snippet props need `{#snippet}` blocks (inline `prop={<X/>}` fails svelte-check); `SvelteMap`/`SvelteSet` from `svelte/reactivity` required by eslint; classes passed via component props need `:global()` to avoid unused-CSS warnings.
- **Route tests that touch multipart/binary:** add `// @vitest-environment node` (jsdom's Blob/FormData break undici round-trips) — see `tests/routes/backup-api.test.ts`.
- **Executor autofix endpoint is `POST /auto-fix`** (hyphen). Re-run: `/execute/autofix-run`.
- **Plagiarism:** per-pair `reviewStatus` (`unreviewed/accepted/dismissed/ignored`), PATCH `/api/plagiarism/results`; export guard marks remaining pairs `ignored` on "Export anyway".
- **Plans:** `.hermes/plans/` is gitignored/untracked (deliberate, commit `6ab9060`) — plan docs live locally. `refined-master-plan.md` holds durable decisions (D9 export split, D10 backup); `2026-07-29_phase-3-execution-and-data.md` holds sub-phase breakdown + status.
- **Data layout:** `data/{assignments.yaml, criteria/, grading_config.yaml, materials/, submissions/<assignment>/, plagiarism/}` — all gitignored except `assignments.yaml`, `grading_config.yaml`, `criteria/`. Migration = copy `data/` (backup zip does this).
- **Background servers:** vite :5173 + executor :8766 were left running; check `process`/ports before starting new ones.

---

## 6. Phase-naming map (git vs plan — avoid the 3c confusion)

| Git (branch/commits) | Plan sub-phases delivered |
|---|---|
| `phase-3b` branch, `65c631e` (prev. session) | 3a Foundation, 3b Data Layer, 3c Autofix Loop (backend), 3d Plagiarism, parts of 3f (per-submission data view) |
| `4846ef8` `feat(phase-3c)` (this session) | 3e Plagiarism UI, 3g Docs, 3h Export split + backup, autofix UI cards, mobile, remaining 3f store wiring |
| Next commit(s) | **3f remainder** (this handoff §2.1–2.3), then optionally 3i |

Use plan-aligned labels going forward: `feat(phase-3f): …`.


---

## 7. Phase-3f implementation status (completed 2026-08-03)

All handoff §2.1–2.3 gaps are IMPLEMENTED, TESTED, and E2E-VERIFIED on branch
`phase-3b` (12 commits, `d3cdbcf`..`9265d3b`, labels `feat(phase-3f)`/`fix(phase-3f)`/`style(phase-3f)`).

### Rubric persistence (A1–A7)
- `GradingState.feedback` (v2 `CategoryFeedback` per category) persisted via
  `POST /api/submissions/[id]/save` (per-field, per-category merge; 400 on invalid).
- Lossless round-trip: `grading-persistence.ts` (`selectionsToFeedback` /
  `feedbackToSelections` / `findCategoryEntry`), restore-on-load in the
  per-submission page; sliders (dimensions) persist and restore too.
- Student + teacher YAML exports carry the `feedback` block (checked/comments/
  deductions/notes); no status/file_name/plagiarism leaks.
- LIVE BUG FOUND + FIXED during E2E: `$bindable` + local `$derived` over
  `categorySelections` never re-rendered on child-side assignments (Svelte
  5.56.8 prop-tracking quirk), and the TipTap notes `onUpdate` forward looped
  with the notes-sync effect (throwing `state_unsafe_mutation`, starving
  renders). Fix: controlled prop + `onSelectionsChange` callback; `onUpdate`
  forwards only when editor HTML differs; no-op guard in `handleUpdateNotes`.
  Regression test: `tests/components/right-panel-tabs.test.ts` (count updates).

### Upload + materials (B1–B3)
- Real upload panel per DDR P3-7 (no preview toggles — MUST NOT PORT respected):
  hidden input, store upload, per-file results (Submission/Input Data/Material
  chips, Replaced badge, error rows), drop-more bar, Done → close.
- Upload route reports per-file errors (`error` field) instead of aborting.
- Materials indicator fetches the real materials endpoint per assignment.

### Dashboard (C1–C2)
- Process All: real batch call with live progress (`Processing n/m…`), summary
  toast; D5 polling loop starts on load when rows are pending/executing.
- `SubmissionMeta.error` + row tooltip; error passthrough covered by tests.

### Teacher-YAML import (E1–E6)
- `import-service.ts` (parse/validate/apply: teacherGrade, status graded,
  grading.dimensions/notes/feedback, per-pair plagiarism review status via
  cache), shared grading validation, `POST /api/submissions/[id]/import`,
  client/store wrappers, header Import button (file picker, toasts, reload).

### Gate (D1) — all green at 9265d3b
- vitest 31 files / 419 passed; pytest 43; tsc clean; svelte-check 0/0;
  eslint clean; prettier clean (prettier commit `0173d23`).

### E2E (D2) — verified live against the running stack
- Upload UI (2 test notebooks → classified Pending, list refresh), Process All
  (all 5 executed; deliberate cell error captured), rubric persistence +
  restore, sentiment counts live (pos/neu/neg), notes editor typing + save,
  autofix `[Cell 3]` note survives rubric saves, student/teacher export with
  feedback, 3i import round trip (status graded, teacherGrade 85, dimensions,
  feedback restored), export guard modal (Go to review / Export anyway),
  plagiarism Accept/Undo (badge 1→0→1), Backup fires, autofix KI suggest
  returns real fix (import_fix, conf 0.95).

### Known out-of-scope / notes
- ~~Hardcoded "Executed" chip on the per-submission page header~~ **STALE — fixed in `a25a2d0`** (real `statusConfig[submission.status]` chip; the per-submission header shows the real status).
- Mobile 390px visual pass not re-run (no mobile-specific code changed in 3f).
- Imported teacher-YAML `scores` use the 0–max_points dimension scale from
  grading_config.yaml (the export writes this scale; importing 0–100 values
  clamps to slider max — by design).
