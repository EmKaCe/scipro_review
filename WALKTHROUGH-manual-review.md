# Manual Review Walkthrough — SciPro Review Copilot (Phase 3 end-state)

> **⚠️ SUPERSEDED for planning purposes (2026-08-05):** `HANDOFF-phase3g-gap-analysis.md`
> supersedes this document's "ready for full review" framing. The webapp is NOT yet a
> teacher self-service tool — the assignment selector, config loading, and setup UI are
> being fixed in Phase 3g (see `.hermes/plans/2026-08-05_phase-3g-assignment-management.md`).
> Keep this walkthrough as the **manual verification script** for the grading loop itself.

> Status snapshot: branch `phase-3b`, HEAD `0b179c4`, 17 commits ahead of origin (unpushed).
> Gate at HEAD (verified 2026-08-04): vitest **32 files / 423 passed** · pytest 43 (executor unchanged) · tsc clean · svelte-check 0/0 · eslint/prettier clean (last full run at `9265d3b`; the refactor commits since touched typing only).
> Live re-verification 2026-08-04 (stack running: executor :8766 `ki_connect_available: true`, vite :5173): dashboard + per-submission statuses real, autofix UI round-trip proven (see §9), new regression test `src/tests/components/autofix-card.test.ts` (3 tests) added.
> This doc is untracked (session convention, like `HANDOFF-phase3c.md`). The handoff doc §4/§5 remains the authoritative environment reference; this walkthrough is the manual verification script.

---

## 1. Is the webapp ready for a real grading scenario (except Copilot)?

**Yes.** Everything a teacher needs to grade a real submission end-to-end is implemented, tested, and was E2E-verified against a running stack on 2026-08-03:

upload → classify → execute (pipeline w/ LLM analysis + autofix) → review cells vs reference → mark rubric (persisted) → grade sliders (persisted) → notes (persisted) → plagiarism check + review → export student copy / teacher YAML → teacher-YAML import → backup/restore.

**Deliberately NOT built (Phase 4 boundary — expected, not missing):**
- **Copilot tab** — stub store replies "AI Copilot is not yet active" (Phase 4 = Mastra agent). Surface exists; that's the only stub you'll hit.
- **Pre-evaluate All** — button shows toast "Pre-evaluation coming in Phase 4" (by design, `submissions/+page.svelte:180`).
- **Cell markers (same/different/questionable)** — Phase 4 pre-evaluation concern; cells render without per-cell markers until then.
- **Suggest Grade / Draft Notes buttons** — switch to the Copilot tab (stub) — they exist only as tab-switch affordances.
- **No auth** — local tool by design (D4).

**Known cosmetic/edge leftovers (not blockers):**
- Imported teacher-YAML `scores` are clamped to the slider max (0–max_points scale from `grading_config.yaml`) — by design, documented.
- `results.json` on disk is a cache; the live detail page reads API state, not it.
- Mobile 390px visual pass not re-run after the 3f commits (no mobile-specific code changed).
- The docs page (`/docs`) is the static user guide (student-facing content).

---

## 2. What's built — map (for orientation)

### Stack
```
frontend/  SvelteKit 2 + Svelte 5 (ADAPTER=node, vite dev :5173)
executor/  FastAPI (uvicorn :8766) — /health, /execute, /execute/batch, /auto-fix, /execute/autofix-run
data/      assignments.yaml · criteria/ · grading_config.yaml · materials/ · submissions/ · plagiarism/  (mostly gitignored)
```

### API routes (frontend)
| Route | Purpose |
|---|---|
| `GET /api/submissions?assignment=` | list (statuses, errors) |
| `POST /api/submissions/upload` | multipart, per-file classification (`submission`/`material-data`/`material-file`) + per-file errors |
| `POST /api/submissions/process` | batch: runs pipeline for all pending |
| `GET /api/submissions/[id]` | detail + grading record |
| `POST /api/submissions/[id]/save` | grading patch (dimensions, feedback per category, notes — merges) |
| `POST /api/submissions/[id]/process` | single pipeline run |
| `GET /api/submissions/[id]/export?kind=student\|teacher` | YAML exports (student copy / teacher + plagiarism audit) |
| `POST /api/submissions/[id]/import` | teacher-YAML import (3i) |
| `POST /api/submissions/[id]/autofix` | KI suggest fix → card → copy to notes → `/execute/autofix-run` re-run |
| `GET/POST /api/plagiarism/check`, `PATCH /api/plagiarism/results` | detect + per-pair review status |
| `GET/POST /api/backup` | data-dir zip download / restore |
| `GET /api/assignments`, `GET /api/assignments/[id]/materials` | assignments + materials status |

