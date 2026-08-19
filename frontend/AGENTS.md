# AGENTS.md — frontend/ (SvelteKit app)

Frontend-specific conventions for the SvelteKit app. Read the
[root `AGENTS.md`](../AGENTS.md) first — the root file's layout, per-package
discipline, and key invariants apply here too. This file only adds
frontend-local detail.

## Stack

SvelteKit 2, Svelte 5 **runes** (`$state`, `$derived`, `$effect` — only in
`.svelte`/`.svelte.ts`, never plain `.ts`), Tailwind CSS v4, TypeScript,
Vitest. Managed with **pnpm**.

## Commands

```bash
pnpm install           # install dependencies
pnpm check             # svelte-check — MUST be 0 errors AND 0 warnings
pnpm dev:student       # student/static mode  (localhost:5173)
pnpm dev:teacher       # teacher/node mode    (localhost:5173, ADAPTER=node)
pnpm build:student     # static build → build/
pnpm build:teacher     # Node build → build/
pnpm vitest run <file> # run a single test file
pnpm test              # full suite ≈ 117 files / ~1431 tests
```

**Vitest narrowing gotcha:** `pnpm test -- <file>` does **NOT** narrow the
run — vitest ignores the positional filter and runs the whole suite. Use
**`pnpm vitest run <file>`** to run one file.

## Verification

- Type-check: `pnpm check` (hard gate: 0 errors / 0 warnings).
- Whole-project canonical verify (install → build → tests → preview probe):
  `hermes verify --json` (from the repo root).
- Karl ground-truth gate: `cd frontend && python3 scripts/verify-karl-gate.py`.

## Frontend invariants

1. **Golden prompt is byte-exact.** The Phase 2a `soil_contamination` scoring
   prompt must match
   `src/tests/copilot/fixtures/phase2a-prompt-golden.txt` byte for byte,
   asserted by `expect(assembled).toBe(golden)` in
   `src/tests/copilot/scoring-config.test.ts`. Do not modify the fixture
   silently.
2. **KI Connect** (`src/lib/server/ki-connect.ts`) is an OpenAI-compatible
   endpoint abstraction — any harness can hit it.
