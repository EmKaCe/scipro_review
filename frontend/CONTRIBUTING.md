# Contributing to SciPro Review

Thank you for your interest in contributing to SciPro Review! This guide provides everything you need to get started.

## Development Setup

### Prerequisites

- **Node.js** 22+ (recommended: latest LTS)
- **pnpm** 11+ (required — the project uses pnpm workspaces)

### Getting Started

```bash
# Clone the repository
git clone https://github.com/EmKaCe/svelte_review.git
cd svelte_review/frontend

# Install dependencies
pnpm install
```

### Running in Different Modes

The project supports two build adapters, controlled by the `ADAPTER` environment variable:

| Mode        | Adapter          | Use Case                         | Command            |
| ----------- | ---------------- | -------------------------------- | ------------------ |
| **Student** | `adapter-static` | GitHub Pages / local SPA preview | `pnpm dev:student` |
| **Teacher** | `adapter-node`   | Docker / local Node server       | `pnpm dev:teacher` |

```bash
# Student mode (default)
pnpm dev:student          # Dev server at localhost:5173
pnpm build:student        # Build → frontend/build/
pnpm start:student        # Serve static build on port 4173

# Teacher mode
pnpm dev:teacher          # Dev server (ADAPTER=node)
pnpm build:teacher        # Node build → frontend/build/
pnpm start:teacher        # Start server on port 4174
```

⚠️ Always `rm -rf build` before switching modes — the `build/` directory is shared between adapters.

### Common Commands

| Command                | Description                          |
| ---------------------- | ------------------------------------ |
| `pnpm dev:student`     | Start the dev server in student mode |
| `pnpm dev:teacher`     | Start the dev server in teacher mode |
| `pnpm build:student`   | Production build (adapter-static)    |
| `pnpm build:teacher`   | Production build (adapter-node)      |
| `pnpm preview:student` | Preview the student build            |
| `pnpm preview:teacher` | Preview the teacher build            |
| `pnpm start:student`   | Serve student build on port 4173     |
| `pnpm start:teacher`   | Serve teacher build on port 4174     |
| `pnpm check`           | Type-check with `svelte-check`       |
| `pnpm lint`            | Prettier check + ESLint              |
| `pnpm format`          | Format all files with Prettier       |
| `pnpm test`            | Run unit tests (Vitest)              |
| `pnpm test:watch`      | Run tests in watch mode              |
| `pnpm test:coverage`   | Run tests with coverage report       |

### Pre-commit Hooks

This project includes a pre-commit hook that runs `pnpm lint` and `pnpm check`
before every commit. Enable it with:

```bash
# From the repository root
git config core.hooksPath .github/hooks
```

The hook is located at `.github/hooks/pre-commit`. If either lint or type-check
fails, the commit will be aborted. You can skip hooks with `git commit --no-verify`
in an emergency.

## Project Architecture

### Tech Stack

- **Framework**: SvelteKit (dual adapter: `adapter-static` + `adapter-node`)
- **UI**: Svelte 5 with runes (`$state`, `$derived`, `$effect`)
- **Styling**: Tailwind CSS v4 (CSS-first config) + shadcn-svelte
- **Icons**: `@lucide/svelte` (direct path imports only)
- **State**: Class-based stores in `.svelte.ts` files
- **Persistence**: IndexedDB via `idb` package (student mode)
- **Data**: YAML config files in `static/data/`
- **Validation**: Zod 4 for import validation
- **Markdown**: `marked` for evaluation rendering
- **Data grid**: TanStack Svelte Table v9 (teacher dashboard)
- **Testing**: Vitest with `jsdom` and `fake-indexeddb`

### Directory Structure