### Teacher UI
- `/submissions` — dashboard: assignment selector, materials indicator, upload bar/panel, search/status filter, Process All (real, progress), Pre-evaluate All (stub toast), backup split-button, plagiarism modal.
- `/submissions/[id]` — review page: header (back, status chip, Generate, Reset, Import, Export split, Save), left panel (cells + execution output + reference comparison), right panel tabs (Rubric | Grading | Plagiarism | Copilot[stub]), notes card, export guard, mobile 5-tab bar.

### Student UI (unchanged Phase 2, still works)
- `/` home, `/review/[id]` peer review, `/review/[id]/evaluation` — imports student YAML, shows scores + feedback + Notes section.

---

## 3. Before you start

### 3.1 Pre-requisites
- Repo at `/root/projects/svelte-review-copilot`, branch `phase-3b` (17 local commits; nothing needs pushing for review).
- `.env` at repo root contains `KI_CONNECT_API_KEY` (name-only verified present) and `EXECUTOR_URL=http://127.0.0.1:8766`.
- `frontend/static/data/` exists (copy of `../data` — required for `/data/*.yaml` fetches; it's present).
- Executor venv: `executor/.venv` with pytest passing (43 tests).
- Test data pre-seeded (see §6).
- **KI Connect reachability varies** — the stack degrades gracefully without it: execution skips LLM steps (`llm_analysis: "skipped"`), autofix returns `{skipped: true}` with a "suggest a fix yourself" card. Everything else works offline.

### 3.2 Start the stack (three terminals)
```bash
# 0) static data copy (idempotent):
cd /root/projects/svelte-review-copilot/frontend && cp -r ../data static/

# 1) executor — terminal 1:
cd ../executor && export DATA_DIR=/root/projects/svelte-review-copilot/data \
  && export KI_CONNECT_API_KEY=$(grep -oP '^KI_CONNECT_API_KEY=\K.*' ../.env | tr -d '"') \
  && .venv/bin/uvicorn app:app --host 127.0.0.1 --port 8766

# 2) teacher app — terminal 2:
cd ../frontend && export DATA_DIR=/root/projects/svelte-review-copilot/data \
  EXECUTOR_URL=http://127.0.0.1:8766 \
  && export KI_CONNECT_API_KEY=$(grep -oP '^KI_CONNECT_API_KEY=\K.*' ../.env | tr -d '"') \
  && ADAPTER=node npx vite dev --port 5173 --host 127.0.0.1
```
Verify: `curl -s http://127.0.0.1:8766/health` → `{"status":"ok",...}`; open `http://127.0.0.1:5173/submissions` (root `/` is the student home in dev — by design).

---

## 4. Walkthrough A — Fresh end-to-end grading run (recommended core)

**Goal:** prove the whole loop on clean data. Test data: `2026SS_10` / `2026SS_11` (small, 2 cells, currently `executed`) — re-upload both to start from `pending`, or use the full pair set.

1. **Dashboard** (`/submissions`): assignment selector shows `Soil Contamination by Factories…`; 5 rows (01, 02, 03, 10, 11); statuses real (`executed`/`graded`); materials indicator shows PDF ✓ / Key ✓ / Input Data ✓. (`2026SS_38.ipynb` exists on disk but has no metadata entry, so it is not listed.)
2. **Upload panel**: click upload → drop **`2026SS_10.ipynb` + `2026SS_11.ipynb`** (from `data/submissions/soil_contamination/`) → rows appear with **Submission** kind chips; a non-`.ipynb` random file shows an **Input Data** chip (`.csv`); a bad file (e.g. a `.pdf` renamed `2026SS_99.pdf` won't classify as submission — it becomes Material; to see a per-file **error row**, use an empty/0-byte file) → Done. Rows re-listed with status `pending`.
3. **Process All**: click → progress `Processing 2/2…` → toast `Processed 2 of 2 submission(s)` → statuses `executed`. (Batch is synchronous with 2s polling; expect ~15–40 s per notebook if KI Connect is up, faster offline.)
4. **Open `2026SS_10`** → left panel shows cells + execution output (original source; `# SciPro:` annotations visible where preprocessing fired) + reference comparison (collapsed by default).
5. **Rubric tab**: expand categories, tick sub-points (sentiment counts live), add a comment, a deduction, and per-category notes.
6. **Grading tab**: move sliders — live grade updates (boundaries from `grading_config.yaml`).
7. **Notes card**: type top-level feedback (or hit **Generate** — deterministic compile of rubric+grading into editable text; then edit).
8. **Save Grade**: header Save → success toast. **Reload the page** → all rubric selections, comments/deductions, sliders, notes restored (persistence round-trip).
9. **Export**: caret → **Export teacher YAML** → `<studentId>-teacher.yaml` contains scores, feedback block, notes, `status`, timestamps; **Export (primary)** → student copy `<studentId>.yaml` — no plagiarism/status/file_name.
10. **Student loop**: copy the student YAML to your machine → open `/` (student home) → **Import** → review opens → **evaluation page** shows score, feedback, and the **Notes** section.
11. **Teacher-YAML import (3i)**: back on the submission page → **Import** → pick the `-teacher.yaml` → toast; page shows `graded` status + restored grading.
12. **Plagiarism**: dashboard → **Plagiarism** → modal lists pairs (01↔02 overlap 0.75, flagged) → open `2026SS_01` → Plagiarism tab → **Accept** (badge 1→0) → **Undo**. Now Save/Export hit the **export guard**: unreviewed pair blocks → modal "Go to review / Export anyway" → Export anyway marks remaining pairs `ignored` and proceeds.
13. **Backup**: dashboard → Backup caret → **Download backup** → zip; **Restore backup…** → re-upload it → toast `restored: N`.
14. **Console**: zero errors in devtools throughout.

---

## 5. Walkthrough B — Autofix (KI) + regression sweep

1. **Autofix**: open `2026SS_03` (has 1 failing cell + saved `[Cell 3]` autofix note) → failing cell shows the **Suggest fix** card → click (KI, ~10 s) → suggestion with confidence + patched source → **Copy to notes** → `[Cell 3] …` appears in notes card → **Save** → reload → note survives. (Offline: card shows the fallback message — expected, KI is optional.)
2. **Rubric persistence without clobber**: after the autofix note save, tick rubric items + Save Grade → `[Cell 3]` note still present (merge, not replace).
3. **Dashboard error path**: upload a deliberately broken notebook (syntax error in a cell) → Process All → row status `error` with tooltip.
4. **Student regression**: `/` home, `/review/[id]` peer review works (rubric, save to IndexedDB, export/import), `/review/[id]/evaluation` renders imported feedback + notes. Teacher-graded imports are forced read-only.
5. **Docs**: `/docs` renders (static user guide).
6. **Mobile**: narrow the window → 5-tab bar (Cells | Rubric | Grade | Plagiarism | Copilot), bottom-bar Save/Export, export guard modal still works.

---

## 6. Data state & reset recipes

**Pre-seeded (persisted from the last E2E session):**
- Submissions: `2026SS_01`, `02` (executed; 01↔02 = flagged plagiarism pair), `03` (graded; teacherGrade 85; failing cell + autofix note), `10`, `11` (executed), `38` (executed, ~4.5 MB).
- `data/plagiarism/soil_contamination.json`: 3 pairs, 01↔02 unreviewed.
- `data/materials/soil_contamination/`: `assignment_soil_contamination.pdf`, `assignment_soil_contamination_key.ipynb`, `input_data/soil_samples.csv`.

**Reset to a clean slate (optional):**
```bash
cd /root/projects/svelte-review-copilot
rm -rf data/submissions/soil_contamination data/plagiarism/soil_contamination.json
# then re-upload the notebooks from a copy, or re-add them manually via the UI.
```
To re-create a fresh submission batch: upload the notebooks under `data/submissions/soil_contamination/*.ipynb` through the UI — the API re-classifies and re-persists them.

**Caution:** Process All re-runs notebooks in a sandbox — prefer the small notebooks (10/11, 01/02/03) for the walkthrough; re-running a large real notebook takes much longer.

---

## 7. Known gaps / notes for the reviewer

| Item | Status |
|---|---|
| Copilot tab, Pre-evaluate All, cell markers, Suggest/Draft AI | Phase 4 — expected stubs, not defects |
| `results.json` cache file | informational; detail page uses API/executor |
| Teacher-YAML import score scale | 0–max_points clamp by design |
| No auth | by design (local tool) |
| `phase-3b` 17 commits unpushed | nothing needed for review; push when ready |
| Hardcoded anything left? | No — status chip now real (`statusConfig[submission.status]`) |

**If something fails during review**, capture: devtools console + network tab (which endpoint, status), and check the executor logs. The most common false alarm is KI Connect being down — the app is designed to degrade, so a "skipped" autofix/analysis is expected offline, not a bug.

---

## 8. Live verification evidence (2026-08-04)

Ran against the real stack while preparing this walkthrough:

| Check | Result |
|---|---|
| `GET /health` (executor) | `{"status":"ok","version":"0.3.0","ki_connect_available":true}` |
| `GET /api/submissions?assignment=soil_contamination` | 5 rows with real statuses (`executed`×4, `graded`×1 — `2026SS_38.ipynb` is on disk but has no metadata entry, so it is not listed) |
| Dashboard (browser) | 5 rows listed, statuses real, Plagiarism badge `1`, materials `PDF/Key/Data` |
| Per-submission header chip | `2026SS_01` → **Executed**, `2026SS_03` → **Graded** — real `statusConfig[submission.status]`, NOT hardcoded (the handoff §7 "deferred" note is stale; fixed in `a25a2d0`) |
| `POST /api/submissions/2026SS_03/autofix` (curl + in-page fetch) | 200, real KI suggestion: `import_fix`, confidence 0.95, `patchedSource` with the fix |
| Executor logs | two browser-triggered `/auto-fix` calls, each with a live KI Connect round-trip (200) |
| `src/tests/components/autofix-card.test.ts` (new) | 3/3: unavailable state → suggestion renders (summary, Copy to notes, Confidence 95%) → error note on rejection. This fills the missing L4 coverage for the autofix UI round-trip |

**Note on browser automation:** during live clicking, the automation's accessibility tree went stale (later clicks on the "Suggest fix" ref stopped reaching the executor, console evaluated in `about:blank`). The app itself is fine — proven by the component test + curl + executor logs above. When reviewing manually you will not hit this.

## 9. After review

- Gate to re-run before any push: `unset ADAPTER NODE_ENV KI_CONNECT_API_KEY; pnpm vitest run` → executor `pytest -q` (unset the API-key/port vars too) → `npx tsc --noEmit -p tsconfig.json` → `pnpm check` → `npx eslint .` → `npx prettier --check .`.
- Next phase: Phase 4 (Mastra copilot + pre-evaluation). The 3f plan doc (`2026-08-03_phase-3f-remainder.md`) and `refined-master-plan.md` (D6) are the starting points.

## 10. Phase 3g additions (2026-08-05) — assignment & data management

Live-verified against the running stack (see `.hermes/plans/2026-08-05_phase-3g-assignment-management.md`):

1. **Assignment selector is live**: dashboard dropdown lists `GET /api/assignments` (Soil Contamination + Atom Interaction + any created); first enabled is the default; empty state shows "No assignments configured".
2. **`/settings/assignments`** (linked as "Manage Assignments" in the dashboard action bar): create (id/title/enabled/criteria files/dimensions), edit, delete (409-guarded when submissions exist), criteria YAML upload with schema + general.yaml-collision validation.
3. **Config serves from DATA_DIR**: `GET /api/config/criteria?assignment=<id>` (merged rubric; 404 unknown / 500 corrupt) and `GET /api/config/grading`; the teacher build no longer depends on the static copy — deleting `static/data/criteria/*.yaml` does not break the rubric.
4. **Materials manager** now has "Upload materials" (PDF / key / input-data via `POST /api/assignments/[id]/materials`) with per-file result rows.
5. **Error surfacing**: dashboard `ConfigErrorBanner` (dismissible) + per-submission rubric notice when the rubric is null — no silent nulls.
6. **Multi-assignment E2E**: switch to Atom Interaction → 0 submissions (isolated), plagiarism badge clears, rubric loads from DATA_DIR (11 categories incl. `valid_values`, `pandas`, `plotting_data`), materials upload lands in `input_data/`.
