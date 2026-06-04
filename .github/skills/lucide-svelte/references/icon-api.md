# Icon API Reference

Detailed reference for `@lucide/svelte` props, TypeScript types, and advanced patterns. Load this file when you need prop details, type definitions, or patterns for combining/dynamically rendering icons.

## Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `size` | `number \| string` | 24 | Sets both `width` and `height` on the SVG |
| `color` | `string` | `currentColor` | Sets the `stroke` attribute |
| `strokeWidth` | `number \| string` | 2 | Sets `stroke-width` on all child elements |
| `absoluteStrokeWidth` | `boolean` | false | Adds `vector-effect="non-scaling-stroke"` to keep stroke width constant when icon is scaled |
| `class` | `string` | — | Appended to the generated `class` attribute |
| `children` | `Snippet` | — | SVG child elements (for combining icons) |

All standard SVG presentation attributes are also accepted as props. See [SVG Presentation Attributes on MDN](https://developer.mozilla.org/en-US/docs/Web/SVG/Attribute/Presentation).

## TypeScript Types

### `LucideProps`

```ts
interface LucideProps extends SVGAttributes<SVGSVGElement> {
  name?: string;
  color?: string;
  size?: number | string;
  strokeWidth?: number | string;
  absoluteStrokeWidth?: boolean;
  children?: Snippet;
  [key: string]: any;
}
```

### `LucideIcon`

Type for individual icon components. Use this when typing a variable or prop that holds an icon component:

```ts
import type { Component } from 'svelte';
type LucideIcon = Component<LucideProps>;
```

Example — typed menu items:

```svelte
<script lang="ts">
  import { Home, Library, Cog, type LucideIcon } from '@lucide/svelte';

  type MenuItem = {
    name: string;
    href: string;
    icon: LucideIcon;
  };

  const menuItems: MenuItem[] = [
    { name: 'Home', href: '/', icon: Home },
    { name: 'Blog', href: '/blog', icon: Library },
    { name: 'Projects', href: '/projects', icon: Cog },
  ];
</script>

{#each menuItems as item}
  {@const Icon = item.icon}
  <a href={item.href}>
    <Icon />
    <span>{item.name}</span>
  </a>
{/each}
```

### `IconNode`

Type for the raw SVG structure of an icon. Used with the `Icon` component for custom/Lab icons:

```ts
type IconNode = [elementName: string, attrs: Record<string, string | number>][];
```

Example — custom icon node:

```svelte
<script lang="ts">
  import { type IconNode, Icon } from '@lucide/svelte';

  const customIcon: IconNode = [
    ['circle', { cx: 12, cy: 12, r: 10 }],
    ['line', { x1: 12, y1: 8, x2: 12, y2: 12 }],
  ];
</script>

<Icon iconNode={customIcon} size={24} color="blue" />
```

## Combining Icons

Nest SVG elements inside icons to add badges, labels, or overlay another icon:

### Notification badge

```svelte
<script>
  import Mail from '@lucide/svelte/icons/mail';
  let hasUnread = $state(true);
</script>

<Mail size={48}>
  {#if hasUnread}
    <circle r="3" cx="21" cy="5" stroke="none" fill="red" />
  {/if}
</Mail>
```

### Nested icon

SVGs can be nested. Use `x` and `y` to position the inner icon within the 24×24 viewBox:

```svelte
<script>
  import Scan from '@lucide/svelte/icons/scan';
  import User from '@lucide/svelte/icons/user';
</script>

<Scan size={48}>
  <User size={12} x={6} y={6} absoluteStrokeWidth />
</Scan>
```

### Text label inside icon

```svelte
<script>
  import File from '@lucide/svelte/icons/file';
</script>

<File size={48}>
  <text x="7.5" y="19" font-size="8" font-family="Verdana,sans-serif" stroke-width="1">
    JS
  </text>
</File>
```

## Dynamic Icon Rendering

When the icon name is only known at runtime (e.g., from a CMS or database), use a dynamic component:

```svelte
<script>
  import * as icons from '@lucide/svelte';
  let { name, ...props } = $props();
  const Icon = icons[name];
</script>

<Icon {...props} />
```

**Warning**: `import * as icons` imports all 1600+ icons and will significantly increase bundle size. Only use this pattern when the icon set is truly dynamic and cannot be determined at build time.

## Global CSS Styling

All Lucide icons have the `lucide` class. Target it for global CSS styling:

```css
.lucide {
  color: #ffadff;
  width: 56px;
  height: 56px;
  stroke-width: 1px;
}
```

For absolute stroke width via CSS (keeps stroke constant regardless of size):

```css
.lucide {
  width: 48px;
  height: 48px;
  stroke-width: 1.5;
}
.lucide * {
  vector-effect: non-scaling-stroke;
}
```

**Note**: CSS rules override `size`, `color`, and `strokeWidth` props due to CSS specificity. If you need per-icon prop control alongside global defaults, use `setLucideProps` instead of CSS.

## VS Code Autocomplete

To reduce noise from 1600+ icon exports in autocomplete suggestions, add to `.vscode/settings.json`:

```json
{
  "js/ts.preferences.autoImportFileExcludePatterns": [
    "@lucide/svelte"
  ]
}
```

This forces manual imports (which you should be doing anyway for direct path imports).