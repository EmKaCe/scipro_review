---
name: tailwindcss
description: "Use when: styling with Tailwind CSS v4, configuring @theme or @custom-variant, adding OKLCH colors, using @tailwindcss/forms or @tailwindcss/typography, debugging dark mode class-toggle, resolving shadcn-svelte CSS variable conflicts, or troubleshooting CSS build issues in a SvelteKit + Svelte 5 project."
argument-hint: "<styling-task>"
---

# Tailwind CSS v4

Style a SvelteKit + Svelte 5 project using Tailwind CSS v4 with the `@tailwindcss/vite` plugin. The project uses OKLCH colors, class-based dark mode, and shadcn-svelte CSS variable theming.

## When to Use

- Writing or debugging Tailwind utility classes
- Adding or modifying `@theme` design tokens
- Configuring `@custom-variant` (e.g., dark mode)
- Adding Tailwind plugins (`@plugin` for forms, typography)
- Resolving conflicts between Tailwind `@theme` and shadcn-svelte CSS variables
- Troubleshooting CSS build or HMR issues

## Project Setup (already configured)

**Vite plugin** (`frontend/vite.config.ts`):
```ts
import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({ plugins: [tailwindcss(), sveltekit()] });
```

**CSS entry point** (`frontend/src/routes/layout.css`):
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

## Procedures

### Adding a new design token

1. Determine the namespace: `--color-*`, `--font-*`, `--text-*`, `--spacing-*`, `--radius-*`, `--shadow-*`, etc.
2. If the token should generate a utility class (e.g., `bg-brand`), add it in `@theme`.
3. If the token references another CSS variable, use `@theme inline` to avoid resolution issues.
4. If the token is a plain CSS variable (no utility needed), add it under `:root`.

**Example — add a brand color that works with dark mode:**
```css
/* In :root / .dark blocks (shadcn pattern) */
:root { --brand: oklch(0.5 0.15 250); }
.dark { --brand: oklch(0.7 0.15 250); }

/* In @theme inline (bridge to Tailwind) */
@theme inline {
  --color-brand: var(--brand);
}
```
Now `bg-brand`, `text-brand`, etc. work and respond to dark mode.

### Adding a custom variant

Use `@custom-variant` in the CSS entry point:

```css
/* Shorthand syntax (single selector) */
@custom-variant hocus (&:hover, &:focus);

/* Block syntax (multiple rules) */
@custom-variant any-hover {
  @media (any-hover: hover) {
    &:hover { @slot; }
  }
}
```

### Using the typography plugin

Wrap long-form content (markdown, articles) with `prose` classes:

```svelte
<div class="prose prose-slate dark:prose-invert">
  {@html renderedMarkdown}
</div>
```

### Using the forms plugin

`@tailwindcss/forms` is loaded via `@plugin` and applies automatically. It resets form elements for consistent styling. No extra classes needed — just style form elements with Tailwind utilities as usual.

### Adding a custom utility

Use `@utility` for one-off utilities that Tailwind doesn't provide:

```css
@utility scrollbar-hidden {
  &::-webkit-scrollbar { display: none; }
  scrollbar-width: none;
}
```
Use in markup: `class="scrollbar-hidden"`. Works with variants: `hover:scrollbar-hidden`.

### Adding base styles

Use `@layer base` for element-level defaults:

```css
@layer base {
  h1 { font-size: var(--text-2xl); }
  a { color: var(--color-primary); }
}
```

## Architecture: Two Layers of Variables

This project has **two separate variable systems** that must coexist:

| Layer | Where | Purpose | Example |
|-------|-------|---------|---------|
| **shadcn CSS vars** | `:root` / `.dark` | Theme switching (light/dark) | `--primary: oklch(...)` |
| **Tailwind `@theme`** | `@theme inline` | Generate utility classes | `--color-primary: var(--primary)` |

The `@theme inline` block bridges shadcn variables into Tailwind. **Never define OKLCH values directly in `@theme`** for colors that need dark mode — define them in `:root`/`.dark` and reference via `var()` in `@theme inline`.

## Gotchas

- **No `tailwind.config.js`**: Tailwind v4 uses CSS-based configuration. Never create a config file.
- **No `postcss.config.js`**: The `@tailwindcss/vite` plugin replaces PostCSS. Do not add PostCSS config.
- **`@import "tailwindcss"` replaces v3 directives**: Do not use `@tailwind base; @tailwind components; @tailwind utilities;`.
- **`@theme inline` vs `@theme`**: Use `inline` when referencing `var()` — without it, CSS variable resolution can produce wrong values in nested DOM. Use plain `@theme` only for static values.
- **Dark mode is class-based**: The project uses `@custom-variant dark (&:is(.dark *))`, not `prefers-color-scheme`. The `dark:` variant activates when a `.dark` class exists on an ancestor. This is required by shadcn-svelte.
- **Dynamic class names don't work**: Tailwind scans source files at build time. `bg-${color}-500` will NOT be detected. Use complete class names or define them in `@theme`.
- **OKLCH is the color format**: shadcn-svelte uses `oklch()` for all theme colors. When adding custom colors, use OKLCH: `oklch(L C H)` or `oklch(L C H / alpha)`. Do not use hex or HSL for theme variables.
- **`@plugin` replaces JS plugin config**: Plugins are loaded via `@plugin '@tailwindcss/forms'` in CSS, not in a JS config file.
- **Svelte `class:` directives work with Tailwind**: `class:bg-primary={active}` is valid.
- **`@theme` must be top-level**: Cannot nest `@theme` inside selectors or media queries.
- **Reset a namespace with `initial`**: `--color-*: initial;` in `@theme` removes all default colors in that namespace. Use sparingly.
- **`prettier-plugin-tailwindcss` auto-sorts classes**: Don't manually reorder Tailwind classes — Prettier handles it.

## When to Load References

- **Adding complex `@theme` tokens or overriding defaults** → Load `references/theme-api.md` for namespace reference, `inline`/`static` options, and OKLCH format details.