---
name: vite
description: "Use when: configuring vite.config.ts, troubleshooting dev server or HMR issues, fixing production build errors, adding Vite plugins, handling static assets or environment variables, resolving dependency pre-bundling problems in a SvelteKit + Svelte 5 project."
argument-hint: "<vite-task>"
---

# Vite

Configure and troubleshoot Vite as the build tool for this SvelteKit + Svelte 5 project. Vite provides the dev server with HMR and the production bundler using Rolldown.

## Project Configuration

- **Frontend root**: `frontend/` (all commands run from here)
- **Package manager**: `pnpm`
- **Current config**: `frontend/vite.config.ts` — `tailwindcss()` before `sveltekit()`
- **Adapter**: Dual adapter — `@sveltejs/adapter-static` (student/GitHub Pages, default) and `@sveltejs/adapter-node` (teacher/Docker, via `ADAPTER=node`). Selected in `svelte.config.js` via `process.env.ADAPTER`.
- **SSR**: disabled for student mode (`export const ssr = false` in `+layout.ts`); enabled for teacher mode

## Procedure: Dev Server Issues

1. Start the dev server: `pnpm dev`
2. If HMR breaks for Svelte files, check that runes (`$state`, `$derived`, `$effect`) are only used in `.svelte` or `.svelte.ts` files — never in plain `.ts`
3. If requests stall on Linux, check file descriptor limits: `ulimit -Sn` (increase to 10000+ if needed)
4. If file changes aren't detected on WSL2, edit files with WSL2 apps (not Windows apps) or set `server.watch: { usePolling: true }`
5. If full reloads happen instead of HMR, check for circular dependencies: `vite --debug hmr`
6. For API proxy issues, configure `server.proxy` in `vite.config.ts` (see references/config-reference.md)

## Procedure: Production Build Issues

1. Always test with `pnpm build && pnpm preview` before deploying
2. If the build succeeds but the app fails in browser, check for:
   - Case-sensitive import paths (works on macOS/Windows dev, fails on Linux deploy)
   - `VITE_` env vars missing in production (they're statically replaced at build time)
   - Dynamic imports failing due to ad-blockers (rename chunks via `build.rolldownOptions.output.chunkFileNames`)
3. If you see "Failed to fetch dynamically imported module" after deployment, handle the `vite:preloadError` event to reload the page
4. For deployment version skew, set `Cache-Control: no-cache` on the HTML file

## Procedure: Adding a Vite Plugin

1. Install the plugin: `pnpm add -D <plugin-package>`
2. Import and add to `vite.config.ts` plugins array
3. **Plugin order matters**: `tailwindcss()` must come before `sveltekit()`
4. If the plugin needs to transform code before Svelte, place it before `sveltekit()`; if it operates on output, place it after

```ts
// frontend/vite.config.ts
import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    tailwindcss(),
    sveltekit(),
  ],
});
```

## Procedure: Environment Variables

1. **Prefer SvelteKit's `$env/static/public` and `$env/static/private`** over Vite's `import.meta.env` — SvelteKit validates at build time and keeps secrets server-side
2. If you must use Vite env vars, prefix with `VITE_` and access via `import.meta.env.VITE_*`
3. Never put secrets in `VITE_` variables — they're bundled into client code at build time
4. For TypeScript IntelliSense, augment `ImportMetaEnv` in `src/vite-env.d.ts` (no `import` statements allowed in that file)

## Procedure: Static Assets

1. **Import assets** for hashing and optimization: `import logo from '$lib/assets/logo.svg'` → returns hashed URL path
2. **`static/` directory** for files that must keep their original name (e.g., `robots.txt`, `favicon.png`) — reference with `%sveltekit.assets%/` in HTML
3. Assets < 4 KiB are inlined as base64 by default; set `build.assetsInlineLimit` to change the threshold
4. Use `?url`, `?raw`, `?inline`, `?no-inline` suffixes to control import behavior explicitly

## Procedure: Dependency Pre-bundling Issues

1. If a dependency causes dev server errors, add it to `optimizeDeps.include`:
   ```ts
   optimizeDeps: { include: ['problematic-package'] }
   ```
2. If a linked local package isn't detected, force re-optimization: `pnpm dev --force`
3. For CJS dependencies that break when excluded, add the nested CJS dep: `optimizeDeps: { include: ['esm-dep > cjs-dep'] }`
4. Clear the cache manually if needed: delete `node_modules/.vite/`

## Gotchas

- **SvelteKit manages most build config**: Don't override `build.outDir` or `build.rolldownOptions` — the adapter controls output
- **Plugin order**: `tailwindcss()` before `sveltekit()`. Wrong order causes CSS processing failures
- **Runes + HMR**: Svelte 5 runes only work in `.svelte` and `.svelte.ts` files. Using them in plain `.ts` breaks HMR and throws "is not defined" at runtime
- **Rolldown, not Rollup**: Vite v8+ uses Rolldown for production builds. `rollupOptions` is deprecated — use `rolldownOptions` instead
- **Dev vs build divergence**: Some issues only appear in production. Always `pnpm build && pnpm preview` before deploying
- **`VITE_` env vars are not secret**: They're statically replaced into client code at build time. Use `$env/static/private` for secrets
- **`import.meta.env.BASE_URL` must be exact**: `import.meta.env['BASE_URL']` won't work — it's statically replaced
- **CORS in dev**: Dev server allows localhost origins by default. Setting `server.cors: true` allows any origin — avoid this
- **`server.allowedHosts`**: Never set to `true` in production — it enables DNS rebinding attacks

## References

- **[config-reference.md](references/config-reference.md)**: Load when you need to configure `server.*`, `build.*`, `optimizeDeps.*`, or `resolve.*` options beyond the defaults
- [Vite docs](https://vite.dev/guide/)
- [Vite config reference](https://vite.dev/config/)
- [SvelteKit Vite integration](https://svelte.dev/docs/kit/packaging)