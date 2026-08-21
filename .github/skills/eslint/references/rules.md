# ESLint Rules Reference

Load this file when adding or modifying rules, or when a lint error references a rule you need to understand.

## Svelte-specific rules (`eslint-plugin-svelte` v3+)

Rules most relevant to a Svelte 5 project. All are included in `svelte.configs.recommended` unless noted.

| Rule | Default | Purpose |
|------|---------|---------|
| `svelte/valid-compile` | error | Ensures Svelte compiler passes — catches syntax and compilation errors |
| `svelte/no-unused-svelte-ignore` | warn | Flags `<!-- svelte-ignore -->` comments that don't suppress anything |
| `svelte/no-reactive-reassign` | error | Prevents reassigning `$state`/`$derived` rune values |
| `svelte/no-dupe-on-directive` | error | Catches duplicate `on:` directives |
| `svelte/no-dupe-use-directive` | error | Catches duplicate `use:` directives |
| `svelte/no-dupe-else-if-blocks` | error | Catches duplicate `{#else if}` conditions |
| `svelte/require-store-reactive-access` | error | Ensures stores are accessed with `$` prefix |
| `svelte/no-reactive-functions` | off | Warns about functions declared with `$state`/`$derived` (often a mistake) |
| `svelte/no-dom-rewriting` | off | Prevents DOM rewriting that breaks Svelte's reactivity |
| `svelte/button-has-type` | off | Ensures `<button>` elements have a `type` attribute |
| `svelte/no-target-blank` | error | Prevents `target="_blank"` without `rel="noopener"` |

Full list: https://sveltejs.github.io/eslint-plugin-svelte/rules/

## TypeScript rules (`typescript-eslint` v8+)

Rules included in `ts.configs.recommended`. Adjust severity in the last `rules: {}` config object.

| Rule | Default | When to change |
|------|---------|----------------|
| `@typescript-eslint/no-unused-vars` | error | Set to `warn` if too noisy during development; use `argsIgnorePattern: "^_"` to allow unused `_`-prefixed params |
| `@typescript-eslint/no-explicit-any` | off | Set to `warn` to discourage `any` without breaking builds |
| `@typescript-eslint/no-non-null-assertion` | error | Set to `off` if you frequently use `!` assertions with trusted data |
| `@typescript-eslint/consistent-type-imports` | off | Enable for cleaner imports: `import type { Foo }` instead of `import { Foo }` |
| `@typescript-eslint/no-empty-function` | error | Set to `off` if empty lifecycle hooks are common in your project |
| `@typescript-eslint/explicit-function-return-type` | off | Keep off — too verbose for Svelte components |
| `@typescript-eslint/no-unnecessary-type-assertion` | error | Leave on — catches redundant type assertions |

Full list: https://typescript-eslint.io/rules/

## Core JS rules (`@eslint/js`)

Rules from `js.configs.recommended` that commonly need adjustment in SvelteKit projects.

| Rule | Default | When to change |
|------|---------|----------------|
| `no-undef` | error | **Must be `off`** for TypeScript projects — TS already catches this |
| `no-unused-vars` | error | Disable in favor of `@typescript-eslint/no-unused-vars` which handles TS syntax |
| `no-console` | off | Set to `warn` to catch accidental console logs |
| `no-constant-condition` | error | May need `off` in test files with `while(true)` patterns |

## Prettier-disabled rules

`eslint-config-prettier` and `svelte.configs.prettier` disable these formatting rules. **Do not re-enable them** or Prettier and ESLint will conflict:

- `semi`, `quotes`, `indent`, `tab-width`, `comma-dangle`
- `object-curly-spacing`, `array-bracket-spacing`, `computed-property-spacing`
- `arrow-parens`, `arrow-spacing`, `block-spacing`
- `function-paren-newline`, `function-call-argument-newline`
- `svelte/html-quotes`, `svelte/indent`, `svelte/no-spaces-around-equality-operators`

## Adding a rule — quick reference

To add a rule to the project, edit `frontend/eslint.config.js`:

**Project-wide rule** (applies to all files):
```js
{
  rules: {
    '@typescript-eslint/no-explicit-any': 'warn',
  }
}
```

**Svelte-only rule** (applies to `.svelte`, `.svelte.ts`, `.svelte.js`):
```js
{
  files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
  languageOptions: { /* ... existing parserOptions ... */ },
  rules: {
    'svelte/button-has-type': 'error',
  }
}
```

**Rule with options** (array syntax: `[severity, options]`):
```js
{
  rules: {
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
  }
}
```