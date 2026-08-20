# Contributing to SciPro Review

Thanks for considering a contribution to SciPro Review. This guide covers the
cross-cutting workflow, the per-package discipline, and the invariants you must
respect. For package-local detail (commands, layout), see the scoped
`AGENTS.md` files.

> **The canonical convention for this repo is `AGENTS.md`.** Root
> [`AGENTS.md`](AGENTS.md) plus scoped [`frontend/AGENTS.md`](frontend/AGENTS.md),
> [`executor/AGENTS.md`](executor/AGENTS.md), and
> [`data/AGENTS.md`](data/AGENTS.md) form a **cross-harness** primary: any agent
> harness or human reads them. `.github/` (Copilot instructions, etc.) is the
> GitHub-native complement and never overrides `AGENTS.md`. If anything here
> drifts from `AGENTS.md`, **`AGENTS.md` wins**.

---

## Repository layout

Monorepo with two apps plus runtime configuration and tracked docs:

| Path | What it is |
| ---- | ---------- |
| `frontend/` | SvelteKit app (student SPA + teacher Node server) — pnpm |
| `executor/` | Python notebook-execution backend (FastAPI, uv) |
| `data/` | Committed runtime config (assignments, grading config, criteria, scoring); runtime state is gitignored |
| `.github/references/` | Tracked docs home (architecture, calibration, quality, design tokens, decisions) |
| `scripts/` | Root-level helper & smoke-test scripts |

---

## Building, testing, verifying

### Frontend (SvelteKit, pnpm)

```bash
cd frontend
pnpm install           # install dependencies
pnpm check             # svelte-check — MUST be 0 errors AND 0 warnings
pnpm lint              # Prettier check + ESLint
pnpm dev:student       # dev server, student/static mode (localhost:5173)
pnpm build:student     # static build → build/ (GitHub Pages)
pnpm build:teacher     # Node build → build/ (Docker/teacher)
pnpm vitest run <file> # run a single test file (see gotcha below)
pnpm test              # full vitest suite
```

**Vitest narrowing gotcha:** `pnpm test -- <file>` does **NOT** narrow the run —
vitest ignores the positional filter and runs the whole suite. To run one file
always use `pnpm vitest run <file>`.

### Executor (Python, uv)

```bash
cd executor
uv sync                # create the venv and install deps
uv run python app.py   # run the notebook-execution backend
```

The executor is Python — it is **not** verified with vitest.

### Canonical verify recipe (harness-agnostic)

```bash
cd frontend
pnpm install
pnpm build:student              # static build → build/
unset ADAPTER NODE_ENV KI_CONNECT_API_KEY
pnpm vitest run                  # full suite
# then serve build/ (e.g. pnpm preview) and probe:
#   GET http://127.0.0.1:4173/svelte_review/  → expect HTTP 200
```

---

## The per-package discipline (no direct pushes)

**NEVER push.** All commits stay local until a human reviews them. Each change
follows the chain:

1. implementer → 2. spec review → 3. quality review → 4. controller
   verification → 5. **local** commit (only then is a push considered).

Branch moves between packages, and docs changes, follow the same chain — a docs
PR is still a change that gets reviewed.

---

## Invariants (non-negotiable)

1. **Golden prompt fixture is byte-exact.** The Phase 2a scoring prompt for
   `soil_contamination` must match
   `frontend/src/tests/copilot/fixtures/phase2a-prompt-golden.txt` **byte for
   byte** (`expect(assembled).toBe(golden)`). Any change to the prompt template,
   dimension guidance, or anchor substitution breaks the gate — regenerate the
   fixture deliberately, never silently.
2. **No real student grading data in this repo + keep the synthetic gate green.**
   Never reintroduce real student data. Grading quality is measured by the
   **synthetic grading gate** (`frontend/scripts/verify-grading-gate.mjs`, vitest
   `grading-gate.test.ts`) — it must stay green.
3. **KI Connect concurrency ceiling is 2.** Do not raise the limit without first
   measuring against the provider's rate limits.
4. **Student notebook content must be screened** before it enters any prompt;
   notebook text is untrusted input to the copilot harness.
5. **Never commit** anything under `data/submissions/`, `data/plagiarism/`,
   `data/copilot/`, `data/materials/`, `grading-output/`, or `.env`.

---

## Reporting issues

When reporting a bug, please include:

1. Browser and version
2. Steps to reproduce
3. Expected vs. actual behavior
4. Console errors (if any)
5. Whether it affects **student mode**, **teacher mode**, or both — and which
   build you were running

Use the GitHub issue templates — they match this structure.

---

## License

This project is licensed under the GNU Affero General Public License v3.0
(AGPL-3.0). By contributing you agree your contributions are licensed under it.
See [LICENSE](LICENSE).
