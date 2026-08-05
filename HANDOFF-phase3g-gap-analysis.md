# Handoff — Post-Review Gap Analysis: Assignment & Criteria Management, and the Path to Phase 4

> **✅ RESOLVED (2026-08-05):** All six issues below were fixed in Phase 3g
> (commits `87b6af5`..`822ba42` on `phase-3b`, plan `.hermes/plans/2026-08-05_phase-3g-assignment-management.md`).
> Live-verified against the running stack: selector shows both enabled assignments,
> `/settings/assignments` create + criteria upload + delete work, materials upload
> works, rubric serves from DATA_DIR via `/api/config/criteria`. Gate at completion:
> vitest 43 files / 503 tests · pytest 43 · tsc · svelte-check 0/0 · eslint · prettier.
> This doc remains the planning baseline for the **next iteration (Phase 4 prerequisites)**.

> Status snapshot: branch `phase-3b`, HEAD `0b179c4`, 17 commits ahead of origin (unpushed).
> **Uncommitted work in tree** (this session, 2026-08-04): archive/delete lifecycle + materials management — 15 modified, 6 new files, ~608 insertions. Gate green at HEAD+work: vitest 439 · pytest 43 · tsc · svelte-check 0/0 · eslint · prettier. The stack (vite :5173, executor :8766, KI available) is running.
> This document is the **baseline for planning the next iteration** — it supersedes the "ready for review" framing of `WALKTHROUGH-manual-review.md` where they conflict. Keep both docs; this one is the planning source of truth.

---

## 1. TL;DR

The webapp is **not yet ready to be the primary tool for a real grading scenario**, despite the 3f feature work being complete. The blockers are not in the grading loop itself (upload → execute → review → rubric → grade → export works) — they are in **assignment setup and data management**, which a teacher must do before any grading can start:

1. **The assignment selector is a hardcoded Phase 2 stub** — new assignments added to `assignments.yaml` never appear in the UI. (Root cause: selector ignores `GET /api/assignments`.)
2. **There is no assignment creation/configuration UI** — assignments, criteria, and grading config are hand-edited YAML files requiring shell access.
3. **Criteria loading has a static-copy trap** — the client fetches from `frontend/static/data/` (a `cp -r` copy), so new criteria silently fail unless the copy is refreshed; no error surfaces.
4. **Materials upload is indirect** (generic upload panel + filename classification) and there's no dedicated assignment-materials setup flow.

Additionally, this session's archive/delete/materials work is **uncommitted** — the next iteration's first action is to commit it (or deliberately defer it).

---

## 2. What is verified working (the review baseline)

### 2.1 Grading loop — works end-to-end
Verified live 2026-08-04 against the running stack (see `WALKTHROUGH-manual-review.md` §8):
- Upload (real classification, per-file errors), Process All (real batch + polling), pipeline execution (preprocess → LLM analysis → sandbox → autofix re-run), real KI Connect (`ki_connect_available: true`).
- Per-submission review: real status chip (`statusConfig[submission.status]` — the old "hardcoded Executed" note in HANDOFF-phase3c §7 is stale, fixed in `a25a2d0`), rubric persistence (checkbox/comment/deduction/notes + sliders, save/restore), notes editor, Generate/Reset.
- Autofix UI round-trip proven (new `autofix-card.test.ts`); export split (student copy / teacher YAML), 3i teacher-YAML import, plagiarism review + export guard, backup/restore.

### 2.2 New this session (archive/delete + materials management) — works, uncommitted
- `archived` status (soft, restorable): hidden from default list/Process All/plagiarism; pre-archive status remembered; plagiarism pairs → `ignored` on archive, `unreviewed` on restore.
- `DELETE /api/submissions/[id]`: metadata + notebook + results + plagiarism pairs removed.
- `GET /api/submissions?includeArchived=1`; dashboard filter + row actions (Archive / Restore / Delete with type-to-confirm).
- Materials: `DELETE /api/assignments/[id]/materials?name=` + clear-all, materials manager panel (list/delete per file, live status), clickable indicator.
- Gate: vitest 439, pytest 43, tsc, svelte-check 0/0, eslint, prettier.