```
frontend/src/
├── lib/
│   ├── components/       # Svelte UI components
│   │   ├── ui/           # shadcn-svelte primitives
│   │   ├── settings/     # Settings page cards
│   │   ├── skeleton/     # Loading skeletons
│   │   └── submissions/  # Teacher: dashboard, upload, copilot
│   ├── services/         # Business logic modules
│   │   ├── criteria-loader.ts    # YAML criteria loading
│   │   ├── grading-config.ts     # Grading config loading
│   │   ├── grade-calculator.ts   # Weighted grade calculation
│   │   ├── text-generator.ts     # Evaluation text generation
│   │   ├── session-persistence.ts # Serialization & export/import
│   │   ├── db.ts                 # IndexedDB CRUD
│   │   ├── validation.ts         # Zod schemas for imports
│   │   └── submissions-store.ts  # Stub data (Phase 3: API)
│   ├── stores/           # Reactive state (Svelte 5 runes)
│   │   ├── review.svelte.ts      # Orchestrator — composes sub-stores
│   │   ├── rubric.svelte.ts      # Rubric loading & assignment selection
│   │   ├── grading.svelte.ts     # Dimension scores & grade calculation
│   │   ├── selection.svelte.ts   # Category selections, comments, undo/redo
│   │   ├── session.svelte.ts     # IndexedDB persistence & auto-save
│   │   ├── export.svelte.ts      # YAML/MD/JSON export & import
│   │   ├── settings.svelte.ts    # App settings
│   │   ├── toast.svelte.ts       # Toast notifications
│   │   └── header.svelte.ts      # Header configuration
│   ├── types/            # TypeScript type definitions
│   │   ├── criteria.ts    # Rubric types
│   │   ├── grading.ts     # Grade dimensions & boundaries
│   │   ├── evaluation.ts  # Evaluation output types
│   │   ├── assignments.ts # Assignment registry
│   │   ├── session.ts     # Review session state
│   │   ├── persistence.ts # IDB & export types
│   │   ├── submissions.ts # Teacher submission types
│   │   └── index.ts       # Barrel exports
│   ├── utils.ts          # Utility functions
│   └── version.ts        # Build version
├── routes/
│   ├── +layout.svelte    # App shell
│   ├── +layout.ts        # SSR disabled (static mode only)
│   ├── +page.svelte      # Landing page
│   ├── docs/+page.svelte # Documentation
│   ├── review/[id]/      # Review page (student mode)
│   ├── submissions/      # Teacher dashboard (Phase 2)
│   │   ├── +page.svelte  # Submissions table
│   │   └── [id]/         # Per-submission review
│   └── settings/+page.svelte
└── tests/
    ├── setup.ts          # Vitest global setup
    └── services/         # Unit tests for service modules
```

### Key Conventions

1. **Svelte 5 Runes**: Use `$state`, `$derived`, `$effect` only in `.svelte` and `.svelte.ts` files — never in plain `.ts`.
2. **Component Syntax**: Use `$props()` instead of `export let`, `onclick` instead of `on:click`, `{#snippet}` and `{@render}` instead of `<slot>`.
3. **Colors**: OKLCH format only — no HSL or hex colors in CSS.
4. **Tailwind v4**: CSS-first config — no `tailwind.config.js`/`tailwind.config.ts`.
5. **Dark Mode**: `.dark` class toggle via `mode-watcher` — no `darkMode` config.
6. **Icons**: Import from `@lucide/svelte/icons/<name>` — avoid barrel imports.
7. **UI Components**: Use shadcn-svelte at `$lib/components/ui/<name>` — never import from npm package.
8. **Snake Case**: Data model types use `snake_case` (matching YAML keys).
9. **Branded Types**: `CategoryKey`, `DimensionKey`, `StudentId` use branded string types.
10. **Teacher features are additive**: Teacher code lives in `routes/submissions/` and `components/submissions/`. In static mode, teacher routes render pre-built pages; in Node mode, they support SSR and eventual API calls.

## Dual-Adapter Architecture

The `ADAPTER` environment variable controls which build adapter is used:

```bash
ADAPTER=node   # → adapter-node (teacher/Docker)
ADAPTER=static # → adapter-static (student/GitHub Pages, default)
```

In `svelte.config.js`, the adapter is selected at build time. Teacher-specific code is guarded by `$app/environment` checks at runtime where needed. The build output always goes to `frontend/build/` — clean this directory when switching adapters.

## Code Style

### Formatting

Prettier handles formatting. Run `pnpm format` before committing.

### Linting

ESLint with `eslint-plugin-svelte` and `typescript-eslint`. Run `pnpm lint` to check.

### Type Checking

