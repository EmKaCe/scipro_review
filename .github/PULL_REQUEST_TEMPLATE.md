## Description

<!-- What does this PR change and why? -->

## Type of Change

- [ ] 🐛 Bug fix
- [ ] ✨ New feature
- [ ] ♻️ Refactor
- [ ] 🎨 Style/CSS
- [ ] 📝 Documentation
- [ ] 🔧 Config/Tooling

## Checklist

Gates (see root `AGENTS.md` — the canonical verify recipe and invariants):

- [ ] `pnpm lint` passes
- [ ] `pnpm check` passes — **0 errors AND 0 warnings**
- [ ] `pnpm vitest run` passes (full suite)
- [ ] Synthetic grading gate green (`pnpm vitest run grading-gate.test.ts` / `verify-grading-gate.mjs` exit 0)
- [ ] No real student data introduced (invariants #2/#5 — gitignored paths stay clean)
- [ ] Golden `phase2a` prompt fixture byte-exact (or regenerated deliberately, never silently)
- [ ] **No `git push`** — commits stay local for the review chain
- [ ] KI Connect concurrency ceiling (invariant #3) left at 2 unless explicitly measured

Conventions:

- [ ] Svelte 5 runes syntax used (no `export let`, `on:click`, `$:`, `<slot>`)
- [ ] OKLCH colors used (no HSL/hex for theme variables)
- [ ] shadcn-svelte components imported from `$lib/components/ui/` (not npm)
- [ ] Lucide icons use direct path imports (`@lucide/svelte/icons/<name>`)
- [ ] New CSS variables registered in `@theme inline` in `layout.css`
- [ ] No `$state`/`$derived`/`$effect` in plain `.ts` files