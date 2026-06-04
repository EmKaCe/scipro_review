---
name: prettier
description: "Use when: configuring Prettier, formatting Svelte/TS/CSS files, setting up prettier-plugin-svelte or prettier-plugin-tailwindcss, resolving Prettier vs ESLint formatting conflicts, fixing format-on-save issues, or troubleshooting Tailwind class sorting in a SvelteKit + Svelte 5 project."
argument-hint: "<formatting-task>"
---

# Prettier

Format code in a SvelteKit + Svelte 5 project using Prettier v3 with Svelte and Tailwind CSS plugins.

## Procedure

### Run formatting

```bash
cd frontend && pnpm format    # Format all files (prettier --write .)
cd frontend && pnpm lint       # Check formatting + lint (prettier --check . && eslint .)
```

`pnpm lint` runs Prettier check **first**. A formatting failure blocks ESLint from running. Fix formatting with `pnpm format` before debugging lint errors.

### Modify Prettier config

1. Open `frontend/.prettierrc`.
2. Edit the option. Do not create additional Prettier config files — `.prettierrc` is the single source of truth.
3. Run `pnpm format` to apply and verify.
4. Read `references/config.md` for the full config reference, option explanations, and plugin details.

### Add a new Prettier plugin

1. Install: `cd frontend && pnpm add -D prettier-plugin-foo`.
2. Add the plugin string to the `plugins` array in `.prettierrc`.
3. **If the plugin is not `prettier-plugin-tailwindcss`**, insert it **before** `prettier-plugin-tailwindcss` in the array. The Tailwind plugin must remain last.
4. Run `pnpm format` to verify.

### Fix formatting issues in Svelte files

1. Confirm `prettier-plugin-svelte` is in `devDependencies` and listed in `.prettierrc` `plugins`.
2. Confirm the `overrides` section targets `*.svelte` with `parser: "svelte"`.
3. If format-on-save corrupts Svelte files, the VS Code extension may not be finding the plugin. Run `pnpm format` from the terminal to check — if it works there, the issue is the editor's Prettier extension not resolving the project's plugins. Restart VS Code or reinstall the extension.
4. If runes (`$state`, `$derived`, `$effect`) cause parse errors, upgrade `prettier-plugin-svelte` to v3+.

### Resolve Prettier vs ESLint conflicts

1. Prettier owns formatting. ESLint owns code quality. Never enable ESLint formatting rules when Prettier is active.
2. The project uses `eslint-config-prettier` (configured in `eslint.config.js`) to disable conflicting ESLint rules. This is the only integration needed — do not add `eslint-plugin-prettier`.
3. If a lint error looks like a formatting concern (indentation, quotes, semicolons), it's a Prettier responsibility. Fix with `pnpm format`, not `eslint --fix`.
4. See the ESLint skill for details on the `eslint-config-prettier` setup.

## Gotchas

- **Plugin order is non-negotiable**: `prettier-plugin-tailwindcss` MUST be last in the `plugins` array. If it's not last, Tailwind class sorting silently fails — no error, just unsorted classes.
- **Svelte 5 runes require v3+**: `prettier-plugin-svelte` v3+ is required for `$state`, `$derived`, `$effect`. Older versions throw parse errors on runes.
- **`tailwindStylesheet` is required for Tailwind v4**: The project uses Tailwind v4 (CSS-first config, no `tailwind.config.js`). Without `tailwindStylesheet: "./src/routes/layout.css"`, the Tailwind plugin cannot resolve classes and sorting silently fails.
- **`trailingComma` default changed in Prettier v3**: The default is now `"all"`. This project explicitly sets `"none"`. When adding options, do not assume defaults match your expectations.
- **Lockfiles must be ignored**: `pnpm-lock.yaml` is in `.prettierignore`. Never remove it — formatting a lockfile corrupts it.
- **Do not use `eslint-plugin-prettier`**: Running Prettier as an ESLint rule is redundant (already checked via `pnpm lint`), slower, and produces noisy editor warnings. The project uses `eslint-config-prettier` only.
- **`pnpm lint` runs Prettier first**: A Prettier check failure prevents ESLint from running. Always fix formatting before investigating lint errors.

## References

- Read `references/config.md` when modifying `.prettierrc`, adding plugins, understanding option values, or debugging plugin resolution issues.

- [Prettier docs](https://prettier.io/docs/)
- [prettier-plugin-svelte](https://github.com/sveltejs/prettier-plugin-svelte)
- [prettier-plugin-tailwindcss](https://github.com/tailwindlabs/prettier-plugin-tailwindcss)