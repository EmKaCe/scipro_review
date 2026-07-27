# Grading Copilot — Mastra-Powered AI Assistant for SciPro Review

> **Status:** Implementation plan. 5 phases, sequentially dependent. Each phase → GitHub issues → subagent dispatch.
>
> **Gaps requiring your input are marked `[GAP: ...]` throughout.**

---
## Vision

A teacher grading 30+ programming submissions during exam season should be able to:

1. **Drop files in a folder** — student `.ipynb` files + the reference solution (key) that Karl provides
2. **Run one command** — `docker compose up`
3. **Walk away** — the system auto-executes every notebook, applies LLM-guided fixes to broken cells, captures outputs, and pre-evaluates each submission against the reference solution + rubric
4. **Come back to a queue** — dashboard showing all submissions with status icons, pre-evaluation grades, and flags for divergent outputs
5. **Review one by one** — for each submission: see the executed notebook with cell outputs and auto-fixes annotated, rubric pre-filled with suggested scores, and buttons to refine grades or draft notes
6. **Ask questions** — chat with an agentic copilot about tricky submissions
7. **Finalize** — accept/reject suggestions, override scores, save the final grade

The teacher stays in control at every step. Nothing is auto-graded without review.

---

## Core Design Decisions (ground truth for all phases)

These decisions are the foundation. Any code change, test scenario, or bug report must be consistent with them.

### Grading is teacher-only

- **Grading (dimension sliders, grade calculation) is exclusively a teacher action.** Students never assign grades to each other.
- In the student-facing static build (GitHub Pages): grading sliders are **never interactive**. They only appear when pre-existing grading data was imported (e.g., a teacher-graded review), and are always disabled/read-only.
- In the teacher-facing build (Docker, `ADAPTER=node`, Phase 2+): grading sliders are interactive and fully functional.

### Student peer-review workflow

1. Student A reviews Student B's notebook submission using the rubric (checkboxes, comments, deductions)
2. Student A exports their review as YAML
3. Student A uploads the YAML to the teacher (anonymized — teacher handles distribution)
4. The teacher distributes reviews to the reviewed students
5. Student B imports the YAML to read the feedback

**No server, no accounts, no authentication.** All data is client-side (IndexedDB) and transferred via exported files through the teacher.

### Import read-only behavior