---

## 3. Issues to systematically address (ordered by impact)

### Issue 1 — Assignment selector is a hardcoded stub (BLOCKER)
- **Symptom:** the dashboard dropdown only offers `soil_contamination` + a disabled placeholder `A1 — Web-Konzeption` (`frontend/src/lib/components/submissions/assignment-selector.svelte:19-23`, comment: "Phase 2 stub: hardcoded from assignments.yaml structure").
- **Root cause:** the selector never calls `GET /api/assignments` (which exists and returns enabled assignments from `assignments.yaml`); `selected` even defaults to the string `"soil_contamination"`.
- **Impact:** a teacher cannot select a second assignment, so multi-assignment grading is impossible from the UI even though the backend fully supports it (all routes resolve assignments server-side, `assignments.ts` re-reads the registry per request).
- **Fix direction:** replace the hardcoded array with a live fetch (loading/error states), default to the first enabled assignment from the API.

### Issue 2 — No assignment creation/configuration UI (BLOCKER for onboarding)
- **Symptom:** to add an assignment a teacher must: (a) hand-edit `data/assignments.yaml` (id, title, `criteria_files`, `dimensions`), (b) hand-write schema-compliant criteria YAML under `data/criteria/` (see `.github/references/schemas/criteria-schema.md`), (c) hand-edit `data/grading_config.yaml` (dimension keys must match the assignment's `dimensions`), (d) refresh the static copy, (e) restart/cache-bust. Errors in any of these fail silently (client) or 500 (server).
- **Root cause:** assignment/criteria/config management was never scoped in Phase 2/3 — the teacher workflow map (`2026-07-27_teacher-workflow-map.md`) starts at "upload submissions" and has no assignment-setup stage.
- **Impact:** the app is only usable by the developer who set up the data directory. Any new course/semester requires manual data surgery.
- **Fix direction (proposed):** a setup/management surface that creates/edits assignments (form → writes `assignments.yaml`), uploads+validates criteria YAML files, and manages grading config; plus server-side serving of criteria (see Issue 3).

### Issue 3 — Criteria loading has a static-copy trap (data-integrity risk)
- **Symptom:** `criteria-loader.ts` fetches `data/assignments.yaml` + `data/criteria/*.yaml` over HTTP from the **static** dir (`frontend/static/data/`, a `cp -r ../data static/` copy). New/changed criteria are invisible until the copy is refreshed. In Docker the copy is baked at build time.
- **Root cause:** Phase 2 used the static-data pattern for the student app; Phase 3 kept it for teacher-side criteria while submissions/materials moved to live filesystem routes. Divergent data paths.
- **Impact:** a teacher adding criteria via any new UI would still hit stale caches (`criteria-loader` caches in memory, `loadAssignments` caches the registry) and silent `null` rubric on fetch failure.
- **Fix direction:** serve criteria/assignments/grading-config through an API route reading `DATA_DIR` (like `assignments.ts` does server-side), add cache-bust/reload, and surface load errors in the UI instead of silent nulls.

### Issue 4 — Materials upload UX is indirect
- **Symptom:** there is no dedicated "upload assignment materials" affordance; the teacher uploads PDF/key/data through the generic submissions upload panel, and classification is by filename pattern (`file-service.ts`: pdf → materials root, `key.ipynb` → materials root, csv/xlsx/etc → `input_data/`). Wrong extension ⇒ wrong destination, silently.
- **Root cause:** the architecture skill documents 4 dedicated drop zones (Assignment PDF / Key / Input Data / Submissions) — never implemented; the unified panel shipped instead.
- **Impact:** usable for a developer who knows the convention; confusing for a teacher (e.g. a `.pdf` named data file lands in materials root, not input_data).
- **Fix direction:** either a materials-specific upload flow with explicit kind selection, or kind-override affordances in the existing panel (the API already supports `kinds` overrides — the UI doesn't expose them).

### Issue 5 — Uncommitted archive/delete/materials work
- **Symptom:** 15 modified + 6 new files from this session are uncommitted.
- **Root cause:** session work not committed (per repo convention the assistant does not commit without request).
- **Impact:** work is at risk and invisible to the next session's git-based planning; also `HANDOFF-phase3c.md` / `WALKTHROUGH-manual-review.md` are untracked session docs that should be updated or superseded.
- **Fix direction:** commit as `feat(phase-3g): archive/delete lifecycle + materials management` (or deliberate split) — first action of the next iteration.

### Issue 6 — Stale/overlapping docs
- `HANDOFF-phase3c.md` (§7) still lists the status chip as deferred — stale since `a25a2d0`.
- `WALKTHROUGH-manual-review.md` claims "ready for full review" — superseded by this analysis for planning purposes.
- `2026-07-29_phase-3-execution-and-data.md` phase labels (3a–3i) vs git labels (`phase-3b`/`phase-3c`) mismatch is documented but still confusing; future commits should use plan-aligned labels (e.g. `phase-3g`).
- **Fix direction:** update or mark superseded; consider a short "current state" section in the master plan.

---

## 4. What needs to be further explored

1. **Assignment lifecycle semantics.** What happens to an assignment's submissions/materials when the assignment is disabled or removed? Is there a need to archive *assignments* (not just submissions)? Does `assignments.yaml` get a `disabled` flag UI? (Proposal: mirror the submission archive pattern; assignments are cheap to keep enabled=false.)
2. **Criteria schema authoring UX.** Do teachers write criteria from scratch in the UI, or upload YAML validated against the schema? How much of the criteria schema (categories, sentiments, sub-points, comments/deductions flags, additional_notes) should the UI expose? (The schema exists — `.github/references/schemas/criteria-schema.md`.)
3. **Static-data architecture.** For the teacher build, should *all* config (assignments, criteria, grading_config) move to live API routes, leaving the static copy only for the student build? What about the student app's dependency on `data/assignments.yaml` + criteria over HTTP (it needs them for peer review)? (Probably keep static for student, API for teacher — but verify the student build's paths.)
4. **Materials kind override UX.** Given the API already supports `kinds` overrides and the classification rules are filename-based, is the right fix a dedicated materials upload UI or explicit kind dropdowns in the existing panel? Check the DDR/OD mockups for prior decisions (the 4-zone design was in the architecture skill).
5. **Multiple assignments end-to-end.** There's currently only one real enabled assignment (`soil_contamination`); `atom_interaction`, `molecular_dynamics`, `quantum_chemistry` exist in YAML (some disabled). Worth testing a second enabled assignment end-to-end once the selector is live (criteria loading, materials scoping, plagiarism scoping, per-assignment metadata.json/results.json isolation).
6. **Error surfacing.** Client criteria-loader returns `null` on fetch failure silently; assignment registry YAML errors 500 server-side. Decide the error model for config load failures (toasts? dashboard banner?).
7. **Backup/restore interplay.** Does the backup zip include `assignments.yaml`/`grading_config.yaml`/`criteria/` (it should — D10 says the whole data dir) and does the new materials DELETE/clear interact correctly with a restore? (Verify; likely fine since backup is a zip of DATA_DIR.)
8. **Phase 4 boundary.** Copilot/pre-evaluation remain Phase 4. But Issue 1–3 are prerequisites for Phase 4 to be usable on real data — the plan should sequence them before or alongside the Mastra work, not after.

---

## 5. How this changes the plans

### The next iteration's scope shifts from "polish the grading loop" to "assignment & data management"

The prior baseline (WALKTHROUGH + HANDOFF-phase3c) treated Phase 3f as the finish line. This analysis shows the **real blocker for a teacher to adopt the tool is setup**, not the review UX. The next plan should therefore be a **Phase 3g: Assignment & Data Management** (name to align with plan labels), roughly:

| Priority | Item | Depends on |
|---|---|---|
| 0 | Commit the archive/delete/materials work + update/retire stale handoff docs | — |
| 1 | Live assignment selector (Issue 1) | — |
| 2 | Server-side criteria/config serving + client reload + error surfacing (Issue 3) | — |
| 3 | Assignment creation/configuration UI (Issue 2) | 1, 2 |
| 4 | Materials upload UX (dedicated flow or kind overrides) (Issue 4) | 1 |
| 5 | Explore: assignment archive/disable, criteria authoring depth, multi-assignment E2E | 1–4 |
| — | Phase 4 (Copilot/pre-evaluation) | after 1–3 (it needs a usable multi-assignment setup) |

### Re-baseline the "ready" claim
- The app is ready for **developer-driven single-assignment grading** (everything in §2.1 works).
- It is **not ready for teacher self-service**: assignment setup, criteria management, and multi-assignment switching are missing or stubbed.
- Update `WALKTHROUGH-manual-review.md` and `HANDOFF-phase3c.md` accordingly (or mark them superseded by this handoff).

### Open decisions for the planning session
1. Scope of the assignment management UI: full form-based creation vs. YAML upload with validation vs. both?
2. Criteria authoring: in-UI editor vs. validated YAML upload (recommend: validated upload first, editor later).
3. Static vs API config serving for the teacher build (recommend: API for teacher; keep static for student; verify student paths).
4. Whether to include assignment-level archive/disable in 3g or defer.
5. Whether to run a second enabled assignment E2E as an acceptance gate for 3g.

---

## 6. Environment & toolchain facts (do not rediscover)

- **Tests:** `frontend/src/tests/` (vitest, jsdom default). Run with `unset ADAPTER NODE_ENV KI_CONNECT_API_KEY` before vitest/pytest — `.env` sets `ADAPTER=node NODE_ENV=production` and breaks jsdom tests.
- **Gate:** `pnpm vitest run` → executor `.venv/bin/python -m pytest -q` (unset `PORT EXECUTOR_URL EXECUTOR_PORT EXECUTOR_LOG_LEVEL KI_CONNECT_BASE_URL KI_CONNECT_API_KEY COMPOSE_PROJECT_NAME` too) → `npx tsc --noEmit -p tsconfig.json` → `pnpm check` (svelte-check 0/0) → `npx eslint .` → `npx prettier --check .`.
- **Stack (currently running):** executor `uvicorn app:app --port 8766` (DATA_DIR=repo/data, KI key from .env); teacher `ADAPTER=node npx vite dev --port 5173` (DATA_DIR, EXECUTOR_URL=http://127.0.0.1:8766, KI key); `cp -r ../data static/` first for static-data fetches. Student home is `/` (root), teacher app is `/submissions` (production redirect only).
- **Test data:** 5 submissions (01/02 = plagiarism pair, 03 graded, 10/11 executed, plus leftover `2026SS_75` pending), materials (PDF, key, input_data incl. `soil_samples.csv`, `CybulskiT1999_Ar2.csv`), plagiarism cache with pairs.
- **New `.svelte.ts` stores:** import with explicit `.svelte.js` extension; `SvelteMap`/`SvelteSet` from `svelte/reactivity` (eslint rule); lucide-icon classes need `:global()` to avoid unused-CSS warnings.
- **Route tests with multipart/binary:** `// @vitest-environment node` (jsdom Blob/FormData break undici round-trips).
- **Executor endpoints:** `POST /auto-fix` (hyphen), re-run `/execute/autofix-run`; health `/health`.
- **Plans dir:** `.hermes/plans/` is gitignored/untracked (deliberate, commit `6ab9060`). `refined-master-plan.md` = durable decisions (D9 export split, D10 backup); `2026-07-29_phase-3-execution-and-data.md` = sub-phase breakdown.

---

## 7. Suggested next iteration plan skeleton (for the planning session)

**Phase 3g — Assignment & Data Management**
- Task 0: commit uncommitted work; update/retire stale docs.
- Task 1: live assignment selector (fetch `GET /api/assignments`, loading/error, default first enabled).
- Task 2: API routes for assignments/criteria/grading-config reads from DATA_DIR; client switch from static to API; cache reload + error surfacing.
- Task 3: assignment setup UI (create/configure assignment; upload+validate criteria YAML; grading-config view).
- Task 4: materials upload UX (dedicated materials drop zones or kind overrides).
- Task 5: assignment archive/disable + multi-assignment E2E (second enabled assignment).
- Gate after each task; acceptance = a teacher can add a new assignment, upload its materials + criteria, and grade submissions end-to-end from the webapp.
