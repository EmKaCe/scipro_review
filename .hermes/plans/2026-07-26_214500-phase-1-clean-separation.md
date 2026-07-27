# Phase 1: Clean Separation — Remove Legacy Teacher Mode ✅ COMPLETED

> **Status:** ✅ **Completed 2026-07-27.** All 14 tasks (0–13) executed successfully. Mode toggle removed from all components. Dual-adapter build operational. 215/215 tests passing.
>
> **Execution summary:** 12 subagent dispatches across 7 parallel batches. Key rollbacks: TypeScript 7 → 6.0.3 (svelte-check compat), js-yaml 5 → 4.3.0 (API change). All deps bumped to latest inter-compatible versions.
>
> **Artifacts:** Git log shows 11 commits on `main` from the Phase 1 execution.

> **For Hermes:** Execute this plan task-by-task via subagent-driven-development. Each task is an independent unit of work with TDD cycle.
>
> **Status:** Code cleanup. Removes the runtime student/teacher mode toggle and mode-gating throughout the codebase. Sets up dual-adapter build for future phases.

**Goal:** Remove the existing student/teacher mode toggle from the UI and ensure the static build (GitHub Pages) contains no mode-gated code paths. All mode-related state, components, and UI are removed — grading is a teacher-only concern that will be properly wired in Phase 2+.

**Architecture Context:** The current app has a `ReviewMode` type (`"student" | "teacher"`) that controls UI visibility (grading sliders, mode badge) and data flow (import read-only behavior). After Phase 1, there is no runtime mode — the student peer-review app always behaves as "student" mode was, and the teacher Docker build (Phase 2+) will introduce its own controls. The build adapter (`ADAPTER=static` / `ADAPTER=node`) determines what code is available.