| Scenario | Default | Override |
|----------|---------|----------|
| Import without grading values (student's own export) | Read-only (checkbox checked) | User can uncheck "Import as read-only" to edit, or click the Edit button after import |
| Import with grading values (teacher-graded review) | **Forced read-only** | Cannot override — Edit button is hidden |

This ensures grading integrity while allowing students to continue working on their own exports.

### One SvelteKit app, two build modes

```
svelte_review/                          ← single repo, single SvelteKit app
├── frontend/src/
│   ├── routes/
│   │   ├── +page.svelte       │ shared │ (landing page)
│   │   ├── review/            │ shared │ (peer review rubric, sliders)
│   │   ├── submissions/       │ teacher │ (dashboard, per-submission review)
│   │   ├── settings/          │ shared │
│   │   └── api/               │ teacher │ (server routes — tree-shaken in static build)
│   ├── lib/components/
│   │   ├── review/            │ shared │
│   │   ├── submissions/       │ teacher │ (execution output, pre-evaluation)
│   │   └── copilot/           │ teacher │ (chat panel, Phase 4)
│   └── mastra/                │ teacher │ (tree-shaken in static build)
├── executor/                  │ teacher │ (separate Docker container)
└── data/                      │ shared │ (assignment YAMLs, grading config)
```

**Build via environment variable:**

```bash
ADAPTER=static pnpm build   → GitHub Pages (student peer review — unchanged)
ADAPTER=node  pnpm build   → Docker image   (teacher mode)
```

When `ADAPTER=static`: SvelteKit tree-shakes all `+server.ts` routes, `submissions/` pages, all Mastra code, and copilot components. Output is identical to today — zero change for students.

When `ADAPTER=node`: everything is live. API routes handle batch processing, LLM calls, agent streaming. The teacher UI renders alongside the shared review components.

**No duplicated code, no second repo, no second SvelteKit app.** Teacher-only UI is additive — new routes and components sit next to existing ones.

### What the assignment key changes

With Karl's reference solution executed alongside student submissions, the pre-evaluation is grounded in expected behavior — not the LLM's guess of what "correct" looks like. Diverging cell outputs can be flagged precisely. The LLM's suggestions reference actual deviations from the expected result.

---
## Batch upload model (drag-drop, not mounted volume)

The teacher uploads `.ipynb` files through the browser — cleaner UX than mounting a host directory. Uploaded files are stored inside the Docker container in a persistent volume (not the host filesystem directly) to avoid permission issues.

```
Browser upload (.ipynb files)
    │
    ▼
POST /api/submissions/upload  →  saves to /app/uploads/  (Docker volume)
    │
    ▼
POST /api/submissions/process →  orchestrator:
    ├── Detect assignment-key.ipynb → execute → cache as reference
    ├── For each student .ipynb → execute → auto-fix → store
    └── Reference + student outputs ready for review
```

**Why not a mounted volume:** Mounting the `submissions/` directory from the host into the container causes permission headaches — the files need to be readable by the non-root `executor` user inside the container, but the host user owns them. The Docker volume approach avoids this entirely: inside the container, all uploads are owned by the correct user.

The teacher can still access their uploaded files via the web app (download original, download executed) or via `docker cp` if they need shell access. Uploaded files persist in the volume between container restarts.

**[GAP: Upload persistence — do you want a host-accessible directory regardless?]**
If you want to be able to `ls ./uploads/` on your host and see the raw `.ipynb` files, we can use a bind mount with an init script that fixes permissions (`chown 1000:1000`). The cleaner approach is Docker named volumes (no permission issues, but not directly browseable from the host). Which do you prefer?

---

## Architecture

```
                    Browser
                    │ teacher drag-drops .ipynb files
                    ▼
┌────────────────────────────────────────────────────────────────────┐
│  SvelteKit Server (adapter-node, :8765)                             │
│                                                                      │
│  Upload & Submissions API:                                          │
│  POST /api/submissions/upload    → save files to /app/uploads/      │
│  GET  /api/submissions           → list all + statuses              │
│  POST /api/submissions/process   → batch execute + auto-fix         │
│  POST /api/submissions/pre-eval  → batch LLM pre-evaluation         │
│  GET  /api/submissions/[id]      → single detail                    │
│                                                                      │
│  LLM-Assisted API (Phase 4):                                        │
│  POST /api/suggest-grade         → single LLM call per dimension    │
│  POST /api/draft-notes           → single LLM call                  │
│  POST /api/autofix               → LLM fix for one cell             │
│                                                                      │
│  Agentic API (Phase 4):                                             │
│  POST /api/chat                  → Mastra agent.stream()            │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │  Mastra Agent                                                │    │
│  │  • Tools: suggest-grade, draft-notes, get-submission-context  │    │
│  │  • Memory for conversation persistence                       │    │
│  │  • System prompt referencing rubric + reference + execution  │    │
│  └────────────────────────────────────────────────────────────┘    │
│                                                                      │
│  /app/uploads/ (persistent Docker volume)                            │
│  ├── assignment-key.ipynb                                           │
│  ├── 2026SS_03.ipynb                                                │
│  ├── 2026SS_07.ipynb                                                │
│  └── submissions.json (metadata store)                              │
└──────────────────────────┬─────────────────────────────────────────┘
                           │ http://executor:8766
┌──────────────────────────▼─────────────────────────────────────────┐
│  executor (Python, internal network only)                           │
│                                                                      │
│  POST /execute       → execute a notebook (JSON body)              │
│  POST /execute/file  → execute notebook from a file path            │
│  POST /execute/batch → scan directory, process all .ipynb files    │
│                                                                      │
│  • Cell-by-cell execution with 30s per-cell timeout                 │
│  • try/finally kernel cleanup (never leak)                         │
│  • queue.Empty catch (correct timeout exception type)               │
│  • No auto-fix logic — pure execution only                         │
│  • Non-root user (uid 1000), no published ports                    │
│  • Shares /app/uploads volume with SvelteKit server                │
└────────────────────────────────────────────────────────────────────┘
```

---

## Phase 0: Audit Current main Branch ✅ COMPLETED

**Goal:** ✅ Verified the current student peer-review app works correctly. Blocking bugs fixed, clean baseline confirmed.

Before any development, walk through every user-facing flow in a real browser (Chromium) and log what breaks.

**Files:** None (testing only)

**Runbook:**

1. Clone clean `main` branch to a test directory
2. `cd frontend && pnpm install && pnpm dev`
3. Open in Chromium at `localhost:5173`
4. Walk through each scenario:

| Scenario | What to check |
|---|---|
| Landing page loads | Saved reviews list renders, empty state shown if none exist |
| Start new review | Select assignment → rubric loads with categories |
| Rubric interactions | Check boxes across positive/neutral/negative categories, add comments, set deductions |
| Grade sliders | Adjust dimension scores → grade result updates live |
| Generate evaluation | Click "Generate" → markdown text appears in preview |
| Save review | Save → appears in saved reviews list on landing page |
| Load saved review | Click saved review → rubric state restores correctly |
| Export YAML/MD/JSON | Download files, re-import them, verify round-trip |
| Settings page | Mode toggle, theme switch, about card all render |
| Import legacy format | Upload a v1 flat JSON file → converts to v2 format |
| Mobile viewport | 375px width — layout doesn't break, sheets work |

**Deliverable:** A GitHub issue listing any bugs found, prioritized (blocking / major / cosmetic). Fix blocking bugs before proceeding to Phase 1.

---
## Phase 1: Clean Separation — Remove Legacy Teacher Mode ✅ MERGED (PR #7)

> **Status:** ✅ **Merged to `main` via PR #7 on 2026-07-27.** All 14 tasks executed, 215/215 tests passing, both builds verified. Runtime mode toggle removed, dual-adapter build operational.

The mode toggle currently lives in these locations — remove all of them:

- **Mode card in Settings** — `settings/mode-card.svelte` (contains the Alt+Shift+G keybinding). Delete the file.
- **Settings page** — remove `<ModeCard />` import and rendering
- **Settings store** — remove `mode` field (`getMode()`/`setMode()`/localStorage sync)
- **ReviewStore** — remove `mode` state field; `toSession()` hardcodes `"student"` for backward compat
- **GradingSidebar component** — remove `mode` prop, `onToggleMode` callback, mode toggle button
- **`ReviewMode` type** — remove from `session.ts` (keep `mode: string` in `ReviewSession` for persisted data compat)
- **Import logic** — replace mode-based read-only gating with `hasGradingValues` check (teacher-graded imports locked, student exports editable via checkbox)
- **Evaluation page** — replace `isTeacher` gate with `gradeResult` check
- **Docs** — remove "Teacher Mode" section from nav and content; remove Alt+Shift+G shortcut reference; keep general shortcuts

### Dual-adapter build

- Rewrite `svelte.config.js` for `ADAPTER=static`/`ADAPTER=node` env var switching
- Add `@sveltejs/adapter-node` to `devDependencies`
- Default is `ADAPTER=static` for backward compatibility with GitHub Pages deploy

### Verify tree-shaking

After cleanup:
- `ADAPTER=static pnpm build` → inspect output: no submissions/ or api/ routes exist
- `ls frontend/build/` → only the expected page chunks
- Run Phase 0 scenarios again in the static build, skipping mode-dependent scenarios (4, 8.5-8.7, 12, 13.7-13.9) — all remaining student flows unchanged
**Files to modify (Phase 1):**
| File | Change |
|---|---|
| `frontend/src/routes/settings/+page.svelte` | Remove ModeCard import and rendering |
| `frontend/src/lib/components/settings/mode-card.svelte` | **Delete** (contains Alt+Shift+G keybinding) |
| `frontend/src/routes/+layout.svelte` | Remove `void settings.mode` from sync effect |
| `frontend/src/routes/+page.svelte` | Remove mode sync from import/open handlers, remove `settings` import |
| `frontend/src/lib/stores/settings.svelte.ts` | Remove `mode` field, `getMode()`, `setMode()`, localStorage sync |
| `frontend/src/lib/stores/review.svelte.ts` | Remove `mode` state field, simplify `toSession()`/`reset()` |
| `frontend/src/lib/types/session.ts` | Remove `ReviewMode` type, keep `mode` as `string` for compat |
| `frontend/src/lib/types/index.ts` | Remove `ReviewMode` from barrel export |
| `frontend/src/lib/components/grading-sidebar.svelte` | Remove `mode` prop, `onToggleMode`, mode toggle button |
| `frontend/src/routes/review/[id]/+page.svelte` | Remove mode-derived state, simplify GradingSidebar usage, simplify import read-only |
| `frontend/src/routes/review/[id]/evaluation/+page.svelte` | Remove `isTeacher`, gate grading summary by `gradeResult` |
| `frontend/src/routes/docs/+page.svelte` | Remove `isTeacher`, remove teacher-mode from nav |
| `frontend/src/lib/components/docs-sidebar.svelte` | Remove mode-gating, remove teacher-mode from nav items |
| `frontend/src/lib/components/docs-content.svelte` | Remove mode-toggle callout, remove Alt+Shift+G from shortcuts |
| `frontend/src/lib/services/validation.ts` | Relax `reviewMode` to `z.string()` for backward compat |
| `frontend/src/tests/stores/review.store.test.ts` | Remove `reviewStore.mode` assertion |
| `frontend/src/tests/services/validation.test.ts` | Update mode validation test |
| `frontend/svelte.config.js` | Dual-adapter (ADAPTER=static\|node), default static |
| `frontend/package.json` | Add `@sveltejs/adapter-node` dep |

**Verification:**
- `pnpm check` — 0 errors
- `pnpm test` — all tests pass (update tests that reference removed code)
- `ADAPTER=static pnpm build` — builds cleanly
- Re-run Phase 0 scenarios skipping mode-dependent tests — all student flows unchanged

---
## Phase 2: Teacher UI — Dashboard + Review Page with Stubs
**[RESOLVED: Named volume + webapp file management — see Gaps Summary for details.]**

**[RESOLVED: Open Design tool — installed at /home/em/Projects/open-design/, Docker Compose ready. Teacher UI is designed in Open Design first (Phase 2b), then implemented in SvelteKit (Phase 2c).]**

**[RESOLVED: TanStack Svelte Table beta — use `@tanstack/svelte-table@9.0.0-beta.58` (Svelte 5 required). Search, sort, semester filter. See dashboard spec below.]**

## Phase 2 Sub-phases

### Phase 2a: Scope Definition

This phase defines the scope of the teacher UI — what's included in the dashboard, submission review page, and stub data layer. The scope is captured in the detailed specification below and the file manifest. All implementation happens in Phase 2c after design mockups are completed in Phase 2b.

### Phase 2b: Design in Open Design

The teacher UI mockups are designed in [Open Design](https://github.com/nexu-io/open-design) first.

- **Tool:** Open Design (nexu-io/open-design), a local-first design tool
- **Installation:** `/home/em/Projects/open-design/`, runs via Docker Compose
- **What's designed:**
  - Submissions dashboard layout and table mockup
  - Per-submission review page (two-panel layout)
  - Upload panel (compact and full-page variants)
- **Process:** Mockups prototyped and reviewed in Open Design, then implemented in SvelteKit in Phase 2c
- **Deliverable: Design Decision Record (DDR):** After mockups are approved, all visual decisions are captured in a markdown document. The DDR becomes the **sole visual spec** for Phase 2c — layout, colors, spacing, component structure, responsive rules, token mappings, and stub button behavior. If any earlier spec (including items below) conflicts with the DDR, the DDR wins.

### Phase 2c: Implementation

Implementation follows the mockups created in Phase 2b. All technical specifications below use TanStack Svelte Table for the dashboard, stub data services, and the existing app's OKLCH design tokens.

┌──────────────────────────────────────────────────────────────────┐
│  Submissions (12)                                 + Upload Files │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │  Drag & drop .ipynb files here, or click to browse        │    │
│  └──────────────────────────────────────────────────────────┘    │
│                                                                   │
│  [Semester: All ▼]  [Search by student ID...]  Filter icon       │
│                                                                   │
│  ┌───────┬──────────┬──────────┬──────────┬──────────┬────────┐  │
│  │Student│ Status   │ Cells    │ Pre-Eval │ Your     │ Actions│  │
│  │  ID   │          │ Diff     │ Grade    │ Grade    │        │  │
│  ├───────┼──────────┼──────────┼──────────┼──────────┼────────┤  │
│  │03     │ ✅ Done  │ cell 5,7 │    2.3   │    —     │ [Open] │  │
│  │07     │ ⚠️ Fixed │ none     │    1.7   │    2.0   │ [Open] │  │
│  │12     │ ❌ Error │ —        │    —     │    —     │ [Open] │  │
│  │15     │ ⏳ Pend.  │ —        │    —     │    —     │   —    │  │
│  └───────┴──────────┴──────────┴──────────┴──────────┴────────┘  │
│                                              Rows per page: 25 ▼  │
│                                                                   │
│  ☐ Select: All │ None  [Archive] [Delete] [Download All]        │
│                                                                   │
│  📁 Archived (3)                                        [Expand] │
└──────────────────────────────────────────────────────────────────┘
```

Columns sortable by clicking headers. Search filters in real-time. Semester filter mirrors the existing pattern from `reviews-table.svelte`.

### What to build

**1. Submissions dashboard**

Route: `/submissions/`
Component: `frontend/src/lib/components/submissions/submissions-dashboard.svelte`

A table listing all uploaded submissions:

| Column | Content |
|---|---|
| Student | Student ID (from filename) |
| Status | pending / executing / executed / error / pre-evaluated / graded |
| Reference diff | Cell-level divergence summary (cells that differ from key) |
| Pre-eval grade | LLM-suggested grade (stub: shows "—" initially) |
| Your grade | Teacher's final grade input |
| Actions | [Review] button |

Layout: consistent with the existing app's table styles (see `reviews-table.svelte` for reference — same OKLCH colors, same typography, same spacing scale).

Empty state: if no submissions uploaded, shows a drag-drop area (Phase 3 will wire this).

**[RESOLVED: Dashboard search/filter — confirmed at audit: TanStack Svelte Table with search input, column sort, semester filter matches existing `reviews-table.svelte` pattern.]**
Do you want search/filter by student ID? Sort by status or grade? The existing reviews-table has semester filtering — should the dashboard have something similar?

**2. Upload panel**

Component: `frontend/src/lib/components/submissions/upload-panel.svelte`

A drag-drop zone for `.ipynb` files. Shows file list with upload progress.
- Phase 2: renders the zone but upload button is a stub (shows toast "Upload in Phase 3")
- Phase 3: actually calls `/api/submissions/upload`

**3. Per-submission review page**

Route: `/submissions/[id]/`
Components:
- `frontend/src/lib/components/submissions/execution-output.svelte` — cell-by-cell view
- `frontend/src/lib/components/submissions/reference-comparison.svelte` — diff flags

Layout:
- Left panel: execution output (cell index, type, source, output, auto-fix badge)
- Right panel: rubric with suggested scores, grade input, action buttons
- Both panels resizable (if the existing app has a resizable-pane pattern, reuse it)

**Grid specification:**

```
┌────────────────────────────────────────────────────────┐
│ Header:  Student ID · Assignment · Status badge        │
├─────────────────────────┬──────────────────────────────┤
│  Execution Output       │  Rubric + Grading            │
│                         │                              │
│  ┌───────────────────┐  │  Code Execution:    3/5  ⏎ │
│  │ Cell 1 (code)     │  │  Code Quality:      4/5  ⏎ │
│  │ ...               │  │  Requirements:      2/5  ⏎ │
│  │ [Output]          │  │                              │
│  └───────────────────┘  │  Overall:            3.0     │
│                         │                              │
│  ┌───────────────────┐  │  [Suggest Grade] [DraftNotes]│
│  │ Cell 2 (code)     │  │                              │
│  │ ... ⚠️ diverges   │  │  [Auto-fix Cell]            │
│  │ [Output]          │  │                              │
│  └───────────────────┘  │  Copilot chat (Phase 4)      │
│                         │                              │
│  ┌───────────────────┐  │                              │
│  │ Cell 3 (md)       │  │                              │
│  └───────────────────┘  │                              │
├─────────────────────────┴──────────────────────────────┤
│  Footer:  [Save Grade] [Export]                        │
└────────────────────────────────────────────────────────┘
```

**4. Stub behavior for Phase 2**

All action buttons render but show a toast or placeholder:

| Button | Phase 2 behavior |
|---|---|
| [Process All] | Shows "Processing pipeline coming in Phase 3" |
| [Suggest Grade] | Shows mock suggestion: "Code Quality: 4/5" (hardcoded) |
| [Draft Notes] | Pre-fills notes field with placeholder text |
| [Auto-fix Cell] | Shows "Auto-fix coming in Phase 4" |
| Upload drag-drop zone | Shows "Upload coming in Phase 3" |

**5. Design consistency checklist**

- [ ] Uses OKLCH color tokens from the existing `layout.css`
- [ ] Uses the same `@theme inline` variables
- [ ] shadcn-svelte components from the existing set (Button, Badge, Table, Card, Resizable)
- [ ] Same font stack (Geist variable)
- [ ] Dark mode supported via existing `.dark` class toggle
- [ ] Responsive: stacks panels vertically below 768px
- [ ] Same spacing/typography scale as the existing app

---

### 6. Navigation entry point for teacher routes

**[RESOLVED: UI link in the landing page/app-header. Since deployments are now separate (static vs node), there's no need to hide teacher features — in the node build, a "Teacher Dashboard" link is always visible. The header becomes the primary navigation hub: student flows (New Review, Saved Reviews) coexist with the teacher link.]**

The landing page (`+page.svelte`) shows a "Teacher Dashboard" link when built with `ADAPTER=node`. Implementation: use `import.meta.env.VITE_ADAPTER` (exposed via Vite's `define` in `vite.config.ts`) to conditionally render the link. Alternatively, check if the `/submissions/` route exists at runtime — simplest is the build-time constant.

The `headerConfig` store gets a `showTeacherNav` property. The submissions dashboard sets it to `true`, which adds a persistent "Dashboard" link in the header while on teacher pages.

---

### 7. Type definitions and stub data

For Phase 2 to render anything useful, type definitions and stub data are needed:

**Type file:** `frontend/src/lib/types/submissions.ts`
```typescript
export type SubmissionStatus = "pending" | "executing" | "executed" | "error" | "pre-evaluated" | "graded";

export interface SubmissionMeta {
    id: string;
    filename: string;
    studentId: string;
    assignmentId: string;
    status: SubmissionStatus;
    cellDiff?: string;        // e.g., "cell 5,7" or "none"
    preEvalGrade?: number;
    teacherGrade?: number;
    createdAt: string;
    updatedAt: string;
}

export interface SubmissionDetail extends SubmissionMeta {
    cells: CellInfo[];
    referenceCells?: CellInfo[];
}

export interface CellInfo {
    index: number;
    type: "code" | "markdown";
    source: string;
    output?: string;
    error?: string;
    diverges?: boolean;
    autoFixApplied?: boolean;
}
```

**Stub data service:** `frontend/src/lib/services/submissions-store.ts` (stub version for Phase 2):
- Returns hardcoded array of 3-4 `SubmissionMeta` objects matching the dashboard mockup
- `getSubmission(id)` returns a `SubmissionDetail` with mock cells (2 code, 1 markdown)
- Full implementation (real API calls) comes in Phase 3

---

### 8. "Your Grade" column — display-only in Phase 2

**Phase 2:** Display-only column. Shows `"—"` for all submissions (no grading data exists yet).

**Phase 3+:** Editable inline in the dashboard table (click cell → input field), or populated from the per-submission page's grade sliders on save.

Rationale: Phase 2 is a stub — no real data flows yet.

---

### 9. Per-submission page rubric data source

The per-submission page loads its rubric from the same `criteria-loader.ts` service the student-facing app uses.

**Phase 2:** The page reads `assignmentId` from the URL or stub data, then calls `getCriteriaForAssignment(assignmentId)` to load the real rubric. The `GradingSidebar` component is reused directly — it was simplified in Phase 1 (no mode prop, no toggle). In the node build, the sliders are interactive (the `disabled` prop is `false`).

**Phase 3+:** Rubric still loads from `criteria-loader.ts` — real submission data populates the selections.

---

### 10. Reference comparison component

**Location:** `frontend/src/lib/components/submissions/reference-comparison.svelte`

**Cell-level diff scope:**
- Source code diff only (compare each cell's source with the reference key's corresponding cell)
- Output diff is secondary (visually flagged if different, but no inline diff)
- Metadata (execution counts, timing) not compared

**Visual treatment (Phase 2 stub):**
- Cells that match the reference → no badge, normal rendering
- Cells that diverge → ⚠️ badge on the cell header in the execution output panel
- The `reference-comparison.svelte` component is a separate panel showing a side-by-side or collapsed diff view

**Phase 2 mock data:** The stub `submissions-store.ts` returns hardcoded diff flags on 1-2 pre-marked cells.

**Dashboard "Cells Diff" column:**
- Comma-separated list of diverging cell indices: `"cell 5,7"` means cells 5 and 7 differ
- `"none"` if all cells match
- `"—"` if reference comparison hasn't run yet (pending/executing/error)

---

### 11. Error states

Components must handle these error states in Phase 2 (even with stub data):

| State | Where | UI |
|---|---|---|
| Empty (no submissions) | Dashboard | Full-page drag-drop area (same as upload panel, centered) |
| Invalid submission ID | Per-submission page | Error card with message "Submission not found" + link back to dashboard |
| Route accessed in static build | Both pages | Page should not exist due to tree-shaking; if reached via hash, show inline error |
| Generic runtime error | Both pages | `EmptyState` component (reuse `ui/empty-state.svelte`) with "Something went wrong" + retry button |
| Loading state | Both pages | `SidebarSkeleton`-style loading placeholders |

---

### 12. File manifest for Phase 2

| File | Purpose |
|---|---|
| `frontend/src/routes/submissions/+page.svelte` | Dashboard route page |
| `frontend/src/routes/submissions/[id]/+page.svelte` | Per-submission review route page |
| `frontend/src/lib/components/submissions/submissions-dashboard.svelte` | Dashboard table with TanStack Table |
| `frontend/src/lib/components/submissions/upload-panel.svelte` | Drag-drop upload zone (stub) |
| `frontend/src/lib/components/submissions/execution-output.svelte` | Cell-by-cell execution view |
| `frontend/src/lib/components/submissions/reference-comparison.svelte` | Cell-level diff flags |
| `frontend/src/lib/types/submissions.ts` | Submission, CellInfo, SubmissionStatus types |
| `frontend/src/lib/services/submissions-store.ts` | Stub data service (replaced by real API in Phase 3) |

---

### 13. Per-submission page header and navigation

The per-submission page uses `headerConfig` (same pattern as student pages):

```typescript
$effect(() => {
    headerConfig.showBack = true;
    headerConfig.breadcrumb = "Submission: {studentId}";
    headerConfig.showTeacherNav = true;   // new property — shows nav link back to dashboard
    return () => {
        headerConfig.showBack = false;
        headerConfig.breadcrumb = undefined;
        headerConfig.showTeacherNav = false;
    };
});
```

The back button navigates to `/submissions/` (teacher dashboard), not the landing page.

---

### 14. Upload panel vs empty state

They are the **same component** (`upload-panel.svelte`):
- **When no submissions exist:** The upload panel is shown full-page, centered, with a message "No submissions yet — upload .ipynb files to get started"
- **When submissions exist:** The upload panel is a compact bar at the top of the dashboard (as shown in the mockup)
- The component has a `compact` prop to toggle between these two display modes

---

### 15. Cell rendering specification (Phase 2 mock data)

| Cell type | Rendering |
|---|---|
| Code (`"code"`) | Source rendered in a monospace code block with syntax highlighting (same style as existing code display) |
| Markdown (`"markdown"`) | Source rendered as plain text (no HTML render in Phase 2 — Phase 4 may add markdown rendering) |
| Output | Plain text output displayed in a separate block below the source |
| Error | Error text in red, with error icon, below the source |
| Image output | Displayed as `[IMAGE: base64]` placeholder text in Phase 2 — real image rendering in Phase 3 |

Cell indices are **0-based** in the data model, **1-based** in the display (cell 0 → "Cell 1").

**Verification:**
- `ADAPTER=node pnpm build` → teacher routes exist
- `ADAPTER=static pnpm build` → teacher routes are tree-shaken
- `/submissions/` renders the dashboard with empty state
- `/submissions/demo-1` renders the review page with mock data
- All action buttons render and show appropriate stubs
- Dark mode works
- 375px viewport: panels stack, text doesn't overflow
- 1440px viewport: two-panel layout fills the screen

---
## Phase 3: Batch Upload + Execution Pipeline

**Goal:** Wire up the real data flow. Upload works, executor runs, submissions store tracks state, dashboard shows live data.

### Components to wire

**1. Upload API route**

- `POST /api/submissions/upload` — accepts multipart file upload, saves to `/app/uploads/`
- Auto-detects `assignment-key.ipynb` → marks it as reference
- Returns list of uploaded file IDs

**2. Submissions metadata + reference store**

- File: `frontend/src/lib/services/submissions-store.ts`
- JSON file at `/app/data/submissions.json`
- Each record: `{ id, filename, studentId, status, executedNotebook?, fixLog?, preEvaluation?, teacherGrade?, createdAt, updatedAt }`
- Separate reference store at `/app/data/reference.json` — caches executed assignment key per-cell outputs: `{ filename, executedAt, cellOutputs: [{ index, source, output }] }`

**3. Executor service**

- Same as previous plan: FastAPI + jupyter-client + kernel cleanup + timeout
- Pure execution — no auto-fix logic
- Three endpoints: `/execute`, `/execute/file`, `/execute/batch`

**4. Process orchestrator**

- `POST /api/submissions/process`:
  1. Execute assignment-key.ipynb (if present) → cache as reference
  2. For each pending student .ipynb: execute via executor → store result
  3. If execution errors → store error state (auto-fix comes in Phase 4)
  4. Update submission store

**5. Execution panel wiring**

Replace Phase 2 stub data with real data from the API:
- Execution output shows actual cell outputs
- Status badges reflect real execution state
- "Process All" button calls the orchestrator
- Loading state while executing (spinner per submission)

**6. Executor Docker service**

- `executor/` directory with server, runner, sandbox, Dockerfile
- `docker-compose.yml` adds the executor service + upload volume

### Upload persistence

Uploaded `.ipynb` files live in a Docker named volume:

```yaml
services:
  app:
    volumes:
      - uploads:/app/uploads
  executor:
    volumes:
      - uploads:/app/uploads

volumes:
  uploads:
```

**No bind mount alternative** — named volume avoids permission issues. Files are managed entirely through the webapp UI (upload, archive, delete, download).

---

### 7. SvelteKit server route design

Each API route is a `+server.ts` handler, tree-shaken in the static build:

| Route | Method | Purpose | Response |
|---|---|---|---|
| `/api/submissions/+server.ts` | GET | List all submissions | `{ submissions: SubmissionMeta[] }` with statuses, sorted by upload date |
| `/api/submissions/upload/+server.ts` | POST | Accept multipart `.ipynb` upload | `{ ids: string[] }` — saves to `/app/uploads/` |
| `/api/submissions/[id]/+server.ts` | GET | Single submission with execution data | `SubmissionDetail` (metadata + executed notebook JSON + fix log) |
| `/api/submissions/process/+server.ts` | POST | Trigger batch processing | `{ jobId: string }` — starts async execution, returns immediately |

All routes check for `/app/data/submissions.json` as the source of truth. Mutations write atomically (write to `.tmp` → `rename`).

**Rate limiting / size:** Accept `.ipynb` files up to 10MB. Reject non-`.ipynb` extensions. Max 50 files per upload batch.

---

### 8. Client-side state management

The dashboard needs live status updates while processing runs. Strategy:

**Simple polling** (no WebSocket/SSE complexity):

```
Every 2 seconds while submissions are in "pending" or "executing" state:
  GET /api/submissions
  If any status changed → update table rows reactively
  If all terminal (executed / error / pre-evaluated) → stop polling
```

Implementation in a `$effect` in the dashboard component:

```typescript
// pseudo-code
let pollInterval: ReturnType<typeof setInterval> | null = null;

$effect(() => {
    const hasActiveJobs = submissions.some(s => s.status === "pending" || s.status === "executing");
    if (hasActiveJobs && !pollInterval) {
        pollInterval = setInterval(async () => {
            await refreshSubmissions();
        }, 2000);
    } else if (!hasActiveJobs && pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
    }
    return () => { if (pollInterval) clearInterval(pollInterval); };
});
```

Graceful stop: if polling returns errors 3 times consecutively, show error toast and stop.

---

### 9. Submissions-to-assignment matching

When a teacher uploads `.ipynb` files, the system needs to know which assignment's rubric and grading config to use.

**Approach: drop-down selection on upload**

1. Teacher navigates to `/submissions/` (Phase 2 dashboard)
2. Clicks "Upload Files" or drops `.ipynb` files on the drop zone
3. An assignment selector appears (same dropdown style as the landing page's "New Review" form)
4. Teacher selects the assignment (e.g., "Aufgabe 1: Web-App Konzeption")
5. All uploaded files are tagged with that `assignment_id` in the metadata store
6. The per-submission review page reads `assignment_id` from metadata and loads the correct rubric/grading config

**Fallback:** Filename prefix matching — if the teacher skips the dropdown, try to infer assignment from known patterns (e.g., `assignment-key.ipynb` = reference, otherwise prompt on process).

---

### 10. Export bridge: teacher grades → student YAML

After the teacher finishes grading (editing scores, adding notes), the review needs to become a YAML file that students can import into the static student-facing app.

**Approach: existing export format, server-side generation**

The teacher-facing submission review page (`/submissions/[id]/`) reuses the same `ExportStore.exportAndDownload()` from the shared codebase. When the teacher clicks "Export YAML":

1. Gather the review state (rubric selections, grading scores, comments) from the submission metadata
2. Feed it through the existing `ExportStore` → produces a v2 YAML file with the same schema students use
3. The YAML file downloads to the teacher's machine

This means:
- No separate export endpoint needed — reuse what already exists
- The output YAML is **identical in format** to student-exported YAML (same Zod schema)
- Students import it the same way using the ImportDialog
- `is_read_only` + `is_forced_read_only` handling works the same: when grading values exist → forced read-only

**Batch export:** The dashboard can have a "Export All Graded" button that calls `POST /api/submissions/export-all` → returns a zip of YAML files, one per graded submission.

---

### 11. Docker Compose specification

```yaml
services:
  app:
    build:
      context: ./frontend
      dockerfile: ../Dockerfile  # SvelteKit adapter-node build
    ports:
      - "8765:3000"  # host:8765 → container:3000
    environment:
      - ADAPTER=node
      - AUTH_TOKEN=${AUTH_TOKEN}      # KI Connect token
      - DEFAULT_MODEL=openai-gpt-oss-120b
      - AUTOFIX_MODEL=qwen3-30b-a3b-instruct-2507
    volumes:
      - uploads:/app/uploads
      - app-data:/app/data
    depends_on:
      executor:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "wget", "--spider", "http://localhost:3000/"]
      interval: 10s
      timeout: 5s
      retries: 5

  executor:
    build: ./executor
    ports:
      - "8766"  # internal only — not exposed to host
    environment:
      - EXECUTOR_TIMEOUT=30
      - MAX_PARALLEL=4
    volumes:
      - uploads:/app/uploads
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8766/health"]
      interval: 10s
      timeout: 5s
      retries: 5

volumes:
  uploads:
  app-data:
```

**Key decisions:**
- `app` port is `3000` inside container, mapped to `8765` on host (consistent with the Phase 2+ architecture diagram)
- `executor` port is internal only — no host mapping needed
- `app` uses a `Dockerfile` at repo root (multi-stage Node build), `executor` uses its own
- Health checks prevent the app from starting before the executor is ready
- Named volumes for both uploads and app data (metadata JSON)**

---

### 12. File listing update

File list stays the same as shown below. One addition:

| File | Purpose |
|---|---|
| `frontend/src/routes/api/submissions/export-all/+server.ts` | (New) Batch export all graded submissions as YAML zip |

### Files to create (~23)

| File | Purpose |
|---|---|
| `frontend/src/routes/api/submissions/upload/+server.ts` | Multipart upload handler |
| `frontend/src/routes/api/submissions/process/+server.ts` | Batch orchestrator |
| `frontend/src/routes/api/submissions/+server.ts` | GET list all submissions |
| `frontend/src/routes/api/submissions/[id]/+server.ts` | GET single submission detail |
| `frontend/src/routes/api/submissions/export-all/+server.ts` | Batch export all graded as YAML zip |
| `frontend/src/lib/services/submissions-store.ts` | JSON metadata store + reference cache |
| `frontend/src/lib/services/upload-client.ts` | Client-side upload logic |
| `frontend/src/lib/components/submissions/upload-zone.svelte` | Drag-drop zone (wire real) |
| `executor/server.py` | FastAPI endpoints |
| `executor/runner.py` | Cell-by-cell execution |
| `executor/sandbox.py` | Per-request temp dir |
| `executor/batch.py` | Directory scanner |
| `executor/requirements.txt` | Python deps |
| `executor/Dockerfile` | Executor image |
| `executor/tests/conftest.py` | Fixtures |
| `executor/tests/test_runner.py` | Kernel lifecycle tests |
| `executor/tests/test_batch.py` | Batch processing tests |
| `Dockerfile` | SvelteKit (adapter-node) |
| `docker-compose.yml` | app + executor + upload volume |
| `start.sh` | Linux launcher |
| `start.ps1` | Windows launcher |

### Verification

- Upload a `.ipynb` → file appears in the upload volume
- Click "Process All" → executor runs, cells execute with outputs
- Status updates: pending → executing → executed / error
- Dashboard reflects live status
- Open review page → real execution output visible
- Cell-by-cell view shows source, output, error indicators
- Python tests pass
- `pnpm check` passes

---
## Phase 4: LLM + Agentic Features

**Goal:** Add pre-evaluation, suggestion buttons, LLM-guided auto-fix, and the agentic copilot.

### Sub-phases

**4a: Pre-evaluation** (batch LLM call)

`POST /api/submissions/pre-eval`: for each executed submission, call LLM with rubric + reference outputs + student outputs → store suggested scores per dimension.

**4b: Suggestion buttons** (single LLM call)

- [Suggest Grade] → `POST /api/suggest-grade` → LLM returns suggested score + confidence + reasoning
- [Draft Notes] → `POST /api/draft-notes` → LLM generates notes from selections + notebook content
- [Auto-fix Cell] → `POST /api/autofix` → LLM fixes a broken cell

**[RESOLVED: Same KI Connect provider for everything. Default: `openai-gpt-oss-120b`. Auto-fix: `qwen3-30b-a3b-instruct-2507`. Configurable via env var.]**

**4c: Agentic copilot** (multi-turn chat)

- Mastra agent with all tools registered
- Chat panel on the per-submission review page
- Streams responses via AI SDK UI
- Structured suggestion rendering (grade scores with confidence badges)
- Conversation persisted via Mastra memory

---

### Key design decisions (Phase 4)

#### Mastra initialization and lifecycle

Mastra is initialized in `frontend/src/mastra/index.ts` as a singleton, imported lazily inside `+server.ts` handlers (not in `hooks.server.ts` — avoids loading Mastra on every request):

```typescript
// frontend/src/mastra/index.ts
import { Mastra } from "@mastra/core";
import { openai } from "@mastra/openai";
import { GradingCopilotAgent } from "./agents/grading-copilot";

const client = new Mastra({
    providers: {
        kiconnect: openai({
            name: "kiconnect",
            baseURL: "https://chat.kiconnect.nrw/api/v1",
            apiKey: process.env.AUTH_TOKEN ?? "",
        }),
    },
    agents: {
        gradingCopilot: GradingCopilotAgent,
    },
});

export const mastraClient = client;
```

**Path alias:** `$mastra` should be added to `tsconfig.json` and `vite.config.ts`:

```json
// tsconfig.json
"paths": {
    "$lib/*": ["./src/lib/*"],
    "$mastra/*": ["./src/mastra/*"]
}
```

---

#### Streaming protocol for `/api/chat`

The chat endpoint uses **Server-Sent Events (SSE)** via the AI SDK's streaming format, not raw Mastra streams. The `+server.ts` handler:

1. Receives `{ messages, submissionId }` POST body
2. Calls `mastraClient.agents.gradingCopilot.stream(messages)` — returns a Mastra stream
3. Converts Mastra stream chunks to AI SDK `useChat`-compatible format (`{ id, role, content, ... }` as SSE)
4. Returns `new Response(readableStream, { headers: { "Content-Type": "text/event-stream" } })`
5. Handles `request.signal` abort on client disconnect

The AI SDK `Chat` class on the client handles reconnection and state management:

```typescript
// In copilot-panel.svelte
import { Chat } from "@ai-sdk/svelte";
const chat = new Chat({
    api: "/api/chat",
    body: { submissionId },
});
// chat.messages, chat.input, chat.handleSubmit, chat.isLoading are
// reactive Svelte 5 runes ($state-compatible)
```

---

#### Per-dimension vs per-submission suggest grade

**[RESOLVED: Two-tier approach. Phase 4b: per-submission (single "Suggest Grades" button analyses all dimensions at once) — gives the teacher fast initial bearings. Phase 4c/agentic: per-dimension tweaks (via the copilot chat, where the teacher can ask "what about code quality?" and get a targeted suggestion). The philosophy is accelerator-not-oracle: the copilot reduces cold-start time, the teacher stays in control of every individual score.]**

**Phase 4b implementation:**
- One [Suggest Grades] button at the top of the grading panel
- `POST /api/suggest-grade` returns `Record<DimensionKey, { score: number, confidence: "high"|"medium"|"low", reasoning: string }>` for all dimensions
- All scores are pre-filled as suggestions (teacher reviews and adjusts each)
- The button shows a loading state, then the scores appear with inline accept/dismiss per dimension

**Phase 4c/chat implementation:**
- Teacher can type "what should the code execution score be?" in the copilot chat
- The agent uses the `suggest-grade` tool with a specific dimension key to return a per-dimension suggestion
- This is conversational — teacher can refine, ask follow-ups, and selectively apply

---

#### Pre-evaluate button location

**[RESOLVED: Dashboard toolbar. A "Pre-evaluate All" button in the dashboard toolbar, enabled after batch processing completes. This allows the teacher to get initial scores for all submissions in one action, then dive into individual reviews.]**

The button sits alongside "Upload Files" and "Process All" in the dashboard toolbar. It's disabled (grayed out) until at least one submission reaches `"executed"` status. On click, it calls `POST /api/submissions/pre-eval` and shows a progress indicator per submission as scores arrive.

---

#### Pre-evaluation storage schema

Pre-evaluation scores are stored in `submissions.json` alongside each submission's metadata, extending the Phase 3 schema:

```typescript
// In the existing SubmissionMeta from Phase 3:
interface PreEvaluation {
    scores: Record<string, number>;       // dimension key → suggested score
    confidence: "high" | "medium" | "low";
    reasoning: string;                     // LLM's explanation
    evaluatedAt: string;                   // ISO timestamp
}
```

The `submissions.json` `preEvaluation?` field (placeholder from Phase 3) is populated with this structure.

---

#### Confidence scoring approach

**Phase 4b (simple, no multi-sample):**
- Use `logprobs` from the LLM response as a single-call confidence estimate
- Map: `avg_logprob > -0.5` → "high", `> -1.5` → "medium", else "low"
- No multi-sample calls in 4b — confidence badges show immediately

**Phase 4d (multi-sample, deferred):**
- Hees' self-consistency method: `N=5` calls per suggestion
- Variance measured as coefficient of variation across scores
- Thresholds: `CV < 0.1` → "high", `CV < 0.25` → "medium", else "low"
- Overrides the 4b logprobs-based confidence when available

This means confidence badges work in 4b (using logprobs) and improve in 4d (using multi-sample).

---

#### Copilot store pattern

The copilot store (`copilot.svelte.ts`) wraps the AI SDK `Chat` class inside a class-based runes store, matching the project convention:

```typescript
import { Chat } from "@ai-sdk/svelte";

export class CopilotStore {
    chat = $state<Chat | null>(null);

    initialize(submissionId: string) {
        this.chat = new Chat({
            api: "/api/chat",
            body: { submissionId },
        });
    }
    sendMessage(text: string) {
        this.chat?.handleSubmit({ append: { role: "user", content: text } });
    }
    reset() {
        this.chat = null;
    }
}

export const copilotStore = new CopilotStore();
```

This is consistent with the existing pattern (ReviewStore, GradingStore, etc.) and keeps the AI SDK integration behind a familiar interface.

---

#### Error handling for LLM calls

| Failure mode | Behavior |
|---|---|
| LLM unavailable (network error) | Show toast "[Feature] unavailable — check provider connection" |
| AUTH_TOKEN unset / invalid | Return 401 from `+server.ts`; UI shows "API key not configured" with setup instructions |
| Rate limited (429) | Retry with exponential backoff (1s, 2s, 4s), then show "Service busy — try again" |
| No assignment key for pre-eval | Skip reference comparison; offer partial pre-eval with rubric-only context |
| Submission in error state | Pre-eval requires execution output — show "Cannot pre-evaluate: submission has errors" |
| Copilot chat times out | Show "Response taking longer than expected — please wait or try a simpler question" |

---

#### Auto-fix interaction design

The auto-fix flow is **suggestion-only** — the teacher always reviews before applying:

1. Teacher clicks [Auto-fix Cell] on an error cell
2. `POST /api/autofix` sends `{ notebook: CellInfo[], cellIndex: number, error: string }` to Qwen model
3. LLM returns `{ suggestedCode: string, explanation: string }`
4. UI shows a diff view: original code (left) vs suggested fix (right) — inline in the cell or as an overlay
5. Teacher clicks **[Apply]** → the cell's source is updated in the submission metadata; teacher can then re-execute manually
6. Teacher clicks **[Dismiss]** → suggestion is discarded, cell state unchanged

The fix is **not automatically re-executed** — the teacher decides whether to re-run after applying. This is consistent with the existing design principle "teacher stays in control."

---

### Unresolved gaps (Phase 4)

These need resolution before Phase 4 implementation:

| # | Gap | Resolution |
|---|-----|------------|
| G4.1 | Per-dimension vs per-submission Suggest Grade | **[RESOLVED]** Two-tier: per-submission for initial bearings (Phase 4b), per-dimension via chat for refinement (Phase 4c) |
| G4.2 | Pre-evaluate button location | **[RESOLVED]** Dashboard toolbar, enabled after processing |
| G4.3 | Mastra memory backend | **[RESOLVED]** File-backed persistence using the existing `app-data` Docker volume. Simple JSON store at `/app/data/conversations/<submissionId>.json`. Persistent across container restarts, no additional dependencies. |
| G4.4 | Chat panel layout position | See detailed recommendation below |
| G4.5 | Copilot conversation per-submission vs global | **[RESOLVED]** Per-submission primary. Each submission opens a new conversation in the chat panel. The agent can read other submissions' data (execution output, grades, notes) via a `get-submission-context` tool, allowing cross-referencing without context drift. This means the agent understands the teacher's grading style across submissions without confusing them mid-conversation. |

#### Chat panel layout recommendation

The per-submission review page uses a two-panel layout (left: execution output, right: rubric + grading). The copilot chat should integrate into the **right panel** as a collapsible section below the grading controls:

```
┌────────────────────────────────────────────────────────┐
│ Header: Student ID · Assignment · Status badge          │
├─────────────────────────┬──────────────────────────────┤
│  Execution Output       │  Grading                     │
│                         │  ┌────────────────────────┐  │
│  ┌───────────────────┐  │  │ Code Execution:  3/5   │  │
│  │ Cell 1 (code)     │  │  │ Code Quality:   4/5   │  │
│  │ [Output]          │  │  │ Requirements:   2/5   │  │
│  └───────────────────┘  │  │ Overall:         3.0   │  │
│                         │  │                         │  │
│  ┌───────────────────┐  │  │ [Suggest Grades]        │  │
│  │ Cell 2 (code)     │  │  └────────────────────────┘  │
│  │ [Output]          │  │  ├─ Copilot ────────────────┤│
│  └───────────────────┘  │  │ ┌──────────────────────┐ ││
│                         │  │ │ Agent: I'd look at   │ ││
│                         │  │ │ the edge case        │ ││
│                         │  │ │ handling in cell 3…  │ ││
│                         │  │ └──────────────────────┘ ││
│  ┌───────────────────┐  │  │ [Ask about this submission││
│  │ Cell 3 (md)       │  │  │  _____________________] ││
│  └───────────────────┘  │  └──────────────────────────┘│
├─────────────────────────┴──────────────────────────────┤
│  Footer: [Save Grade] [Export]                          │
└────────────────────────────────────────────────────────┘
```

Key design principles:

| Principle | Implementation |
|---|---|
| **Collapsible by default** | Chat panel shows as a thin "Copilot" bar when collapsed — click to expand. Grading is always visible first |
| **Resizable** | A drag handle between grading and chat lets the teacher allocate space |
| **Reactive, not proactive** | The copilot never auto-fills grades or changes values without teacher action. All suggestions are delivered as cards with [Apply] [Dismiss] buttons |
| **Inline suggestion cards** | When the agent suggests a grade, a card appears in the chat showing the dimension, score, confidence badge, and reasoning. Teacher clicks Apply to set the slider, Dismiss to discard |
| **Scrolls independently** | The grading section and chat section scroll independently within the right panel |

This pattern is similar to:
- **GitHub Copilot Chat** (VS Code sidebar) — always available on demand, never interrupts workflow
- **Cursor Composer** (inline suggestions with accept/reject) — teacher previews before applying
- **Linear's AI** (assist mode in a panel) — assists without taking control

The key differentiator is **approval gating**: the copilot suggests, the teacher disposes. No auto-approve, no silent background operations. This matches the "accelerator, not oracle" philosophy.

**4d: Multi-sample confidence** (Phase 4 optimization)

Hees' self-consistency method — call LLM N times per suggestion, measure output variance → map to confidence. Deferred to the end of Phase 4 because it's the most complex piece.

### Files to create (~18)

| File | Purpose |
|---|---|
| `frontend/src/mastra/index.ts` | Mastra instance initialization |
| `frontend/src/mastra/agents/grading-copilot.ts` | Agent with all tools |
| `frontend/src/mastra/tools/suggest-grade.ts` | Grade suggestion tool |
| `frontend/src/mastra/tools/draft-notes.ts` | Notes generation tool |
| `frontend/src/mastra/tools/get-submission-context.ts` | Read submission + reference |
| `frontend/src/lib/services/llm-autofix.ts` | Auto-fix client |
| `frontend/src/lib/stores/copilot.svelte.ts` | Chat state (class wrapping `useChat`) |
| `frontend/src/routes/api/submissions/pre-eval/+server.ts` | Batch pre-evaluation endpoint (4a) |
| `frontend/src/routes/api/suggest-grade/+server.ts` | Grade suggestion endpoint (4b) |
| `frontend/src/routes/api/draft-notes/+server.ts` | Notes generation endpoint (4b) |
| `frontend/src/routes/api/autofix/+server.ts` | Auto-fix endpoint (4b) |
| `frontend/src/routes/api/chat/+server.ts` | Mastra streaming endpoint (4c) |
| `frontend/src/lib/components/copilot/copilot-panel.svelte` | Chat panel |
| `frontend/src/lib/components/copilot/suggestion-card.svelte` | Structured result display |
| `frontend/src/lib/components/copilot/confidence-badge.svelte` | H/M/L indicator |
| Various test files | Tool + component tests |

**New dependencies for `frontend/package.json`:**
- `@mastra/core` — Mastra framework (latest stable, e.g. `^1.52.1`)
- `@mastra/openai` — OpenAI-compatible provider (for KI Connect, latest stable, e.g. `^1.1.0`)
- `@ai-sdk/svelte` — AI SDK `Chat` class (Svelte 5 runes compatible, latest stable, e.g. `^5.0.37`)
- `openai` — OpenAI SDK for direct non-Mastra LLM calls (pre-eval, auto-fix)

### Verification

- Upload + process 3 notebooks + assignment key
- Click "Pre-evaluate All" → grades appear for each
- Open a submission → pre-evaluation scores pre-filled
- Click "Suggest Grade" on a dimension → loading bar → suggestion with confidence
- Click "Auto-fix" on an error cell → diff view → Apply replaces code
- Open copilot chat → "What should I look for in this submission?" → streaming response
- Confidence badges show on all suggestions
- Reload → conversation persists

---
## GitHub Issues (45 issues across 5 phases)

### Phase 0 (1 issue) ✅ COMPLETED
1. **Audit current main branch** — ✅ Walked through every user flow in Chromium, blocking bugs fixed, clean baseline confirmed.

### Phase 1 (14 tasks across 19 files) ✅ COMPLETED
0. **Bump all dependencies** — ✅ All deps updated to latest inter-compatible versions, `@sveltejs/adapter-node@^5.5.7` installed
1. **Remove `ReviewMode` type** — ✅ Type removed, barrel export updated
2. **Remove mode from Settings store** — ✅ `settings.svelte.ts`: mode field, `getMode()`, `setMode()` removed
3. **Remove mode from ReviewStore** — ✅ `review.svelte.ts`: mode state removed, `"student"` hardcoded in `toSession()`
4. **Remove mode-gating from review page** — ✅ `review/[id]/+page.svelte`: GradingSidebar simplified, import logic cleaned
5. **Simplify GradingSidebar component** — ✅ Mode prop, `onToggleMode`, toggle button removed
6. **Remove ModeCard from settings + update layout** — ✅ ModeCard deleted, layout sync cleaned
7. **Update landing page import logic** — ✅ Mode sync removed, `settings` import cleaned
8. **Update evaluation page** — ✅ `isTeacher` gate removed, grading summary shows when `gradeResult` exists
9. **Update docs pages** — ✅ Teacher-mode removed from nav, content, shortcuts
10. **Set up dual-adapter build** — ✅ `svelte.config.js` rewritten for `ADAPTER=static`/`ADAPTER=node`
11. **Update validation schema** — ✅ Mode validation relaxed to `z.string()` for backward compat
12. **Update tests** — ✅ 215/215 tests passing, 0 failures
13. **Final verification** — ✅ `pnpm check`, `pnpm test`, both builds verified

### Phase 2 (7 issues)
1. **Submissions dashboard** — TanStack Svelte Table with search, sort, semester filter. Stub data.
2. **Upload panel stub** — Drag-drop zone with "Upload coming in Phase 3" toast
3. **Per-submission review page** — Two-panel layout: execution output + rubric. Stub data.
4. **Reference comparison component** — Cell-level diff flags against mock reference data
5. **Design consistency pass** — OKLCH tokens, dark mode, responsive, shadcn components
6. **Dashboard empty state + error states** — No submissions, connection error, etc.
7. **Phase 2 integration** — Wire routes, verify static build tree-shakes teacher components

### Phase 3 (10 issues)
1. **Upload API route** — Multipart `.ipynb` upload handler, saves to named volume, assignment selector during upload
2. **Submissions listing + detail API** — GET list with status filtering, GET single submission with execution data
3. **Submissions metadata store** — JSON store + reference cache with atomic writes, submission-to-assignment matching
4. **Executor service** — FastAPI server with cell-by-cell runner, kernel cleanup, timeout, health endpoint
5. **Batch process orchestrator** — Executes all pending submissions, caches reference output, status updates
6. **Executor Dockerfile + tests** — Python test suite for runner, batch, and error cases
7. **Wire real data into dashboard + review page** — Replace Phase 2 stubs, polling for live status
8. **Docker Compose + start scripts** — `app` + `executor` services, upload + data volumes, health checks
9. **Client-side polling** — `$effect`-based polling in dashboard, error handling, graceful stop
10. **Export bridge** — Reuse ExportStore for per-submission YAML export, batch export-all endpoint

### Phase 4 (14 issues)
1. **Pre-evaluation endpoint + store** — `POST /api/submissions/pre-eval`, batch LLM with rubric + reference + student outputs, store in `submissions.json`
2. **suggestGrade tool** — Mastra tool + `POST /api/suggest-grade` endpoint, returns per-submission scores + logprobs-based confidence
3. **draftNotes tool** — Mastra tool + `POST /api/draft-notes` endpoint, generates notes from rubric selections + notebook content
4. **LLM-guided auto-fix endpoint** — `POST /api/autofix` with Qwen model, diff view + Apply/Dismiss interaction
5. **Wire suggestion buttons into review page** — [Suggest Grade], [Draft Notes], [Auto-fix Cell] on per-submission page
6. **Mastra agent setup** — Install deps (`@mastra/core`, `@mastra/openai`), configure `$mastra` path alias, singleton initialization in `mastra/index.ts`
7. **Copilot chat panel** — Streaming chat with AI SDK `Chat` class, copilot-panel.svelte layout
8. **Conversation persistence** — Mastra memory for chat across page reloads, per-submission conversations
9. **Multi-sample confidence scoring** — Hees' self-consistency method (call LLM N=5 times, coefficient of variation → H/M/L thresholds)
10. **Error handling + graceful degradation** — LLM unavailable, executor down, no assignment key, rate limiting, AUTH_TOKEN unset
11. **Pre-evaluate button in dashboard toolbar** — "Pre-evaluate All" button enabled after processing completes
12. **Copilot store** — `copilot.svelte.ts` class-based store wrapping `Chat`, matching project conventions
13. **Streaming endpoint boilerplate** — `/api/chat/+server.ts` SSE streaming, Mastra stream → AI SDK format conversion, abort handling
14. **Confidence badges** — `confidence-badge.svelte` H/M/L indicator, logprobs-based in 4b, overridden by multi-sample in 4d

---
## Files Summary

### New files (~49 total)

| Phase | Count | Key files |
|---|---|---|
| 2 | ~8 | Dashboard, upload panel, review page components, types, stub data service |
| 3 | ~23 | Upload API, executor (6 files + tests), Docker compose, start scripts, export-all |
| 4 | ~18 | Mastra config/agent/tools, copilot components, chat API, suggestion endpoints, pre-eval |

### Deleted files (Phase 1)

| Path | Reason |
|---|---|
| `frontend/src/lib/components/settings/mode-card.svelte` | Mode toggle + Alt+Shift+G keybinding removed |

Note: Legacy directories (`routes/analyze/`, `routes/dashboard/`, `components/dashboard/`, `types/backend.ts`) from the unified-ai branch were cleaned in a prior sweep and do not exist in the current `main` branch.

### Modified files (~19, Phase 1)

| File | Change |
|---|---|
| `frontend/src/lib/types/session.ts` | Remove `ReviewMode` type, keep `mode` as `string` |
| `frontend/src/lib/types/index.ts` | Remove `ReviewMode` from barrel export |
| `frontend/src/lib/stores/settings.svelte.ts` | Remove `mode` field, `getMode()`, `setMode()`, localStorage sync |
| `frontend/src/lib/stores/review.svelte.ts` | Remove `mode` state, hardcode `"student"` in `toSession()` |
| `frontend/src/routes/review/[id]/+page.svelte` | Remove mode-derived state, simplify GradingSidebar, import logic |
| `frontend/src/lib/components/grading-sidebar.svelte` | Remove `mode` prop, `onToggleMode`, mode toggle button |
| `frontend/src/routes/settings/+page.svelte` | Remove ModeCard import and rendering |
| `frontend/src/routes/+layout.svelte` | Remove `void settings.mode` from sync effect |
| `frontend/src/routes/review/[id]/evaluation/+page.svelte` | Remove `isTeacher`, gate grading summary by `gradeResult` |
| `frontend/src/routes/+page.svelte` | Remove mode sync, simplify import logic |
| `frontend/src/routes/docs/+page.svelte` | Remove `isTeacher`, remove teacher-mode from nav |
| `frontend/src/lib/components/docs-sidebar.svelte` | Remove mode-gating, remove teacher-mode from nav items |
| `frontend/src/lib/components/docs-content.svelte` | Remove mode-toggle callout, remove Alt+Shift+G |
| `frontend/src/lib/services/validation.ts` | Relax `reviewMode` to `z.string()` |
| `frontend/src/tests/stores/review.store.test.ts` | Remove `reviewStore.mode` assertion |
| `frontend/src/tests/services/validation.test.ts` | Update mode validation test |
| `frontend/svelte.config.js` | Dual-adapter (ADAPTER=static\|node) |
| `frontend/package.json` | Add `@sveltejs/adapter-node` dep |

---
## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Phase 0 reveals blocking bugs | Medium | Fix before proceeding — clean base is prerequisite |
| SvelteKit tree-shaking doesn't eliminate all teacher code | Low | Verify build output; add explicit checks if needed |
| Executor kernel leaks | Low | try/finally + test coverage |
| Docker permission issues with upload volume | Low | Named volume avoids host permission problems |
| Mastra API changes during implementation | Medium | Pin version; verify before Phase 4 |
| LLM auto-fix produces wrong code | Low | Teacher always sees diff and clicks "Apply" — no auto-replace |

---
## LLM Provider: KI Connect NRW

All LLM calls use the state-provided platform at `https://chat.kiconnect.nrw/api/v1`.

**API details (confirmed):**

| Property | Value |
|---|---|
| Base URL | `https://chat.kiconnect.nrw/api/v1` |
| Chat endpoint | `POST /v1/chat/completions` (OpenAI-compatible) |
| Models endpoint | `GET /v1/models` (can list available models) |
| Auth | Bearer token |
| OpenAI SDK compatibility | ✅ Full — use OpenAI SDK with custom `baseURL` |
| Standard params | ✅ `max_completion_tokens`, `frequency_penalty`, `presence_penalty`, `reasoning_effort`, `parallel_tool_calls`, `logprobs` |

**What this means for integration:**

Since it's OpenAI-compatible, both Mastra and direct LLM calls can use the OpenAI SDK with a custom `baseURL`:

```typescript
// Mastra agent
model: 'openai/gpt-4o',  // or whatever model string is available

// With custom client config (in Mastra init or .env):
OPENAI_BASE_URL=https://chat.kiconnect.nrw/api/v1
OPENAI_API_KEY=your-token
```

Or for direct non-Mastra LLM calls (auto-fix, pre-evaluation):
```typescript
import OpenAI from 'openai';
const client = new OpenAI({
  baseURL: 'https://chat.kiconnect.nrw/api/v1',
  apiKey: process.env.LLM_API_KEY,
});
```

**[GAP: Model name and concurrency limits]**
**RESOLVED via API test + UI screenshots.** Available models on KI Connect NRW:

### Text models

| API Model ID | UI Name | Cost / Operator | Reasoning | Token In/Out | Recommended for |
|---|---|---|---|---|---|
| `openai-gpt-oss-120b` | GPT OSS 120B | Free (inference NRW) | ✅ Level 2/3 | 131.1k / 8.2k | **Default — copilot, pre-evaluation** |
| `openai-gpt5.2` | GPT52 | Commercial (Academiccloud) | ✅ Level 3/4 | 400k / 128k | Fallback when budget available |
| `openai-gpt5` | GPT-5 | Commercial (Academiccloud) | ✅ Level 4/4 | 400k / 128k | Fallback when budget available |
| `openai-gpt41` | GPT-4.1 | Commercial (Academiccloud) | ❌ | 1047.6k / 32.8k | Fallback when budget available |
| `openai-gpt41-mini` | GPT-4.1-Mini | Commercial (Academiccloud) | ❌ | 1047.6k / 32.8k | Fallback when budget available |
| `qwen3-30b-a3b-instruct-2507` | Qwen 3 30B A3B | Free (Academiccloud) | ❌ | 262.1k / 16.4k | **Auto-fix** — strong at code, fast (MoE) |
| `mistralai-mistral-small-4-119b-2603` | Mistral Small 4 | Free (inference NRW) | ✅ Level 1/2 | 262.1k / 64k | Alternative for copilot |
| `LLAMA 3.1 8B` | Llama 3.1 8B | Free (Academiccloud) | ❌ | 128k / 4.1k | Auto-fix alternative (faster, weaker)

### Embedding models

| API Model ID | Max Tokens | Dims | Status | Operator |
|---|---|---|---|---|
| `e5-mistral-7b-instruct` | 4096 | 4096 | ⚠️ X (possibly misconfigured) | Inferenz NRW |
| `qwen-qwen3-embedding-8b` | 8192 | 4096 | ✅ Checkmark (working) | Inferenz NRW |

**Budget status:** Monthly €250 limit exhausted (€250.11/€250.00). Commercial models (`gpt5.2`, `gpt5`, `gpt41`, `gpt41-mini`) blocked until reset. Free models work without budget impact.

**Recommended defaults:**
- **Copilot & pre-evaluation:** `openai-gpt-oss-120b` — free, 120B params with reasoning, hosted by inference NRW
- **Auto-fix:** `qwen3-30b-a3b-instruct-2507` — Qwen 30B MoE (3B active params), strong at code tasks, fast inference, free. Better code understanding than Llama 3.1 8B for auto-fix tasks. Configurable via `AUTOFIX_MODEL` env var.
- **Embeddings:** `qwen-qwen3-embedding-8b` — if needed later for similarity search or RAG

---
## Gaps Summary

All gaps resolved except G4.4 (chat panel layout — recommendation provided, awaiting confirmation). Plan is ready for Phase 1 execution.

| # | Gap | Resolution |
|---|---|---|
| G1 | Upload persistence | ✅ Named volume. Webapp UI (archive, delete, download). |
| G2 | Design tooling | ✅ Open Design tool (nexu-io/open-design) — installed at /home/em/Projects/open-design/, Docker Compose ready. The teacher UI is prototyped in Open Design first, then implemented in SvelteKit with TanStack + stub data. |
| G3 | Dashboard layout | ✅ TanStack Svelte Table. Search, sort, semester filter. |
| G4 | Auto-fix model | ✅ Same KI Connect provider. |
| G5 | KI Connect details | ✅ API confirmed OpenAI-compatible. Default: `openai-gpt-oss-120b` (free, 120B, reasoning-capable). Auto-fix: `qwen3-30b-a3b-instruct-2507` (Qwen 30B MoE, strong at code). Budget: €250/mo commercial, currently exceeded — free models work without impact. |
