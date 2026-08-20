# AGENTS.md — SciPro Review (cross-harness)

This file is the **cross-harness agent convention** for this repository. It is
read by any agent harness (Claude Code / Codex, Gemini CLI, Cursor, and
GitHub Copilot all honor `AGENTS.md`). Treat it as the primary source of truth
for working in this repo. Harness-specific config lives alongside it:

- `.github/agents/*.agent.md`, `.github/instructions/`,
  `.github/copilot-instructions.md`, `.github/skills/` — **GitHub Copilot
  specific** config that complements (never overrides) this file.
- Scoped `AGENTS.md` files (see the layout below) refine this file for a
  single subproject. When a scoped file and this root file disagree, the
  **scoped file wins** for work inside that subproject.

## Repository layout

Monorepo with two apps plus runtime configuration and tracked docs:

| Path | What it is |
| ---- | ---------- |
| `frontend/` | SvelteKit app (Svelte 5 runes, Tailwind CSS v4, pnpm). Ships two builds: **student** (`ADAPTER=static`, GitHub Pages SPA) and **teacher** (`ADAPTER=node`, Node/Docker server). |
| `executor/` | Python notebook-execution backend (FastAPI, Python, managed with uv — pinned via `executor/.python-version`, currently 3.12). |
| `data/` | Runtime configuration: `assignments.yaml`, `grading_config.yaml`, `settings.yaml`, `criteria/*.yaml`, `scoring/*.yaml`, `cohort_norms/*.yaml` — **tracked**. Runtime state (`submissions/`, `plagiarism/`, `copilot/`, `materials/`) is **gitignored**. |
| `.github/` | GitHub-native config and workflows; `references/` is the tracked docs home (calibration, quality statement, design tokens, schema specs). |
| `.github/references/directives/` | Tracked, **non-negotiable pipeline contracts** (e.g. `turn-based-preeval.md`). |
| `scripts/` | Root-level helper / smoke-test scripts. |

Scoped conventions: `frontend/AGENTS.md`, `executor/AGENTS.md`,
`data/AGENTS.md`.

## Build / test / verify

### Frontend (SvelteKit, pnpm)

```bash
cd frontend
pnpm install           # install dependencies
pnpm check             # svelte-check — MUST be 0 errors AND 0 warnings
pnpm dev:student       # dev server, student/static mode (localhost:5173)
pnpm build:student     # static build → build/ (GitHub Pages)
pnpm build:teacher     # Node build → build/ (Docker/teacher)
pnpm vitest run <file> # run a single test file (see gotcha below)
pnpm test              # full vitest suite ≈ 117 files / ~1431 tests
```

**Vitest narrowing gotcha:** `pnpm test -- <file>` does **NOT** narrow the run —
vitest ignores the positional filter and runs the whole suite. To run one file
always use `pnpm vitest run <file>`.

### Executor (Python, uv)

```bash
cd executor
uv sync                # create the virtual env and install deps
uv run python app.py   # run the notebook-execution backend
```

The executor is Python — it is **not** verified with vitest. Canonical
verification for the whole project (harness-agnostic — any agent can run it):

```bash
cd frontend
pnpm install
pnpm build:student              # static build → build/
unset ADAPTER NODE_ENV KI_CONNECT_API_KEY
pnpm vitest run                  # full suite (≈123 files / ~1488 tests)
# then serve build/ (e.g. pnpm preview) and probe:
#   GET http://127.0.0.1:4173/svelte_review/  → expect HTTP 200
```

## The per-package discipline (no direct pushes)

**NEVER push** — all commits stay local until the human reviews them. Each
change follows the chain:

1. implementer → 2. spec review → 3. quality review → 4. controller
   verification → 5. **local** commit (only then is a push considered).

## Key invariants

1. **Golden prompt fixture is byte-exact.** The Phase 2a scoring prompt for
   `soil_contamination` must match
   `frontend/src/tests/copilot/fixtures/phase2a-prompt-golden.txt` **byte for
   byte**. It is asserted with `expect(assembled).toBe(golden)` in
   `scoring-config.test.ts`. Any change to the prompt template, dimension
   guidance, or anchor substitution breaks the gate — regenerate the fixture
   deliberately, never silently.
2. **No real student grading data in this repo + keep the synthetic gate green.**
   Submission notebooks, grades, cohort norms, and grading-output are excluded
   (gitignored or removed 2026-08-20 for privacy). Never reintroduce real
   student data. Grading quality is measured by the **synthetic grading gate**
   (`frontend/scripts/verify-grading-gate.mjs`, vitest
   `grading-gate.test.ts`) — it must pass (CLI exit 0 / test green).
3. **KI Connect concurrency ceiling is 2.** Do **not** raise the concurrency
   limit without first measuring against KI Connect's rate limits.
4. **Student notebook content must be screened** before it enters any prompt.
   Notebook text is treated as untrusted input to the copilot harness.
5. **Never commit** anything under `data/submissions/`, `data/plagiarism/`,
   `data/copilot/`, `data/materials/`, `grading-output/`, or `.env`.

## KI Connect endpoint abstraction

`frontend/src/lib/server/ki-connect.ts` is an OpenAI-compatible endpoint
abstraction (`KIConnect`). **Any harness** that speaks the OpenAI-compatible
protocol can hit it — you are not limited to the built-in copilot wiring when
integrating an external agent or CLI.