Run `pnpm check` to verify types. All code must pass `svelte-check` with zero errors.

## Testing

### Unit Tests

Tests are located in `src/tests/`. Run with `pnpm test`.

```bash
# Run all tests
pnpm test

# Run tests in watch mode
pnpm test:watch

# Run with coverage
pnpm test:coverage
```

### Test Structure

- **Service tests**: `src/tests/services/` — tests for pure functions and business logic
- **Component tests**: Not yet implemented (planned for future phases)

### Writing Tests

- Use `vitest` for test framework
- Use `fake-indexeddb` for IndexedDB tests
- Mock `fetch` for criteria-loader and grading-config tests
- Use `jsdom` environment for DOM-dependent code

Example test:

```typescript
import { describe, it, expect } from "vitest";
import { calculateGrade } from "$lib/services/grade-calculator";

describe("calculateGrade", () => {
	it("returns 1.0 for perfect scores", () => {
		const result = calculateGrade(perfectInputs, testConfig);
		expect(result.grade).toBe(1.0);
	});
});
```

## Adding New Features

### Adding a New Rubric Category

1. Edit the appropriate YAML file in `static/data/criteria/`
2. Add the category with `title`, `additional_notes`, `positive`, `neutral`, and `negative` sections
3. No code changes needed — the app loads categories dynamically

### Adding a New Assignment

1. Add the assignment entry to `static/data/assignments.yaml`
2. Create a new criteria YAML file in `static/data/criteria/`
3. Reference the criteria file in the assignment's `criteria_files` list
4. No code changes needed

### Adding a Teacher UI Component

1. Create the component in `src/lib/components/submissions/`
2. If it connects to data, create or extend the submissions-store service
3. If it defines new types, add them to `src/lib/types/submissions.ts`
4. Wire the component into the route page (`src/routes/submissions/`)

### Adding a New shadcn-svelte UI Component

```bash
cd frontend
pnpm dlx shadcn-svelte@latest add <component>
```

## Data Files

### YAML Structure

All data files use `snake_case` keys:

- `assignments.yaml` — Assignment registry with `id`, `title`, `enabled`, `criteria_files`, `dimensions`
- `grading_config.yaml` — Grading dimensions and grade boundaries
- `criteria/*.yaml` — Rubric categories with `title`, `additional_notes`, `positive`, `neutral`, `negative`

### Adding New Data

1. Create or edit the YAML file in `static/data/`
2. Follow the existing `snake_case` key convention
3. Test by loading the app and verifying the data appears correctly

## Deployment

The app deploys to GitHub Pages on push to `main`:

1. GitHub Actions runs `pnpm lint` + `pnpm check`
2. On success, builds with `pnpm build:student` (adapter-static)
3. Deploys using `actions/deploy-pages@v5`
4. Uses `adapter-static` with `fallback: "200.html"` (SPA mode)

For the teacher mode, a separate Docker deployment is planned (Phase 3+).

## Reporting Issues

When reporting bugs, please include:

1. Browser and version
2. Steps to reproduce
3. Expected vs. actual behavior
4. Console errors (if any)
5. Whether the issue occurs in both light and dark mode
6. Whether it affects student mode, teacher mode, or both

## Releases

Releases are produced from a `v*.*.*` git tag. The `.github/workflows/release.yml` workflow creates the GitHub Release (with auto-generated notes) and the `.github/workflows/deploy.yml` workflow deploys the static build to GitHub Pages.

To cut a release:

1. Bump the version in `frontend/package.json` (e.g. `2.3.1` → `2.3.2`).
2. Commit and push to `main` (CI must be green).
3. Tag the merge commit and push the tag:
    ```bash
    git tag vX.Y.Z
    git push origin vX.Y.Z
    ```
4. The release workflow will:
    - Verify the tag matches `frontend/package.json`.
    - Create a GitHub Release titled `vX.Y.Z` with notes generated from the commits since the previous `v*` tag.
    - The deploy workflow will publish the production build to GitHub Pages.

To re-publish a release (e.g. after fixing notes), use the **Run workflow** button on the `release.yml` workflow and optionally specify the tag in the input.

## License

This project is licensed under the GNU Affero General Public License v3.0 (AGPL v3.0).
