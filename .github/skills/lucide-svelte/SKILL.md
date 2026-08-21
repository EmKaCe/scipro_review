---
name: lucide-svelte
description: "Use when: adding or importing Lucide icons in Svelte 5, sizing or styling icons with Tailwind, using Icon component with custom nodes or Lucide Lab, setting global icon defaults with setLucideProps, fixing icon rendering or import issues in a SvelteKit project."
argument-hint: "<icon-name or task>"
---

# @lucide/svelte

Add and customize Lucide icons in a SvelteKit + Svelte 5 project. The package is `@lucide/svelte` (v1+, Svelte 5 only). For Svelte 4, use the legacy `lucide-svelte` package instead.

## Procedure

### 1. Add an icon to a component

Always use direct path imports — they're significantly faster in Vite dev server:

```svelte
<script>
  import Camera from '@lucide/svelte/icons/camera';
</script>

<Camera />
```

Barrel imports (`import { Camera } from '@lucide/svelte'`) work but slow down Vite HMR. Only use them when you need to import many icons in one line and dev speed isn't critical.

### 2. Style an icon

Default sizing with Tailwind (preferred in this project):

```svelte
<Camera class="size-5" />     <!-- 20px -->
<Camera class="size-6" />     <!-- 24px (default) -->
<Camera class="size-8" />     <!-- 32px -->
```

Override color via CSS — icons use `currentColor` by default, inheriting the parent's text color:

```svelte
<span class="text-red-500"><Camera /></span>
<!-- or directly -->
<Camera class="text-red-500" />
```

Use props for one-off overrides:

```svelte
<Camera size={48} color="red" strokeWidth={1} />
```

### 3. Set global defaults

Call `setLucideProps` once in your app's top-level layout or entry file:

```ts
// src/routes/+layout.svelte or similar
import { setLucideProps } from '@lucide/svelte';

setLucideProps({
  size: 20,
  strokeWidth: 1.5,
});
```

Individual icon props override global defaults. CSS rules override both — if you need per-icon prop control, use `setLucideProps` instead of CSS.

### 4. Use Lucide Lab or custom icon nodes

```svelte
<script>
  import { Icon } from '@lucide/svelte';
  import { pear } from '@lucide/lab';
</script>

<Icon iconNode={pear} color="green" />
```

### 5. Make icons accessible

Icons are `aria-hidden="true"` by default (decorative). Only override this when an icon conveys meaning on its own:

```svelte
<!-- Decorative (default, no action needed) -->
<Camera />

<!-- Standalone meaningful icon -->
<Camera aria-label="Take photo" />

<!-- Icon in a button — label the button, NOT the icon -->
<button aria-label="Go to home">
  <House />
</button>
```

Read `references/icon-api.md` for the full prop table, TypeScript types, combining icons, and advanced patterns.

## Gotchas

- **Svelte 5 only**: `@lucide/svelte` v1+ requires Svelte 5. For Svelte 4, use the legacy `lucide-svelte` package.
- **Direct imports for Vite performance**: Use `import Icon from '@lucide/svelte/icons/icon-name'` instead of `import { Icon } from '@lucide/svelte'`. Barrel imports force Vite to process the entire icon index on every HMR update.
- **currentColor inheritance**: Icons use `currentColor` by default. Style via CSS `color` on the parent or the icon itself — the `color` prop sets the SVG `stroke` attribute directly.
- **No brand icons**: Lucide v1 removed all brand icons (GitHub, Figma, Slack, etc.). Use [Simple Icons](https://simpleicons.org/) for brand logos.
- **Naming convention**: Component names are PascalCase (`ArrowRight`), file paths are kebab-case (`arrow-right`). Browse at [lucide.dev/icons](https://lucide.dev/icons).
- **Filled icons not supported**: Lucide icons are stroke-based. You can set `fill` and `strokeWidth={0}` on some icons for a filled look, but results vary by icon.
- **CSS overrides props**: If you apply CSS to `.lucide` (width, height, stroke-width), it will override the `size` and `strokeWidth` props due to CSS specificity. Use `setLucideProps` if you need both global defaults and per-icon prop control.
- **absoluteStrokeWidth**: When scaling icons up, stroke width scales proportionally by default. Set `absoluteStrokeWidth` to keep stroke width constant regardless of icon size: `<Icon size={48} absoluteStrokeWidth />`.