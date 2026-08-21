---
applyTo: "**/*.css"
excludeAgent: "code-review"
---

# CSS Instructions (.css)

This project uses **Tailwind CSS v4** with CSS-first configuration. The main CSS entry point is `frontend/src/routes/layout.css`. There is NO `tailwind.config.js`/`tailwind.config.ts`.

## Tailwind v4 Architecture

### CSS Entry Point Structure
```css
@import 'tailwindcss';
@import "tw-animate-css";
@import "shadcn-svelte/tailwind.css";
@import "@fontsource-variable/geist";

@custom-variant dark (&:is(.dark *));
@plugin '@tailwindcss/forms';
@plugin '@tailwindcss/typography';

:root { /* light theme OKLCH variables */ }
.dark { /* dark theme OKLCH variables */ }

@theme inline { /* bridges CSS vars → Tailwind utilities */ }
@layer base { /* base styles */ }
```

### Critical Rules

#### ❌ No `tailwind.config.js`/`tailwind.config.ts`
Tailwind v4 uses CSS-based configuration. Never create a config file.

#### ❌ No `postcss.config.js`
The `@tailwindcss/vite` plugin replaces PostCSS. Do not add PostCSS config.

#### ❌ No `@tailwind` Directives
Do not use `@tailwind base; @tailwind components; @tailwind utilities;` — use `@import 'tailwindcss'` instead.

#### ✅ OKLCH Colors Only
All theme colors must use `oklch()` format. Never use hex, HSL, or RGB for theme variables:
```css
--primary: oklch(0.508 0.118 165.612);   /* ✅ correct */
--primary: #0a8a5e;                        /* ❌ wrong */
--primary: hsl(160, 84%, 29%);             /* ❌ wrong */
```

#### ✅ Two-Layer Variable System
This project has two separate variable systems:

| Layer | Where | Purpose | Example |
|-------|-------|---------|---------|
| **shadcn CSS vars** | `:root` / `.dark` | Theme switching (light/dark) | `--primary: oklch(...)` |
| **Tailwind `@theme`** | `@theme inline` | Generate utility classes | `--color-primary: var(--primary)` |

The `@theme inline` block bridges shadcn variables into Tailwind. **Never define OKLCH values directly in `@theme`** for colors that need dark mode — define them in `:root`/`.dark` and reference via `var()` in `@theme inline`.

## Procedures

### Adding a New Design Token
1. Determine the namespace: `--color-*`, `--font-*`, `--radius-*`, etc.
2. If the token needs dark mode support, define it in `:root` and `.dark` blocks
3. Bridge to Tailwind in `@theme inline`: `--color-brand: var(--brand)`
4. Now `bg-brand`, `text-brand`, etc. work and respond to dark mode

### Adding a Custom Variant
```css
@custom-variant hocus (&:hover, &:focus);
```

### Adding a Custom Utility
```css
@utility scrollbar-hidden {
  &::-webkit-scrollbar { display: none; }
  scrollbar-width: none;
}
```
Use in markup: `class="scrollbar-hidden"`

### Adding Base Styles
```css
@layer base {
  * { @apply border-border outline-ring/50; }
  body { @apply bg-background text-foreground; }
}
```

### Using the Typography Plugin
```svelte
<div class="prose prose-slate dark:prose-invert">
  {@html renderedMarkdown}
</div>
```

## Dark Mode
- Dark mode uses class-based toggling via `mode-watcher`
- The `.dark` class is toggled on `<html>` element
- Use `dark:` variant: `dark:bg-gray-800 dark:text-white`
- The `@custom-variant dark (&:is(.dark *))` enables this
- **No `darkMode` config** — this is CSS-based in v4

## `@theme inline` vs `@theme`
- Use `@theme inline` when referencing `var()` — without it, CSS variable resolution can produce wrong values in nested DOM
- Use plain `@theme` only for static values (no `var()` references)

## Gotchas
- **Dynamic class names don't work**: `bg-${color}-500` will NOT be detected. Use complete class names or define them in `@theme`
- **`@theme` must be top-level**: Cannot nest `@theme` inside selectors or media queries
- **Reset a namespace with `initial`**: `--color-*: initial;` in `@theme` removes all default colors
- **`prettier-plugin-tailwindcss` auto-sorts classes**: Don't manually reorder Tailwind classes
- **`@plugin` replaces JS plugin config**: Plugins are loaded via `@plugin '@tailwindcss/forms'` in CSS
- **Svelte `class:` directives work**: `class:bg-primary={active}` is valid
- **Scoped styles use `:where()`**: Svelte 5 uses `:where(.svelte-xyz123)` for low-specificity scoping
