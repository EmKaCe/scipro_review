# Prettier Configuration Reference

## Project config file

`frontend/.prettierrc` (JSON):

```json
{
  "useTabs": true,
  "singleQuote": true,
  "trailingComma": "none",
  "printWidth": 100,
  "plugins": ["prettier-plugin-svelte", "prettier-plugin-tailwindcss"],
  "overrides": [
    {
      "files": "*.svelte",
      "options": {
        "parser": "svelte"
      }
    }
  ],
  "tailwindStylesheet": "./src/routes/layout.css"
}
```

## Project ignore file

`frontend/.prettierignore`:

```
# Package Managers
package-lock.json
pnpm-lock.yaml
yarn.lock
bun.lock
bun.lockb

# Miscellaneous
/static/
```

## Installed packages

| Package | Version | Role |
|---------|---------|------|
| `prettier` | v3.8+ | Core formatter |
| `prettier-plugin-svelte` | v3.5+ | Svelte 5 parser and printer |
| `prettier-plugin-tailwindcss` | v0.7+ | Tailwind class sorting |
| `eslint-config-prettier` | v10+ | Disables conflicting ESLint rules |

## Plugin order requirement

`prettier-plugin-tailwindcss` **must be last** in the `plugins` array. It needs to parse the output of other plugins first to correctly sort Tailwind classes. This is a Prettier requirement, not optional.

Correct order:
```json
"plugins": ["prettier-plugin-svelte", "prettier-plugin-tailwindcss"]
```

Wrong order (Tailwind sorting will silently fail):
```json
"plugins": ["prettier-plugin-tailwindcss", "prettier-plugin-svelte"]
```

## Svelte overrides

The `overrides` section tells Prettier to use the Svelte parser for `.svelte` files. Without it, Prettier cannot parse Svelte syntax. This is required even with `prettier-plugin-svelte` installed — the plugin registers the parser, but the override tells Prettier to use it for the right file type.

## tailwindStylesheet option

`prettier-plugin-tailwindcss` v0.7+ supports `tailwindStylesheet` to resolve Tailwind v4 class detection. Without it, the plugin may not sort classes correctly when using Tailwind v4's CSS-first configuration (no `tailwind.config.js`). The path is relative to the Prettier config file location.

## Key options explained

| Option | Project value | Default | Notes |
|--------|--------------|---------|-------|
| `useTabs` | `true` | `false` | Uses tabs for indentation |
| `singleQuote` | `true` | `false` | Single quotes for JS/TS strings |
| `trailingComma` | `"none"` | `"all"` (v3+) | No trailing commas |
| `printWidth` | `100` | `80` | Line wrap threshold |
| `tabWidth` | (unset) | `2` | Ignored when `useTabs: true` |
| `semi` | (unset) | `true` | Semicolons at statement ends |

Prettier v3 changed the default `trailingComma` from `"es5"` to `"all"`. This project explicitly sets `"none"`.

## Editor integration

VS Code settings (`.vscode/settings.json`):

```json
{
  "editor.defaultFormatter": "esbenp.prettier-vscode",
  "editor.formatOnSave": true
}
```

The Prettier VS Code extension reads `.prettierrc` automatically. No additional configuration needed beyond installing the extension and setting it as default formatter.

## Prettier vs ESLint responsibility split

| Concern | Tool | Examples |
|---------|------|----------|
| Formatting | Prettier | Indentation, quotes, semicolons, line wrapping, trailing commas |
| Code quality | ESLint | Unused vars, type errors, best practices, accessibility |

Never enable ESLint formatting rules when Prettier is active. The project uses `eslint-config-prettier` to disable conflicting ESLint rules. This is configured in `eslint.config.js`, not in Prettier itself.

### Why not eslint-plugin-prettier?

The project deliberately avoids `eslint-plugin-prettier` (running Prettier as an ESLint rule). Reasons:
- Redundant: `pnpm lint` already runs `prettier --check .` before ESLint
- Slower: Prettier runs twice (once via ESLint, once directly)
- Noisy: Every formatting difference becomes a red squiggly in the editor
- Brittle: Extra layer of indirection where things can break

## Configuration file precedence

Prettier resolves config starting from the file being formatted, searching up the file tree. Supported file types (in precedence order):

1. `"prettier"` key in `package.json`
2. `.prettierrc` (JSON or YAML)
3. `.prettierrc.json` / `.prettierrc.yml` / `.prettierrc.yaml`
4. `.prettierrc.js` / `.prettierrc.ts` / `prettier.config.js` / `prettier.config.ts`
5. `.prettierrc.mjs` / `.prettierrc.mts` / `prettier.config.mjs` / `prettier.config.mts`
6. `.prettierrc.cjs` / `.prettierrc.cts` / `prettier.config.cjs` / `prettier.config.cts`
7. `.prettierrc.toml`

This project uses `.prettierrc` (JSON). Do not create additional Prettier config files.

## .editorconfig interaction

If an `.editorconfig` file exists, Prettier parses it and converts its properties. The `.prettierrc` overrides `.editorconfig` settings. Relevant mappings:

| .editorconfig | Prettier option |
|---------------|----------------|
| `indent_style` | `useTabs` |
| `indent_size` / `tab_width` | `tabWidth` |
| `end_of_line` | `endOfLine` |
| `max_line_length` | `printWidth` |