**Key Design Decisions:**
- Grading sliders are **never interactive** in the static build — teachers grade, students only view pre-existing grades on imported evaluations
- Grading sidebar is only visible when `hasGradingValues` (pre-existing grading data from import) — this matches the current "student mode" behavior exactly
- Imports **with grading values** (teacher-graded) are always forced read-only — students view but cannot edit
- Imports **without grading values** (student's own export) respect the user's read-only preference — students can uncheck "Import as read-only" to continue editing
- The `is_forced_read_only` mechanism stays but is simplified — it's now triggered by `hasGradingValues`, not by mode
- Dual-adapter build uses `process.env.ADAPTER` — default is `static` for backward compat

**Tech Stack:** Svelte 5 runes, SvelteKit 2, TypeScript 6, Vitest, Tailwind CSS v4

---

## Task Breakdown

---

### Task 0: Bump all dependencies to latest inter-compatible versions

**Objective:** Update all dependencies in `frontend/package.json` to the latest versions compatible with each other, before making code changes. This ensures we start Phase 1 on the latest stable foundation.

**Files:**
- Modify: `frontend/package.json`

**Step 1: Run pnpm update**

```bash
cd frontend && pnpm update --latest
```

This updates all packages within their semver ranges. For explicit major version bumps, the versions in `package.json` may need manual editing — but `pnpm update --latest` respects ranges.

For safety:
```bash
cd frontend
# Check what can be updated
pnpm outdated
# Update everything to latest within range
pnpm update --latest
```

**Step 2: Run full verification**

```bash
cd frontend && pnpm install && pnpm check && pnpm test && ADAPTER=static pnpm build
```

Expected: All existing tests pass, build succeeds after updates.

**Step 3: If updates break something**

Roll back individual deps to the previous version listed in `package.json`. The most likely candidate for breakage is SvelteKit ecosystem packages (`@sveltejs/kit`, `@sveltejs/adapter-static`, `svelte`, `svelte-check`) — if they fail, pin them back to known-good versions.

**Step 4: Commit**

```bash
git add frontend/package.json frontend/pnpm-lock.yaml
git commit -m "chore: bump all dependencies to latest inter-compatible versions"
```

---

### Task 1: Remove `ReviewMode` type and `mode` from `ReviewSession` type

**Objective:** Remove the `ReviewMode` type export. Keep `mode: string` in `ReviewSession` for backward compatibility with persisted data.

**Files:**
- Modify: `frontend/src/lib/types/session.ts:19-20`
- Modify: `frontend/src/lib/types/session.ts:59`
- Modify: `frontend/src/lib/types/index.ts:70`

**Step 1: Remove `ReviewMode` type from session.ts**

In `session.ts`, lines 19-20:
```typescript
/** View mode for the review interface. */
export type ReviewMode = "student" | "teacher";
```
Delete these 3 lines (the type definition and its JSDoc). The `mode` field in `ReviewSession` (line 59) stays but becomes `mode: string` — Zod validation gives it a default of `"student"`.

Change line 59 from:
```typescript
/** Review mode. */
mode: ReviewMode;
```
To:
```typescript
/** Review mode (for backward compatibility with persisted sessions). */
mode: string;
```

**Step 2: Remove `ReviewMode` from index.ts barrel export**

In `frontend/src/lib/types/index.ts`, line 70:
```typescript
export type { ReviewMode, CategorySelections, ReviewSession } from "./session.js";
```
Change to:
```typescript
export type { CategorySelections, ReviewSession } from "./session.js";
```

**Step 3: Run tests to verify no regressions**

Run: `cd frontend && npx vitest run src/tests/services/validation.test.ts --reporter=verbose`
Expected: All existing validation tests pass — the Zod schema still accepts sessions with or without mode.

**Step 4: Commit**

```bash
git add frontend/src/lib/types/
git commit -m "refactor: remove ReviewMode type, keep mode as string in ReviewSession for backward compat"
```

---

### Task 2: Remove `mode` from Settings store

**Objective:** Remove mode persistence from the settings store (localStorage). The mode concept no longer exists at runtime.

**Files:**
- Modify: `frontend/src/lib/stores/settings.svelte.ts`

**Step 1: Edit `settings.svelte.ts`**

Remove import of `ReviewMode` (line 2):
```typescript
import type { ThemeMode, ReviewMode } from "../types/index.js";
```
Change to:
```typescript
import type { ThemeMode } from "../types/index.js";
```

Remove `mode` from `loadSettings()` (lines 8, 16, 19, 30) — the load function returns only `theme`, `autoSave`, `reviewerName`:

```typescript
function loadSettings(): {
    theme: ThemeMode;
    autoSave: boolean;
    reviewerName: string;
} {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed.theme && typeof parsed.autoSave === "boolean") {
                return {
                    theme: parsed.theme,
                    autoSave: parsed.autoSave,
                    reviewerName: parsed.reviewerName ?? "",
                };
            }
        }
    } catch {
        // ignore parse errors
    }
    return {
        theme: "system",
        autoSave: true,
        reviewerName: "",
    };
}
```

Remove `mode` from the reactive `$state` object (lines 40-49):
```typescript
export const settings = $state<{
    /** Current theme preference. */
    theme: ThemeMode;
    /** Whether reviews are automatically saved on changes. */
    autoSave: boolean;
    /** Reviewer name for evaluation output. */
    reviewerName: string;
}>(loadSettings());
```

Remove `mode` from `syncSettingsToStorage()` (line 55):
```typescript
export function syncSettingsToStorage(): void {
    const payload = JSON.stringify({
        theme: settings.theme,
        autoSave: settings.autoSave,
        reviewerName: settings.reviewerName,
    });
    localStorage.setItem(STORAGE_KEY, payload);
}
```

Remove `getMode()` and `setMode()` functions entirely (lines 76-86).

**Step 2: Run `pnpm check`**

Run: `cd frontend && pnpm check`
Expected: 0 errors. (There WILL be errors from other files still referencing `settings.mode` — that's expected; they'll be fixed in subsequent tasks.)

**Step 3: Commit**

```bash
git add frontend/src/lib/stores/settings.svelte.ts
git commit -m "refactor: remove mode from settings store"
```

---

### Task 3: Remove `mode` from ReviewStore

**Objective:** Remove the `mode` state field and all mode references from the orchestrator store. Grading sliders are disabled in the static build — the store no longer controls mode.

**Files:**
- Modify: `frontend/src/lib/stores/review.svelte.ts`

**Step 1: Edit `review.svelte.ts`**

Remove import of `ReviewMode` (line 13):
```typescript
import type { ReviewMode } from "../types/index.js";
```
Delete this line entirely (it's the only import from types/index that's ReviewMode-specific).

Remove the `mode` state field (lines 68-69):
```typescript
/** Review mode: student or teacher. */
mode = $state<ReviewMode>("student");
```
Delete both lines.

Remove `this.mode = "student"` from `reset()` (line 609) — the reset method loses that line but keeps everything else.

Update `toSession()` (line 573-583) — remove the `mode:` line:
```typescript
toSession(): ReviewSession {
    return {
        student_id: this.student_id,
        assignment_id: this.rubricStore.assignment_id,
        // mode is set to "student" for backward compat
        // tree-shaken in static build
        category_selections: this.selectionStore.toSession(),
        grading: this.gradingStore.toSession(),
        generated_text: this.generated_text,
        started_at: this.started_at,
        updated_at: new Date().toISOString(),
    };
}
```
Wait — `mode` is required in the `ReviewSession` type. Since we changed it to `mode: string`, we need to supply a default. The cleanest way:
```typescript
mode: "student"  // preserved for backward compat with saved sessions
```

**Step 2: Verify with `pnpm check`**

Run: `cd frontend && pnpm check`
Expected: Errors only in route files that reference `reviewStore.mode` — these get fixed in later tasks.

**Step 3: Run review store tests**

Run: `cd frontend && npx vitest run src/tests/stores/review.store.test.ts --reporter=verbose`
Expected: Tests that check `reviewStore.mode` (lines 560, 632) will fail. Note them for Task 12 (test updates).

**Step 4: Commit**

```bash
git add frontend/src/lib/stores/review.svelte.ts
git commit -m "refactor: remove mode state from ReviewStore"
```

---

### Task 4: Remove mode-gating from review page + import logic

**Objective:** Clean up the review page — remove mode-derived state, mode-gating around GradingSidebar, and mode-based import read-only logic.

**Files:**
- Modify: `frontend/src/routes/review/[id]/+page.svelte`

**Step 1: Edit `+page.svelte` (review page)**

Remove the `mode` derived and `teacherMode` derived (lines 71, 90-91):
```typescript
let mode = $derived(reviewStore.mode);         // delete
// ...
// Teacher mode reactive wrapper
let teacherMode = $derived(mode === "teacher");  // delete
```

Update the GradingSidebar rendering section (lines 316-328). Current code:
```svelte
{#if teacherMode || hasGradingValues}
    <GradingSidebar
        dimensions={gradingConfig.dimensions}
        {grading}
        {gradeResult}
        {totalDeductions}
        {mode}
        disabled={isReadOnly || (!teacherMode && hasGradingValues)}
        onToggleMode={() => {
            reviewStore.mode = mode === "teacher" ? "student" : "teacher";
        }}
        onUpdateDimension={handleUpdateDimension}
    />
{/if}
```

Change to — always show when `hasGradingValues` (pre-existing data from import), with sliders always disabled:
```svelte
{#if hasGradingValues}
    <GradingSidebar
        dimensions={gradingConfig.dimensions}
        {grading}
        {gradeResult}
        {totalDeductions}
        disabled={true}
        onUpdateDimension={handleUpdateDimension}
    />
{/if}
```

Now we need to update the `GradingSidebar` props (removing `mode` and `onToggleMode`). That's done in Task 5.

Simplify the import handler (lines 147-158). Current:
```typescript
let readOnly = false;
let forcedReadOnly = false;
if (settings.mode === "teacher") {
    readOnly = false;
} else if (settings.mode === "student" && hasGradingValues) {
    readOnly = true;
    forcedReadOnly = true;
}
reviewStore.is_read_only = readOnly;
reviewStore.is_forced_read_only = forcedReadOnly;
// Sync store mode with user settings so grading controls work correctly
reviewStore.mode = settings.mode;
```

Change to — only force read-only when teaching grading data exists (teacher-graded imports are view-only). Reviews without grading values respect the user's read-only preference from ImportDialog:
```typescript
if (hasGradingValues) {
    reviewStore.is_read_only = true;
    reviewStore.is_forced_read_only = true;
}
```

Rationale: students can re-import their own exports (no grading values) and continue editing by unchecking "Import as read-only" in the ImportDialog. Only teacher-graded reviews (has grading values) are locked.

The `settings` import stays — it's still used for `settings.reviewerName` in export calls (lines 344, 351). The `settings.mode` references are gone.

**Step 2: Remove unused imports**

Check if `settings` is still referenced in this file after the changes. If the only remaining use is `settings.reviewerName`, the import stays.

**Step 3: Commit**

```bash
git add frontend/src/routes/review/[id]/+page.svelte
git commit -m "refactor: remove mode-gating from review page, simplify import read-only logic"
```

---

### Task 5: Simplify GradingSidebar component

**Objective:** Remove `mode` prop, `onToggleMode` callback, and mode toggle button from the GradingSidebar. The mode toggle is dead code — grading is always read-only in the static build.

**Files:**
- Modify: `frontend/src/lib/components/grading-sidebar.svelte`

**Step 1: Edit `grading-sidebar.svelte`**

Remove `ReviewMode` from imports (lines 2-7):
```typescript
import type {
    GradeDimension,
    GradingInputs,
    GradeResult,
} from "$lib/types/index.js";
```

Remove the `mode` prop and `onToggleMode` callback from the Props interface (lines 17-34):
```typescript
interface Props {
    /** Grading dimension definitions from config. */
    dimensions: readonly GradeDimension[];
    /** Current grading input values. */
    grading: GradingInputs;
    /** Computed grade result (null if not yet calculated). */
    gradeResult: GradeResult | null;
    /** Total deduction points. */
    totalDeductions: number;
    /** Whether the grading is in read-only mode (disables sliders). */
    disabled?: boolean;
    /** Callback when a dimension's score value changes. */
    onUpdateDimension: (key: string, value: number) => void;
}
```

Remove `mode` and `onToggleMode` from the props destructuring (lines 36-45):
```typescript
let {
    dimensions,
    grading,
    gradeResult,
    totalDeductions,
    disabled = false,
    onUpdateDimension,
}: Props = $props();
```

Remove the mode toggle button from the template (lines 65-72):
```svelte
<button
    onclick={onToggleMode}
    class="inline-flex items-center rounded-full border border-border px-2 py-0.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
    aria-pressed={mode === "teacher"}
>
    {mode === "teacher" ? "Teacher" : "Student"}
</button>
```

Replace with just the heading:
```svelte
<h3 class="text-sm font-semibold tracking-tight">Grading</h3>
```

Remove the `aria-pressed` attribute reference since it's gone.

**Step 2: Verify with `pnpm check`**

Run: `cd frontend && pnpm check`
Expected: No errors from GradingSidebar. The review page (Task 4) already removed the callers.

**Step 3: Commit**

```bash
git add frontend/src/lib/components/grading-sidebar.svelte
git commit -m "refactor: remove mode toggle from GradingSidebar"
```

---

### Task 6: Remove mode card from settings + update layout

**Objective:** Remove the ModeCard from the settings page and delete the mode-card component. Clean up the layout's settings sync.

**Files:**
- Modify: `frontend/src/routes/settings/+page.svelte`
- Delete: `frontend/src/lib/components/settings/mode-card.svelte`
- Modify: `frontend/src/routes/+layout.svelte`

**Step 1: Edit `settings/+page.svelte`**

Remove the `ModeCard` import (line 4):
```svelte
import ModeCard from "$lib/components/settings/mode-card.svelte";
```

Remove the `<ModeCard />` rendering (line 31):
```svelte
<ModeCard />
```

**Step 2: Delete `mode-card.svelte`**

Delete the file at `frontend/src/lib/components/settings/mode-card.svelte`.

**Step 3: Edit `+layout.svelte`**

Remove the `void settings.mode` line (line 37) from the sync effect:
```typescript
$effect(() => {
    void settings.theme;
    void settings.autoSave;
    void settings.reviewerName;
    syncSettingsToStorage();
});
```
The layout currently syncs `settings.theme`, `settings.mode`, `settings.autoSave`, `settings.reviewerName`. Remove the `settings.mode` line.

Also check if `ReviewMode` is imported in the layout — it shouldn't be since settings.mode is just a property access.

**Step 4: Commit**

```bash
git add frontend/src/routes/settings/+page.svelte
git add frontend/src/lib/components/settings/mode-card.svelte
git add frontend/src/routes/+layout.svelte
git commit -m "refactor: remove ModeCard from settings, clean up layout sync"
```

---

### Task 7: Update landing page import logic

**Objective:** Remove mode sync from landing page's import and open-review handlers. Simplify forced read-only logic.

**Files:**
- Modify: `frontend/src/routes/+page.svelte`

**Step 1: Edit `+page.svelte`**

In `openReview()` (lines 67-78), remove the mode sync line:
```typescript
// Sync store mode with user settings so grading controls work correctly
reviewStore.mode = settings.mode;
```
Delete these 2 lines (the comment and the assignment).

In `handleImport()` (lines 106-125), replace the mode-based read-only logic:
```typescript
// Enforce forced read-only for student mode with teacher grades
const importedGrading = reviewStore.grading;
const hasGradingValues = Object.values(importedGrading).some((v) => v > 0);
if (settings.mode === "student" && hasGradingValues) {
    reviewStore.is_read_only = true;
    reviewStore.is_forced_read_only = true;
}
// Sync store mode with user settings so grading controls work correctly
reviewStore.mode = settings.mode;
```

Change to:
```typescript
// Imported reviews without grading data respect the user's read-only preference.
// Teacher-graded imports (with grading values) are always forced read-only.
const importedGrading = reviewStore.grading;
const hasGradingValues = Object.values(importedGrading).some((v) => v > 0);
if (hasGradingValues) {
    reviewStore.is_read_only = true;
    reviewStore.is_forced_read_only = true;
}
```

Rationale: the user can uncheck "Import as read-only" in the ImportDialog to continue editing their own exports. Only teacher-graded reviews (those with grading values) are locked for view-only access.

Note: the `settings` import may still be needed for `settings.reviewerName` — it's currently imported from `$lib/stores/settings.svelte.js`. Keep the import if it's still used elsewhere in this file (check for `settings.reviewerName` or `settings.mode`). After this change, `settings.mode` is no longer referenced. The import stays if `settings` is still used — but only `settings.reviewerName` is used in export calls. Since those export calls are on the review page, not the landing page... let me check.

Actually, looking at the file again, `settings` is imported on line 5. After removing `reviewStore.mode = settings.mode` and the mode-based read-only check, is `settings` still referenced? Let me search... The landing page doesn't use `settings.reviewerName` — that's used in the review page and evaluation page. So `settings` is only used for the mode sync we're removing.

Remove the `settings` import (line 5):
```typescript
import { settings } from "$lib/stores/settings.svelte.js";
```

**Step 2: Remove unused import**

After removing all `settings` references, delete the import line entirely.

**Step 3: Commit**

```bash
git add frontend/src/routes/+page.svelte
git commit -m "refactor: remove mode sync from landing page import logic"
```

---

### Task 8: Update evaluation page

**Objective:** Remove `isTeacher` gating from the evaluation page. Grading summary shows whenever grade data exists.

**Files:**
- Modify: `frontend/src/routes/review/[id]/evaluation/+page.svelte`

**Step 1: Edit `evaluation/+page.svelte`**

Remove the `isTeacher` derived (line 35):
```typescript
let isTeacher = $derived(reviewStore.mode === "teacher");
```

Update the `showGrading` prop on `EvaluationMetadata` (line 210):
```svelte
showGrading={isTeacher}
```
Change to — always show grading info when metadata renders:
```svelte
showGrading={true}
```

Update the grading summary section (line 218):
```svelte
{#if isTeacher && gradeResult}
```
Change to — show whenever grade data exists:
```svelte
{#if gradeResult}
```

**Step 2: Commit**

```bash
git add frontend/src/routes/review/[id]/evaluation/+page.svelte
git commit -m "refactor: remove isTeacher gating from evaluation page"
```

---

### Task 9: Update docs pages

**Objective:** Remove mode-gated documentation sections. "Teacher Mode" and the mode-related shortcut are removed; general keyboard shortcuts remain.

**Files:**
- Modify: `frontend/src/routes/docs/+page.svelte`
- Modify: `frontend/src/lib/components/docs-sidebar.svelte`
- Modify: `frontend/src/lib/components/docs-content.svelte`

**Step 1: Edit `docs/+page.svelte`**

Remove the `isTeacher` derived (line 23):
```typescript
let isTeacher = $derived(settings.mode === "teacher");
```
And the `settings` import (line 5) if no longer used.

Remove the spread from `sectionIds` (line 33):
```typescript
...(isTeacher ? ["teacher-mode", "shortcuts"] : []),
```
Replace with — always include shortcuts (they're still relevant), remove teacher-mode entirely:
```typescript
"shortcuts",
```

So `sectionIds` becomes:
```typescript
let sectionIds = $derived([
    "getting-started",
    "starting-review",
    "completing-review",
    "saving",
    "importing",
    "exporting",
    "previewing",
    "shortcuts",
    "faq",
]);
```

Remove `"teacher-mode"` from `sectionLabels` (line 46):
```typescript
"teacher-mode": "Teacher Mode",
```

Remove `settings` import if no longer referenced in this file.

**Step 2: Edit `docs-sidebar.svelte`**

Remove the `settings` import (line 3):
```typescript
import { settings } from "$lib/stores/settings.svelte.js";
```

Remove `isTeacher` derived (line 32):
```typescript
let isTeacher = $derived(settings.mode === "teacher");
```

Remove the `visibleNavItems` filter logic (lines 34-41). Replace with a static array without "teacher-mode":
```typescript
const navItems: NavItem[] = [
    { id: "getting-started", label: "Getting Started" },
    { id: "starting-review", label: "Starting a Review" },
    { id: "completing-review", label: "Completing a Review" },
    { id: "saving", label: "Saving & Resuming" },
    { id: "importing", label: "Importing Reviews" },
    { id: "exporting", label: "Exporting Reviews" },
    { id: "previewing", label: "Previewing Evaluations" },
    { id: "shortcuts", label: "Keyboard Shortcuts" },
    { id: "faq", label: "FAQ" },
];
```

Remove the `isTeacher` check from `visibleNavItems` — just use the static `navItems` directly. Remove the `visibleNavItems` derived entirely and use `navItems` directly.

Note: the template iterates `visibleNavItems` — change to `navItems`.

**Step 3: Edit `docs-content.svelte`**

Remove `isTeacher` derived (line 8):
```typescript
let isTeacher = $derived(settings.mode === "teacher");
```
And the `settings` import (line 5) if no longer used.

Remove the mode-toggle callout section (lines 42-50):
```svelte
{#if isTeacher}
    <p class="text-muted-foreground">
        <strong>Mode Toggle:</strong> The Teacher/Student mode switch button is only
        available on the
        <a href="{base}/settings" class="text-primary hover:underline">Settings</a> page.
        However, you can use the <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>G</kbd> keyboard shortcut
        from any page to toggle modes.
    </p>
{/if}
```

Update the "Teacher Mode" section (lines ~236-240) — remove the mode toggle mention, keep only the grading sidebar description (it's still relevant for imported reviews with grade data):
```html
<li><strong>Grading Sidebar</strong> — Five dimension sliders appear on the right side
    of the review page when a review with grading data is loaded.</li>
```

Remove the Alt+Shift+G shortcut from the shortcuts table (line 289-292):
```html
<tr>
    <td><kbd>Alt</kbd> + <kbd>Shift</kbd> + <kbd>G</kbd></td>
    <td>Toggle Teacher Mode</td>
</tr>
```

Also remove the entire "Teacher Mode" section in docs-content if it only references the mode toggle. If it has useful content about grading, keep the description but remove mode-specific instructions.

**Step 4: Commit**

```bash
git add frontend/src/routes/docs/+page.svelte
git add frontend/src/lib/components/docs-sidebar.svelte
git add frontend/src/lib/components/docs-content.svelte
git commit -m "refactor: remove teacher mode from docs, keep shortcuts and grading info"
```

---

### Task 10: Set up dual-adapter build (svelte.config.js + package.json)

**Objective:** Rewrite `svelte.config.js` to switch between `adapter-static` and `adapter-node` based on `ADAPTER` env var. Add `@sveltejs/adapter-node` dependency.

**Files:**
- Modify: `frontend/svelte.config.js`
- Modify: `frontend/package.json`

**Step 1: Edit `svelte.config.js`**

Current file:
```javascript
import adapter from "@sveltejs/adapter-static";

const dev = process.env.NODE_ENV === "development";

/** @type {import('@sveltejs/kit').Config} */
const config = {
    compilerOptions: {
        runes: ({ filename }) =>
            filename.split(/[/\\]/).includes("node_modules") ? undefined : true,
        warningFilter: (warning) => warning.code !== "a11y_autofocus",
    },
    kit: {
        adapter: adapter({
            fallback: "404.html",
        }),
        paths: {
            base: dev ? "" : "/svelte_review",
        },
    },
};

export default config;
```

Change to:
```javascript
const adapterType = process.env.ADAPTER ?? "static";

/** @type {import('@sveltejs/kit').Config} */
let config;

if (adapterType === "node") {
    // Dynamic import prevents tree-shaking issues with adapter-node
    const adapter = await import("@sveltejs/adapter-node");
    config = {
        compilerOptions: {
            runes: ({ filename }) =>
                filename.split(/[/\\]/).includes("node_modules") ? undefined : true,
            warningFilter: (warning) => warning.code !== "a11y_autofocus",
        },
        kit: {
            adapter: adapter.default(),
            paths: {
                base: "",
            },
        },
    };
} else {
    const adapter = await import("@sveltejs/adapter-static");
    const dev = process.env.NODE_ENV === "development";
    config = {
        compilerOptions: {
            runes: ({ filename }) =>
                filename.split(/[/\\]/).includes("node_modules") ? undefined : true,
            warningFilter: (warning) => warning.code !== "a11y_autofocus",
        },
        kit: {
            adapter: adapter.default({
                fallback: "404.html",
            }),
            paths: {
                base: dev ? "" : "/svelte_review",
            },
        },
    };
}

export default config;
```

Note: Since svelte.config.js runs in Node, the top-level-await pattern above works with modern Node versions. If svelte-kit has issues with this, use a require() pattern instead:

```javascript
let adapter;
let adapterConfig;

if (process.env.ADAPTER === "node") {
    adapter = (await import("@sveltejs/adapter-node")).default;
    adapterConfig = {};
} else {
    adapter = (await import("@sveltejs/adapter-static")).default;
    const dev = process.env.NODE_ENV === "development";
    adapterConfig = {
        fallback: "404.html",
    };
    config.kit.paths = {
        base: dev ? "" : "/svelte_review",
    };
}
```

Actually, the cleanest approach for SvelteKit config compatibility:

```javascript
import adapterStatic from "@sveltejs/adapter-static";
import adapterNode from "@sveltejs/adapter-node";

const isNode = process.env.ADAPTER === "node";
const adapter = isNode ? adapterNode() : adapterStatic({ fallback: "404.html" });

const config = {
    compilerOptions: {
        runes: ({ filename }) =>
            filename.split(/[/\\]/).includes("node_modules") ? undefined : true,
        warningFilter: (warning) => warning.code !== "a11y_autofocus",
    },
    kit: {
        adapter,
        paths: {
            base: process.env.NODE_ENV === "development" || isNode ? "" : "/svelte_review",
        },
    },
};

export default config;
```

This is the cleanest. Both adapters are imported statically, but the unused one gets tree-shaken at bundle time.

**Step 2: Add `@sveltejs/adapter-node` to package.json**

In `devDependencies` (alphabetically, after `@sveltejs/adapter-static`):
```json
"@sveltejs/adapter-node": "^5.5.7",
```

Check the current version of `@sveltejs/adapter-static` (^3.0.10) and `@sveltejs/kit` (^2.57.0) to determine the compatible adapter-node version. The latest compatible is `@sveltejs/adapter-node@^5.5.7` (requires `@sveltejs/kit ^2.4.0`+). Run `pnpm add -D @sveltejs/adapter-node@^5.5.7`.

**Step 3: Install the dependency**

Run: `cd frontend && pnpm install`

**Step 4: Verify both builds work**

```bash
cd frontend

# Test static build (default)
ADAPTER=static pnpm build
echo "Static build OK"

# Test node build
ADAPTER=node pnpm build
echo "Node build OK"
```

Expected: Both builds succeed. Static build creates `build/` with SPA fallback. Node build creates `build/` with server entry point.

Note: The Node build may warn about missing `+server.ts` routes — that's expected since we haven't built those yet (Phase 3+). The build should still succeed.

**Step 5: Commit**

```bash
git add frontend/svelte.config.js frontend/package.json
git commit -m "feat: add dual-adapter build (ADAPTER=static|node)"
```

---

### Task 11: Update validation schema

**Objective:** Remove the `reviewMode` Zod schema but keep backward-compatible mode parsing in the session schema.

**Files:**
- Modify: `frontend/src/lib/services/validation.ts`

**Step 1: Edit `validation.ts`**

Remove the `reviewMode` Zod schema (lines 22-23):
```typescript
/** Validates a ReviewMode value. */
const reviewMode = z.enum(["student", "teacher"]);
```
Replace with a simple `z.string()` default:
```typescript
/** Review mode string (for backward compatibility). */
const reviewMode = z.string().optional().default("student");
```

Or just inline it in the schema: change `mode: reviewMode.optional().default("student")` (line 81) to:
```typescript
mode: z.string().optional().default("student"),
```
And remove the separate `reviewMode` variable entirely.

**Step 2: Run validation tests**

Run: `cd frontend && npx vitest run src/tests/services/validation.test.ts --reporter=verbose`
Expected: All tests pass — the "defaults mode to 'student' when missing" test still works, and the "rejects invalid mode" test should now... pass because `z.string()` accepts any string. We should add a note that this test behavior changed: previously `z.enum(["student", "teacher"])` rejected anything else, now `z.string()` accepts any string.

The "rejects invalid mode" test expects `result.success === false` for `mode: "invalid"`. With `z.string()`, this will now succeed. Update the test in Task 12 to remove this test case (it's no longer relevant).

Actually, better to keep the enum but make it more permissive. Since we're keeping mode in the persisted session for backward compat, we should continue to validate it. Let's change `z.enum(["student", "teacher"])` to `z.string()` to be more permissive — the field is informational only now.

**Step 3: Commit**

```bash
git add frontend/src/lib/services/validation.ts
git commit -m "refactor: relax mode validation to string for backward compat"
```

---

### Task 12: Update tests

**Objective:** Fix all tests broken by the mode removal. Update mode-related assertions. Remove the "rejects invalid mode" test case.

**Files:**
- Modify: `frontend/src/tests/stores/review.store.test.ts`
- Modify: `frontend/src/tests/services/validation.test.ts`

**Step 1: Edit `review.store.test.ts`**

Update the session conversion test (line 560). Currently checks `session.mode === "student"`:
```typescript
expect(session.mode).toBe("student");
```
This should still work because we set `mode: "student"` in `toSession()`. Keep this assertion.

Update the reset test (line 632). Currently checks `reviewStore.mode === "student"`:
```typescript
expect(reviewStore.mode).toBe("student");
```
Since `reviewStore.mode` no longer exists, remove this assertion line. The test should check that `reset()` doesn't throw and clears the expected fields.

**Step 2: Edit `validation.test.ts`**

Update the "rejects invalid mode" test (lines 211-214):
```typescript
it("rejects invalid mode", () => {
    const invalid = { ...validSession, mode: "invalid" };
    const result = validateReviewSession(invalid);
    expect(result.success).toBe(false);
});
```
Since mode is now `z.string()`, this test would pass (success = true). Remove this test entirely or change it to expect success.

Replace with a note that mode is now permissive:
```typescript
it("accepts any string value for mode (backward compat)", () => {
    const withCustom = { ...validSession, mode: "anything" };
    const result = validateReviewSession(withCustom);
    expect(result.success).toBe(true);
    expect(result.data!.mode).toBe("anything");
});
```

**Step 3: Run all tests**

Run: `cd frontend && pnpm test`
Expected: All 150+ tests pass.

**Step 4: Commit**

```bash
git add frontend/src/tests/stores/review.store.test.ts
git add frontend/src/tests/services/validation.test.ts
git commit -m "test: update tests after mode removal"
```

---

### Task 13: Verify static build + TypeScript check

**Objective:** Final verification that everything compiles, tests pass, and the static build tree-shakes correctly.

**Step 1: TypeScript check**

Run: `cd frontend && pnpm check`
Expected: 0 errors, 0 warnings.

**Step 2: Run full test suite**

Run: `cd frontend && pnpm test`
Expected: All tests pass.

**Step 3: Build static**

Run: `ADAPTER=static pnpm build`
Expected: Build succeeds. Verify output:
```bash
ls frontend/build/ | head -20
```
Expected: No `submissions/` or `api/` page chunks.

**Step 4: Build node**

Run: `ADAPTER=node pnpm build`
Expected: Build succeeds (may have warnings about missing server routes — that's fine for Phase 1).

**Step 5: Commit**

```bash
git add -A
git commit -m "chore: final cleanup and verification"
```

---

## Files Changed Summary

| File | Change |
|------|--------|
| `frontend/src/lib/types/session.ts` | Remove `ReviewMode` type, change `mode: ReviewMode` to `mode: string` |
| `frontend/src/lib/types/index.ts` | Remove `ReviewMode` from barrel export |
| `frontend/src/lib/stores/settings.svelte.ts` | Remove mode from store, sync, load, and exports |
| `frontend/src/lib/stores/review.svelte.ts` | Remove `mode` state, remove from `reset()`, hardcode to `"student"` in `toSession()` |
| `frontend/src/routes/review/[id]/+page.svelte` | Remove mode-derived state, simplify GradingSidebar usage, simplify import read-only logic |
| `frontend/src/lib/components/grading-sidebar.svelte` | Remove `mode` prop, `onToggleMode`, mode toggle button |
| `frontend/src/routes/settings/+page.svelte` | Remove ModeCard import and rendering |
| `frontend/src/lib/components/settings/mode-card.svelte` | **Delete** |
| `frontend/src/routes/+layout.svelte` | Remove `void settings.mode` from sync effect |
| `frontend/src/routes/review/[id]/evaluation/+page.svelte` | Remove `isTeacher`, always show grading summary when data exists |
| `frontend/src/routes/+page.svelte` | Remove mode sync from import/open handlers, remove `settings` import |
| `frontend/src/routes/docs/+page.svelte` | Remove `isTeacher`, remove teacher-mode from nav, keep shortcuts |
| `frontend/src/lib/components/docs-sidebar.svelte` | Remove mode-gating, remove teacher-mode from nav items |
| `frontend/src/lib/components/docs-content.svelte` | Remove mode-toggle callout, remove Alt+Shift+G from shortcuts, remove teacher-mode section |
| `frontend/src/lib/services/validation.ts` | Relax `reviewMode` to `z.string()` for backward compat |
| `frontend/src/tests/stores/review.store.test.ts` | Remove `reviewStore.mode` assertion |
| `frontend/src/tests/services/validation.test.ts` | Update "rejects invalid mode" test |
| `frontend/svelte.config.js` | Dual-adapter build (ADAPTER=static\|node) |
| `frontend/package.json` | Add `@sveltejs/adapter-node` dependency |

---

## Verification

- [ ] `pnpm check` — 0 errors
- [ ] `pnpm test` — all tests pass
- [ ] `ADAPTER=static pnpm build` — builds cleanly
- [ ] `ADAPTER=node pnpm build` — builds cleanly (warnings about missing server routes OK)
- [ ] Phase 0 scenarios 1–3, 5–7, 8.1–8.4, 8.8–8.11, 9–11 (minus 11.4), 13 (minus 13.7–13.9) pass in static build via `pnpm preview`
- [ ] **Update Phase 0 plan** — after Phase 1 lands, the mode-dependent scenarios (4, 8.5–8.7, 11.4, 12, 13.7–13.9) should be rewritten or removed from the Phase 0 audit plan to reflect the post-Phase-1 behavior

---

## Open Questions

- **Adapter-node version**: Need to pick a version compatible with `@sveltejs/kit@^2.57.0`. The latest `@sveltejs/adapter-node@^2.x` should work. `pnpm add -D @sveltejs/adapter-node` will resolve the correct version.

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Dual-adapter config breaks existing static build | Low | High | Test both builds before merging |
| SvelteKit tree-shaking doesn't eliminate GradingSidebar toggle code | Low | Low | The toggle button and props are removed at the source level — no runtime gating |
| Backward compat with saved reviews depends on `mode: "student"` in `toSession()` | Low | Medium | Hardcoded default ensures old format compatibility |
| Broken test assertions not caught | Low | Medium | Full `pnpm test` run catches all assertion failures |
