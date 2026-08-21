---
name: shadcn-svelte
description: "Install and use shadcn-svelte UI components, configure components.json, build forms with Formsnap, customize theming, or troubleshoot component rendering in a SvelteKit + Svelte 5 + Tailwind v4 project."
argument-hint: "<component-name or task>"
---

# shadcn-svelte

Add and use shadcn-svelte components in this SvelteKit + Svelte 5 project. Components are accessible, composable wrappers around Bits UI primitives with Tailwind CSS styling. You own the source code — it's copied into your project, not imported from a package.

## Project Configuration

- **Frontend root**: `frontend/` (run all CLI commands from here)
- **Package manager**: `pnpm`
- **Style**: `vega` | **Base color**: `mist` | **Icons**: `@lucide/svelte`
- **Component path**: `src/lib/components/ui/`
- **CSS file**: `src/routes/layout.css`
- **Tailwind**: v4 with `@tailwindcss/vite` (no PostCSS, no `tailwind.config`)
- **Color format**: OKLCH (not HSL)
- **Animation**: `tw-animate-css` (not `tailwindcss-animate`)

## Procedure: Adding a Component

1. Run from `frontend/`:

```bash
pnpm dlx shadcn-svelte@latest add <component-name>
```

Multiple at once: `pnpm dlx shadcn-svelte@latest add button dialog table`

2. Overwrite an existing component: add `--overwrite`

3. Add all components: `pnpm dlx shadcn-svelte@latest add --all`

4. Import and use in `.svelte` files:

```svelte
<script>
  import { Button } from "$lib/components/ui/button";
</script>

<Button variant="default">Click me</Button>
```

## Procedure: Building Forms

Forms use Formsnap + Superforms + Zod. Read `references/components.md` for the full pattern.

1. Install: `pnpm dlx shadcn-svelte@latest add form`
2. Define a Zod schema in a `schema.ts` file
3. Create a server load function using `superValidate(zod4(formSchema))`
4. In the component, call `superForm(data.form, { validators: zod4Client(formSchema) })`
5. Use `Form.Field`, `Form.Control`, `Form.Label`, `Form.Description`, `Form.FieldErrors`
6. Spread `props` from the `{#snippet children({ props })}` slot onto the input

## Procedure: Customizing Theme

Read `references/theming.md` before modifying CSS variables or adding custom colors.

- Variables are in `src/routes/layout.css` under `:root` and `.dark`
- Colors use OKLCH format: `oklch(0.205 0 0)`
- To add a custom color, define the variable in `:root`/`.dark` **and** register it in `@theme inline`
- Dark mode uses `mode-watcher` with `<ModeWatcher />` in the root layout

## Gotchas

- **Never import from `shadcn-svelte` directly** — components live at `$lib/components/ui/<component>`. They are local source code, not a library.
- **OKLCH, not HSL** — this project uses Tailwind v4 with OKLCH color values. Do not use `hsl()` wrappers or HSL triplets in CSS variables.
- **`@theme inline` is required** — custom CSS color variables must be registered in the `@theme inline` block as `--color-<name>: var(--<name>)` or Tailwind won't generate utility classes for them.
- **`@custom-variant dark`** — dark mode is defined as `@custom-variant dark (&:is(.dark *));` in the CSS file. Do not add `darkMode: ["class"]` to any config.
- **No `tailwind.config`** — Tailwind v4 uses CSS-based config. There is no `tailwind.config.js`/`tailwind.config.ts`.
- **`tw-animate-css`, not `tailwindcss-animate`** — the animation library changed for Tailwind v4.
- **`zod4` adapter, not `zodClient`** — Superforms v2 uses `zod4`/`zod4Client` adapters. The old `zodClient` adapter is deprecated.
- **Snippet syntax for Form.Control** — `Form.Control` uses `{#snippet children({ props })}` not `let:builder`. Spread `props` onto the input element.
- **`$state`/`$derived` in components** — shadcn-svelte components use Svelte 5 runes internally. Don't wrap their reactive props in extra `$derived` unless needed for your own logic.
- **Bits UI pass-through** — each component wraps a Bits UI primitive. If a component doesn't expose a prop you need, check [Bits UI docs](https://bits-ui.com/) — you can often pass extra props through.
- **`data-slot` attributes** — Tailwind v4 components render `data-slot` on every primitive element. Use this for targeted styling instead of reaching into component internals.
- **Deprecated packages** — `cmdk-sv` → Bits UI Command, `svelte-headless-table` → `@tanstack/table-core`, `lucide-svelte` → `@lucide/svelte`, `svelte-radix` → `@lucide/svelte`.
- **CLI must run from `frontend/`** — the `components.json` is in `frontend/`, so all `shadcn-svelte` CLI commands must be run from that directory.

## When to Load References

- Read `references/components.md` when you need component API details (variants, sub-components, import paths) or a working form example.
- Read `references/theming.md` when modifying CSS variables, adding custom colors, or configuring dark mode.

## External Docs

- [shadcn-svelte docs](https://shadcn-svelte.com/docs)
- [Bits UI primitives](https://bits-ui.com/)
- [Formsnap](https://formsnap.dev/)
- [Superforms](https://superforms.rocks/)