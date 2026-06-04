---
name: eslint
description: "Use when: configuring ESLint flat config, adding or modifying lint rules, fixing lint errors, setting up eslint-plugin-svelte for Svelte 5, adjusting typescript-eslint rules, resolving Prettier vs ESLint conflicts, or troubleshooting lint failures in a SvelteKit + Svelte 5 + TypeScript project."
argument-hint: "<lint-task>"
---

# ESLint

Lint a SvelteKit + Svelte 5 + TypeScript project using ESLint v10+ with flat config.

## Procedure

### Run linting

```bash
cd frontend && pnpm lint          # prettier --check . && eslint .
cd frontend && pnpm lint --fix    # auto-fix (eslint only; run pnpm format for prettier fixes)
```

The `lint` script runs **both** Prettier and ESLint. A Prettier check failure will block ESLint from running. Fix formatting first with `pnpm format` if needed.

### Add or modify a rule

1. Open `frontend/eslint.config.js`.
2. Add the rule to the **last config object** (the one with `rules: {}`). This object applies to all files.
3. For Svelte-only rules, add a `rules` key to the `files: ['**/*.svelte', ...]` config object instead.
4. Run `pnpm lint` to verify. Read `references/rules.md` for available rules and recommended settings.

### Fix a lint error

1. Run `pnpm lint` and read the error output — it includes the rule name, file, and line.
2. If the rule provides an auto-fix, run `pnpm lint --fix`.
3. If manual fix is needed, check the rule docs. Read `references/rules.md` for project-relevant rule details.
4. To suppress a false positive, use `// eslint-disable-next-line rule-name` (prefer per-line over file-wide).
5. **Never** add a rule suppression without understanding why the error occurs.

### Add a new ESLint plugin

1. Install the plugin: `pnpm add -D eslint-plugin-foo`.
2. Import it in `eslint.config.js`.
3. Add its configs to the `defineConfig()` call, **before** `prettier` and `svelte.configs.prettier` (Prettier overrides must come last).
4. If the plugin provides rules for Svelte files, add them to the `files: ['**/*.svelte', ...]` config object.
5. Run `pnpm lint` to verify no conflicts.

### Troubleshoot config issues

1. Run `pnpm eslint --inspect-config` to open the config inspector and see which config objects apply to a specific file.
2. Check that `eslint-config-prettier` and `svelte.configs.prettier` are the **last two** configs in the array — any config after them can re-enable conflicting formatting rules.
3. Verify the Svelte file config object includes `**/*.svelte.ts` and `**/*.svelte.js` in `files`, not just `**/*.svelte`.

## Project Configuration

The project uses `eslint.config.js` (flat config) in `frontend/` with these packages:

| Package | Version | Role |
|---------|---------|------|
| `eslint` | v10+ | Core linter, flat config only |
| `eslint-plugin-svelte` | v3+ | Svelte 5 rune support, Svelte-specific rules |
| `typescript-eslint` | v8+ | TypeScript parser and rules |
| `eslint-config-prettier` | v10+ | Disables ESLint formatting rules conflicting with Prettier |
| `@eslint/js` | v10+ | Recommended JS rules |
| `@eslint/compat` | v2+ | `includeIgnoreFile` helper for `.gitignore` |
| `globals` | v17+ | Browser and Node global declarations |

### Current config structure

```js
// frontend/eslint.config.js
import prettier from 'eslint-config-prettier';
import path from 'node:path';
import { includeIgnoreFile } from '@eslint/compat';
import js from '@eslint/js';
import svelte from 'eslint-plugin-svelte';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import ts from 'typescript-eslint';
import svelteConfig from './svelte.config.js';

const gitignorePath = path.resolve(import.meta.dirname, '.gitignore');

export default defineConfig(
  includeIgnoreFile(gitignorePath),       // global ignores from .gitignore
  js.configs.recommended,                 // JS recommended rules
  ts.configs.recommended,                 // TS recommended rules
  svelte.configs.recommended,             // Svelte recommended rules
  prettier,                               // disable conflicting formatting rules
  svelte.configs.prettier,                // Svelte-specific Prettier compat
  {
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: { 'no-undef': 'off' }          // off for TS (typescript-eslint recommendation)
  },
  {
    files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        extraFileExtensions: ['.svelte'],
        parser: ts.parser,
        svelteConfig
      }
    }
  },
  {
    rules: {}                              // add project-wide rule overrides here
  }
);
```

## Gotchas

- **Flat config only**: ESLint v10+ uses `eslint.config.js`. Never create `.eslintrc.*` files — they are ignored.
- **Prettier order matters**: `prettier` and `svelte.configs.prettier` must be the **last configs** in the array. Any config placed after them can re-enable formatting rules that conflict with Prettier.
- **`no-undef` must be off**: TypeScript already catches undefined variables. The `no-undef` rule produces false positives in TS projects. See [typescript-eslint FAQ](https://typescript-eslint.io/troubleshooting/faqs/eslint/#i-get-errors-from-the-no-undef-rule).
- **TypeScript parser is a singleton**: The TS parser only respects options from its first initialization. Changing `parserOptions` in a later config object for the same parser will be silently ignored. See [typescript-eslint#6778](https://github.com/typescript-eslint/typescript-eslint/issues/6778).
- **`eslint --cache` breaks with svelteConfig**: Passing the live `svelteConfig` object to `parserOptions` makes it non-serializable, which breaks ESLint's cache. Do not use `--cache` with this setup.
- **Svelte 5 runes require v3+**: `eslint-plugin-svelte` v3+ supports `$state`, `$derived`, `$effect`. Older versions flag these as undefined.
- **Include `.svelte.ts` and `.svelte.js`**: The Svelte files config must include `**/*.svelte.ts` and `**/*.svelte.js` — not just `**/*.svelte`. Svelte 5 module files use these extensions and need the Svelte parser.
- **`includeIgnoreFile` reads `.gitignore`**: The project uses `@eslint/compat`'s `includeIgnoreFile` to automatically respect `.gitignore`. Do not duplicate those patterns in a separate `ignores` config.
- **`lint` script runs Prettier first**: `pnpm lint` runs `prettier --check . && eslint .`. A Prettier formatting failure will prevent ESLint from running. Fix formatting with `pnpm format` first.
- **Global vs non-global ignores**: In flat config, an `ignores` key **without** other properties acts as a global ignore (applies to all config objects). An `ignores` key **with** other properties (like `rules`) only applies to that config object. Use `globalIgnores()` from `eslint/config` to be explicit.

## References

- Read `references/rules.md` when adding or modifying rules, or when a lint error references a rule you need to understand.
- [ESLint flat config docs](https://eslint.org/docs/latest/use/configure/configuration-files)
- [eslint-plugin-svelte rules](https://sveltejs.github.io/eslint-plugin-svelte/rules/)
- [typescript-eslint rules](https://typescript-eslint.io/rules/)
- [typescript-eslint](https://typescript-eslint.io/)