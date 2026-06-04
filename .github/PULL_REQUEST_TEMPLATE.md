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

- [ ] `pnpm lint` passes
- [ ] `pnpm check` passes (no type errors)
- [ ] Svelte 5 runes syntax used (no `export let`, `on:click`, `$:`, `<slot>`)
- [ ] OKLCH colors used (no HSL/hex for theme variables)
- [ ] shadcn-svelte components imported from `$lib/components/ui/` (not npm)
- [ ] Lucide icons use direct path imports (`@lucide/svelte/icons/<name>`)
- [ ] New CSS variables registered in `@theme inline` in `layout.css`
- [ ] No `$state`/`$derived`/`$effect` in plain `.ts` files