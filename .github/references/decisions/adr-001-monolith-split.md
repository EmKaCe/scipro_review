# ADR-001 — Monolith package split (rejected)

> **Status**: Accepted (2026-08-20) · **Decision**: **Do NOT split** the
> frontend into multiple published packages. The existing in-app module
> extraction is the chosen structure.

## Context

This repo ships a SvelteKit frontend (`frontend/`) and a Python executor
(`executor/`) — already two packages. The copilot/pre-evaluation logic lives
under `frontend/src/lib/server/copilot/` with ~26 modules. At one point the
question was raised whether to split that into a multi-package workspace
(e.g. `@repo/worksheet`, `@repo/pipeline`, `@repo/scoring` via pnpm workspaces
/ Turborepo).

Two goals drove the question, and they pull in opposite directions here:

- **Maintainability / fast onboarding** — new maintainers should get up to
  speed quickly without tripping over tooling.
- **The teacher can actually use it for grading** — the primary user, the instructor
  taking over, does **not** write code; they run and grade.

## Decision

**Do not perform a package split.** The frontend stays one package. Internal
modularity (already extracted by the "Wave 0" refactor, `12c278f`) is the
storage structure, and it is sufficient.

Concretely:

1. No `pnpm-workspace.yaml`, no Turborepo/nx, no published `@repo/*` packages.
2. The logical decomposition already in place (`pipeline/{prompts,context,
   phases,validate}.ts`, `pre-analysis.ts`, `worksheet.ts`, `post-process.ts`,
   `cohort-calibration.ts`, `scoring-config.ts`, `grading-gate.ts`,
   `screening.ts`, `tools/`, `agent.ts`) is the real "modularity" and is kept.
3. New code follows the existing single-package module conventions; large
   cohesive modules (e.g. `post-process.ts`, `agent.ts`) may stay large —
   big ≠ monolithic, they are single-responsibility units.

## Why

- **Zero benefit to the actual user.** The teacher grades; they do not consume
  packages. A split is invisible to the grading experience.
- **Real cost / risk.** A workspace adds build config, new import boundaries,
  package-manifest churn, and a bigger CI/build surface — exactly the
  "tooling issues" that slow a new maintainer's first run. `pnpm check` +
  full vitest already keep the single package coherent.
- **The pain the split was meant to solve is already gone.** `pre-evaluation.ts`
  was ~2,700 lines with prompts/context/phases inline; Wave 0 reduced it to
  ~980 lines by extracting `pipeline/*`. The remaining large files are
  single-responsibility and well-named.

## Alternatives considered

- **Full package split** (pnpm workspaces + Turborepo): rejected — cost without
  user benefit, adds tooling friction.
- **Monorepo tooling without publishing** (e.g. `turbo` over in-repo packages):
  rejected — same build complexity for no publishing benefit in a two-app repo.
- **Leave as-is** → **chosen**; declare Wave 0's in-app decomposition the
  resolution and stop treating "monolith split" as an open item.

## Consequences

- New maintainers read one package: `frontend/src/lib/server/copilot/` + the
  [Architecture](../architecture.md) module map. No workspace indirection.
- If a future contributor genuinely needs to publish a leaf module (out of
  scope for this teaching tool), the single-package layout is trivially
  extractable later — that decision can be made *then*, with the new user's
  actual needs in hand.

## Related

- [Concepts & trust boundaries](../concepts.md) — the explainable mental model.
- [Architecture](../architecture.md) §3 — the module map this decision keeps.
