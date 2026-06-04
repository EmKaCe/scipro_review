# Tailwind v4 Theme API Reference

Detailed reference for `@theme`, `@theme inline`, `@theme static`, OKLCH colors, and namespace mappings. Load this file when adding complex design tokens or overriding default theme values.

## @theme Directive Options

### `@theme` (default)

Defines theme variables that generate both utility classes and CSS custom properties. Values are resolved at build time and emitted as `:root` variables.

```css
@theme {
  --color-mint-500: oklch(0.72 0.11 178);
  --font-display: "Satoshi", sans-serif;
}
```

Generated CSS:
```css
:root { --color-mint-500: oklch(0.72 0.11 178); }
.bg-mint-500 { background-color: var(--color-mint-500); }
```

### `@theme inline`

Use when a theme variable **references another CSS variable** via `var()`. The utility class will inline the `var()` reference instead of the resolved value. This prevents incorrect resolution in nested DOM trees.

```css
@theme inline {
  --color-primary: var(--primary);
  --font-sans: var(--font-inter);
}
```

Generated CSS:
```css
.bg-primary { background-color: var(--primary); }
.font-sans { font-family: var(--font-inter); }
```

**When to use `inline`**: Always when bridging shadcn-svelte CSS variables (`:root`/`.dark`) into Tailwind utilities. Without `inline`, a parent element overriding `--font-sans` would break child font resolution.

### `@theme static`

Forces all CSS variables to be emitted even if unused. Useful for design systems where variables must always exist in the output.

```css
@theme static {
  --color-primary: var(--color-red-500);
  --color-secondary: var(--color-blue-500);
}
```

## Theme Variable Namespaces

Each namespace maps to specific utility classes. Defining a variable in a namespace automatically creates the corresponding utilities.

| Namespace | Utilities Generated | Example Variable | Example Utility |
|-----------|-------------------|-----------------|----------------|
| `--color-*` | `bg-*`, `text-*`, `border-*`, `ring-*`, `fill-*`, `stroke-*`, etc. | `--color-brand-500` | `bg-brand-500` |
| `--font-*` | `font-*` | `--font-display` | `font-display` |
| `--text-*` | `text-*` (font-size) | `--text-xs` | `text-xs` |
| `--font-weight-*` | `font-*` (weight) | `--font-weight-semibold` | `font-semibold` |
| `--tracking-*` | `tracking-*` | `--tracking-wide` | `tracking-wide` |
| `--leading-*` | `leading-*` | `--leading-tight` | `leading-tight` |
| `--spacing-*` | `p-*`, `m-*`, `gap-*`, `w-*`, `h-*`, etc. | `--spacing-4` | `p-4` |
| `--radius-*` | `rounded-*` | `--radius-lg` | `rounded-lg` |
| `--shadow-*` | `shadow-*` | `--shadow-md` | `shadow-md` |
| `--inset-shadow-*` | `inset-shadow-*` | `--inset-shadow-xs` | `inset-shadow-xs` |
| `--drop-shadow-*` | `drop-shadow-*` | `--drop-shadow-md` | `drop-shadow-md` |
| `--blur-*` | `blur-*` | `--blur-md` | `blur-md` |
| `--breakpoint-*` | Variant `*:` | `--breakpoint-3xl` | `3xl:*` |
| `--container-*` | Variant `@*:` + `max-w-*` | `--container-md` | `max-w-md` |
| `--ease-*` | `ease-*` | `--ease-out` | `ease-out` |
| `--animate-*` | `animate-*` | `--animate-spin` | `animate-spin` |
| `--aspect-*` | `aspect-*` | `--aspect-video` | `aspect-video` |
| `--tab-size-*` | `tab-*` | `--tab-github` | `tab-github` |
| `--perspective-*` | `perspective-*` | `--perspective-near` | `perspective-near` |
| `--zoom-*` | `zoom-*` | `--zoom-compact` | `zoom-compact` |

## Overriding Default Theme Values

### Override a single value

```css
@theme {
  --breakpoint-sm: 30rem; /* was 40rem */
}
```

### Remove an entire namespace

Use `initial` to clear all defaults in a namespace, then define only what you need:

```css
@theme {
  --color-*: initial;
  --color-white: #fff;
  --color-brand: oklch(0.5 0.15 250);
}
```

