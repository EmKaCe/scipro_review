# Design Tokens — SciPro Review

The app's one design language. Every color, radius, and code-surface value lives
here (as CSS variables in `frontend/src/routes/layout.css`) and is referenced via
`var(--token)` in components. Hardcoded colors are the exception, listed below.

> Golden rule: **one central token file** — `layout.css` defines light (`:root`)
> and dark (`.dark`) values; components never define their own color literals.
> The `@theme inline` block maps the tokens to Tailwind classes
> (`bg-primary`, `text-muted-foreground`, `border-border`, `rounded-lg`, …).

## Semantic tokens

| Group | Tokens | Purpose |
|---|---|---|
| Surfaces | `--background`, `--foreground`, `--card`, `--card-foreground`, `--popover`, `--popover-foreground`, `--muted`, `--muted-foreground`, `--sidebar*` | App shell, cards, popovers, muted panels (sidebar, drop zones) |
| Brand | `--primary`, `--primary-foreground`, `--primary-soft` | Green brand color (buttons, links, active states); soft variant for hover/fill backgrounds |
| States | `--success`, `--success-soft`, `--warning`, `--error`, `--destructive`, `--destructive-soft`, `--info` | Semantic status colors (sentiment borders, danger actions, chips) |
| Lines | `--border`, `--input`, `--ring` | Borders, inputs, focus ring |
| Code cells | `--code-bg`, `--code-fg`, `--code-gutter-bg`, `--code-gutter-fg`, `--code-border` | Always-dark code blocks (execution output, skeleton code blocks) — same values in both themes |
| Chips | `--chip-submission-bg/-fg`, `--chip-data-bg/-fg` | Upload panel classification chips (theme-aware) |
| Grades | `--grade-0` … `--grade-100` (11 steps) | German-grade color ramp |
| Charts | `--chart-1` … `--chart-5` | Chart/data-viz series |
| Radius | `--radius` (0.625rem base); Tailwind `--radius-sm/md/lg/xl/2xl/3xl/4xl` derived | Corner rounding scale |
| Typography | `--font-sans`, `--font-heading` (Geist Variable), `--font-mono` | Font families |
| Legacy aliases | `--fg`, `--bg`, `--muted-bg`, `--destructive-foreground`, `--accent-on/hover/soft` | Pre-shadcn names still referenced by components |

## How to use

- **CSS:** `color: var(--foreground); background: var(--card); border: 1px solid var(--border);`
- **Tailwind:** `bg-primary text-muted-foreground border-border rounded-lg` (the
  `@theme inline` block maps `--color-*` to the semantic vars).
- **Soft/alpha variants:** built with `color-mix(in oklch, var(--x) 15%, transparent)`
  (e.g. `--primary-soft`, `--accent-soft`) — never hand-tune a second hex.

## Documented exceptions (intentional, not drift)

| Location | Value | Why |
|---|---|---|
| `custom-switch.svelte` knob | `background: white` | Track/knob needs absolute white for contrast on any surface |
| Neutral shadows | `oklch(0 0 0 / 0.1)`-style alphas in grade-slider, modals, tabs | Shadows are universal neutral black at alpha |
| Print styles (`layout.css` `@media print`) | forced-light oklch values | Printing always renders light regardless of theme |
| `favicon.svg` | its own colors | Image asset, not CSS |

## Audit gate

```bash
cd frontend/src
grep -rnE '#[0-9a-fA-F]{3,8}\b|oklch\(|rgb\(|hsl\(' lib routes
```

Allowed hits: `layout.css` (token definitions + print styles), the documented
exceptions above, and image assets. Everything else is drift and must be
tokenized.

> **P8 (2026-08-19):** the two copilot-harness components (`plan-card.svelte`,
> `change-ledger.svelte`) previously used an invented `--color-*` namespace with
> hex fallbacks (a sibling design system with a blue primary). They now use the
> app tokens; the harness's blue `#2563eb` became the app's green `--primary`.
