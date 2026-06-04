# Svelte Review Frontend — Project Instructions

This is a SvelteKit + Svelte 5 + Tailwind v4 + shadcn-svelte project. The frontend lives in `frontend/`.

## Svelte 5 Runes Rules

- `$state`, `$derived`, `$effect` only work in `.svelte` and `.svelte.ts` files — never in plain `.ts`
- Cannot export `$derived` values from `.svelte.ts` modules — export functions that return the derived value instead
- In components, wrap store function calls in local `$derived` for reactivity
- Exporting `$state` objects IS allowed from `.svelte.ts` modules

## Syntax

- Use `$props()` instead of `export let`
- Use `onclick`/`onchange` instead of `on:click`/`on:change`
- Use `{#snippet}` and `{@render}` instead of `<slot>` and `let:`
- Use `$effect()` for side effects, `$derived()` for computed values

## Project Conventions

- **Package manager**: `pnpm` — always run commands from `frontend/`
- **UI components**: shadcn-svelte at `$lib/components/ui/<name>` — never import from npm package
- **Icons**: `@lucide/svelte` with direct path imports (`@lucide/svelte/icons/<name>`) — avoid barrel imports
- **Colors**: OKLCH format only — no HSL
- **Tailwind**: v4 CSS-first config — no `tailwind.config.js`/`tailwind.config.ts`
- **Dark mode**: `.dark` class toggle via `mode-watcher` — no `darkMode` config
- **New CSS variables**: Must be registered in `@theme inline` in `layout.css`
- **Animation**: `tw-animate-css` — not `tailwindcss-animate`
- **Forms**: Formsnap + Superforms + Zod with `zod4`/`zod4Client` adapters
- **Adapter**: `@sveltejs/adapter-static` with `fallback: "404.html"` (SPA mode, GitHub Pages compatible)
- **SSR**: disabled (`export const ssr = false` in `+layout.ts`)

## Commands

```bash
cd frontend && pnpm dev        # Dev server
cd frontend && pnpm build      # Production build
cd frontend && pnpm preview    # Preview production build
cd frontend && pnpm lint       # Prettier check + ESLint
cd frontend && pnpm format     # Format all files
cd frontend && pnpm check      # Type-check
```

## Skills

Load the appropriate skill for specialized tasks:

- `tailwindcss` — styling, @theme, OKLCH colors, dark mode
- `shadcn-svelte` — adding components, forms, theming
- `lucide-svelte` — icons, sizing, accessibility
- `vite` — dev server, build, plugins, env vars
- `eslint` — lint rules, config, fixing errors
- `prettier` — formatting, plugin order, Svelte formatting
- `github-pages` — deployment, SPA fallback, base path
- `github-actions` — CI/CD workflows
- `dependabot` — dependency updates, grouping
- `open-design` — generating, auditing, fixing, and handing off HTML prototypes via the OD daemon

## Custom Agents

- `Feature Builder` — building new UI features, components, routes
- `Bug Fixer` — diagnosing and fixing errors, build failures, styling bugs
- `Code Reviewer` — read-only code review, best practices, accessibility audit
- `DevOps` — CI/CD workflows, GitHub Pages deployment, Dependabot, troubleshooting pipeline failures

## Path-Specific Instructions

The `.github/instructions/` directory contains detailed, file-type-specific instructions that are automatically loaded when working on matching files:

| File Pattern                       | Instructions File                     | Covers                                                                     |
| ---------------------------------- | ------------------------------------- | -------------------------------------------------------------------------- |
| `**/*.svelte`                      | `svelte-components.instructions.md`   | Svelte 5 runes, template syntax, snippets, events, bindings, accessibility |
| `**/*.svelte.ts`, `**/*.svelte.js` | `svelte-module-files.instructions.md` | Runes in modules, shared state, reactive classes, testing                  |
| `**/*.ts`                          | `typescript.instructions.md`          | TypeScript 6 best practices, SvelteKit types, project conventions          |
| `**/*.css`                         | `css-styles.instructions.md`          | Tailwind v4, OKLCH colors, `@theme`, dark mode, shadcn theming             |

These instructions are loaded automatically by Copilot when editing files matching the `applyTo` patterns. They provide deeper, more specific guidance than this repository-wide file.

## Hooks

- **Format on edit** (`.github/hooks/format-on-edit.sh`): Auto-runs Prettier on edited frontend files after every `edit` tool use. Applies to `.svelte`, `.ts`, `.js`, `.css`, `.html`, `.json`, `.md`, `.yaml`/`.yml` files inside `frontend/`.

## CI/CD

- **CI** (`.github/workflows/ci.yml`): Runs `pnpm lint` + `pnpm check` on push/PR to `main`. Uses pnpm 11, Node 22, `--frozen-lockfile`.
- **Deploy** (`.github/workflows/deploy.yml`): Builds and deploys to GitHub Pages on push to `main`. Uses `actions/deploy-pages@v5` with `adapter-static` SPA fallback.
- **Dependabot** (`.github/dependabot.yml`): Weekly updates for npm (frontend/), GitHub Actions, and git submodules. Groups Svelte, Tailwind, and ESLint dependencies.

## GitHub CLI

- **`gh`** is installed and available for GitHub operations (issues, PRs, workflows, API calls)
- Use `gh` commands in terminal instead of setting up a separate MCP server
- Auth is already configured via `gh auth login`