After this, `bg-red-500` etc. will NOT exist — only `bg-white` and `bg-brand` will work.

### Remove all defaults

```css
@theme {
  --*: initial;
  --spacing: 4px;
  --font-body: Inter, sans-serif;
  --color-brand: oklch(0.5 0.15 250);
}
```

## OKLCH Color Format

OKLCH is a perceptually uniform color space. The project uses it for all shadcn-svelte theme variables.

### Syntax

```
oklch(L C H)
oklch(L C H / alpha)
```

- **L** (Lightness): 0–1 (0 = black, 1 = white)
- **C** (Chroma): 0–0.4+ (0 = gray, higher = more saturated)
- **H** (Hue): 0–360 degrees
- **alpha**: 0–1 or percentage (optional)

### Examples from the project

```css
--background: oklch(1 0 0);                    /* white */
--foreground: oklch(0.148 0.004 228.8);        /* near-black with slight blue */
--primary: oklch(0.508 0.118 165.612);         /* medium green */
--destructive: oklch(0.577 0.245 27.325);      /* red */
--border: oklch(0.925 0.005 214.3);            /* light gray border */
--border: oklch(1 0 0 / 10%);                  /* white at 10% opacity (dark mode) */
```

### Converting from hex/HSL

Use the browser DevTools color picker or an online converter (e.g., oklch.com). When adding a new theme color:

1. Pick your hex/HSL color.
2. Convert to OKLCH.
3. Define in `:root` (light) and `.dark` (dark) blocks.
4. Bridge with `@theme inline`.

### Why OKLCH over HSL

- Perceptually uniform: equal numeric steps feel like equal visual steps.
- No hue shift when changing lightness (common HSL problem).
- Wider gamut support (P3 displays).
- Consistent with shadcn-svelte defaults.

## Defining Animation Keyframes

Include `@keyframes` inside `@theme` for `--animate-*` variables:

```css
@theme {
  --animate-fade-in: fade-in 0.3s ease-out;
  @keyframes fade-in {
    0% { opacity: 0; transform: scale(0.95); }
    100% { opacity: 1; transform: scale(1); }
  }
}
```

Keyframes defined inside `@theme` are only emitted if the animation is used. Define `@keyframes` outside `@theme` if they should always be in the output.

## @custom-variant Syntax

### Shorthand (single selector)

```css
@custom-variant dark (&:is(.dark *));
```

### Block (multiple rules)

```css
@custom-variant any-hover {
  @media (any-hover: hover) {
    &:hover { @slot; }
  }
}
```

### Data attribute variant

```css
@custom-variant dark (&:where([data-theme=dark], [data-theme=dark] *));
```

## @utility Directive

### Simple utility

```css
@utility content-auto {
  content-visibility: auto;
}
```

### Functional utility (accepts argument)

```css
@utility tab-* {
  tab-size: --value(--tab-size-*);
}
```

`--value()` resolves the utility argument against theme keys, bare values, or arbitrary values:

| Syntax | Matches | Example |
|--------|---------|---------|
| `--value(--tab-size-*)` | Theme keys | `tab-github` |
| `--value(integer)` | Bare integers | `tab-4` |
| `--value([integer])` | Arbitrary values | `tab-[8]` |
| `--value("inherit")` | Literal strings | `tab-inherit` |

Combine all forms in one declaration:
```css
@utility tab-* {
  tab-size: --value(--tab-size-*, integer, [integer]);
}
```

## @plugin Directive

Load first-party Tailwind plugins directly in CSS (no JS config needed):

```css
@plugin '@tailwindcss/forms';
@plugin '@tailwindcss/typography';
```

## @layer Directive

Tailwind v4 uses three layers: `theme`, `base`, `components`, `utilities`. Add custom styles to the appropriate layer:

```css
@layer base {
  h1 { font-size: var(--text-2xl); }
}

@layer components {
  .card { background: var(--color-white); border-radius: var(--radius-lg); }
}
```

Utilities always override component styles, which override base styles.

## @variant Directive

Apply variants within custom CSS:

```css
.my-element {
  background: white;
  @variant dark {
    background: black;
  }
  @variant hover:focus {
    background: gray;
  }
}
```