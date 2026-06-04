# SciPro Review

> Peer-review and grading tool for Jupyter notebook submissions. Designed for Scientific Programming in Python courses at the Bonn-Rhein-Sieg University of Applied Sciences.

**Live URL:** [emkace.github.io/svelte_review](https://emkace.github.io/svelte_review/)

---

## Overview

SciPro Review is a client-side web application for structured peer review and grading of Jupyter notebook assignments. All data persists locally in the browser via IndexedDB — no server required.

### Key Features

- **Structured rubric evaluation** — Checklist-based review across multiple categories
- **Real-time grading** — German 1.0–5.0 scale with weighted dimension scores
- **Auto-generated evaluation text** — Markdown export for feedback delivery
- **Import/Export** — YAML, Markdown, and JSON formats with round-trip support
- **Undo/Redo** — Full history management for review sessions
- **Dark mode** — System-aware theme with manual override
- **Mobile responsive** — Usable on tablets and phones
- **Print-friendly** — Evaluation pages optimized for printing

---

## Tech Stack

| Technology      | Purpose                                         |
| --------------- | ----------------------------------------------- |
| SvelteKit 2     | App framework (SPA mode)                        |
| Svelte 5        | UI with runes (`$state`, `$derived`, `$effect`) |
| Tailwind CSS v4 | Utility-first styling                           |
| shadcn-svelte   | UI primitive components                         |
| TypeScript 6    | Type-safe source                                |
| IndexedDB       | Client-side persistence                         |
| js-yaml         | Criteria loading and export                     |
| Zod 4           | Import validation                               |
| marked          | Evaluation Markdown rendering                   |
| Vitest          | Unit testing                                    |

---

## Development Setup

### Prerequisites

- **Node.js** 22+
- **pnpm** 11+

### Getting Started

```bash
# Clone the repository
git clone https://github.com/EmKaCe/svelte_review.git
cd svelte_review/frontend

# Install dependencies
pnpm install

# Start the dev server
pnpm dev
```

The app will be available at `http://localhost:5173`.

### Common Commands

| Command              | Description                    |
| -------------------- | ------------------------------ |
| `pnpm dev`           | Start dev server with HMR      |
| `pnpm build`         | Production build               |
| `pnpm preview`       | Preview production build       |
| `pnpm check`         | Type-check with `svelte-check` |
| `pnpm lint`          | Prettier check + ESLint        |
| `pnpm format`        | Format all files               |
| `pnpm test`          | Run unit tests (Vitest)        |
| `pnpm test:watch`    | Tests in watch mode            |
| `pnpm test:coverage` | Tests with coverage            |

---

## Project Structure

```
frontend/src/
├── lib/
│   ├── components/       # Svelte UI components
│   │   ├── ui/           # shadcn-svelte primitives
│   │   ├── settings/     # Settings page cards
│   │   └── skeleton/     # Loading skeletons
│   ├── services/         # Business logic
│   │   ├── criteria-loader.ts    # YAML criteria loading
│   │   ├── grading-config.ts     # Grading config loading
│   │   ├── grade-calculator.ts   # Weighted grade calculation
│   │   ├── text-generator.ts     # Evaluation text generation
│   │   ├── session-persistence.ts # Serialization & export/import
│   │   ├── db.ts                 # IndexedDB CRUD
│   │   └── validation.ts         # Zod schemas for imports
│   ├── stores/           # Reactive state (Svelte 5 runes)
   │   ├── review.svelte.ts      # Orchestrator — composes sub-stores
   │   ├── rubric.svelte.ts      # Rubric loading & assignment selection
   │   ├── grading.svelte.ts     # Dimension scores & grade calculation
   │   ├── selection.svelte.ts   # Category selections, comments, undo/redo
   │   ├── session.svelte.ts     # IndexedDB persistence & auto-save
   │   ├── export.svelte.ts      # YAML/MD/JSON export & import
│   │   ├── settings.svelte.ts    # App settings
│   │   ├── toast.svelte.ts       # Toast notifications
│   │   └── header.svelte.ts      # Header configuration
│   ├── types/            # TypeScript type definitions (v2)
│   │   ├── criteria.ts
│   │   ├── grading.ts
│   │   ├── evaluation.ts
│   │   ├── assignments.ts
│   │   ├── session.ts
│   │   ├── persistence.ts
│   │   └── index.ts
│   ├── utils.ts          # Utility functions
│   └── version.ts        # Build version
├── routes/
│   ├── +layout.svelte    # App shell
│   ├── +layout.ts        # SSR disabled
│   ├── +page.svelte      # Landing page
│   ├── docs/+page.svelte # Documentation
│   ├── review/[id]/      # Review page (dynamic)
│   └── settings/+page.svelte
└── tests/
    ├── setup.ts          # Vitest global setup
    └── services/         # Unit tests (151 tests)
```

---

## Architecture

### Data Flow

```
assignments.yaml → select assignment → load criteria YAML
                                          ↓
                                    MergedRubric
                                          ↓
                              ReviewStore (category selections,
                              grading inputs, undo/redo)
                                          ↓
                              IndexedDB (auto-save + manual save)
                                          ↓
                              Export (YAML / Markdown / JSON)
```

### State Management

The app uses **class-based stores** in `.svelte.ts` files with Svelte 5 runes.
The `ReviewStore` is an **orchestrator** that composes focused sub-stores:

| Store | Responsibility |
|-------|--------------|
| `review.svelte.ts` | Orchestrator — bridges sub-stores, preserves public API |
| `rubric.svelte.ts` | Rubric loading, assignment selection, grading config |
| `grading.svelte.ts` | Dimension scores, grade calculation |
| `selection.svelte.ts` | Category selections, comments, deductions, notes, undo/redo |
| `session.svelte.ts` | IndexedDB persistence, auto-save, saved reviews list |
| `export.svelte.ts` | YAML/MD/JSON export, import, download |
| `settings.svelte.ts` | Theme, mode, reviewer name (persisted to localStorage) |
| `toast.svelte.ts` | Toast notifications |
- **`toast.svelte.ts`** — Notification system with auto-dismiss
- **`header.svelte.ts`** — Header configuration per page

### Type System (v2)

Strict separation between **config** (read-only YAML-derived) and **state** (mutable session):

- `CategoryKey`, `DimensionKey`, `StudentId` — Branded types prevent accidental mixing
- `snake_case` throughout — matches YAML keys
- `Set<string>` for checked items — O(1) lookup

---

## CI/CD

- **CI** (`.github/workflows/ci.yml`): Runs `pnpm lint` + `pnpm check` on push/PR
- **Deploy** (`.github/workflows/deploy.yml`): Builds and deploys to GitHub Pages on push to `main`
- **Dependabot**: Weekly dependency updates with auto-merge for minor/patch

---

## Contributing

See [`frontend/CONTRIBUTING.md`](frontend/CONTRIBUTING.md) for detailed setup, conventions, and contribution guidelines.

---

## License

This project is licensed under the [GNU Affero General Public License v3.0 (AGPL-3.0)](LICENSE).
