# Vite Config Reference

Detailed configuration options for `vite.config.ts` in this SvelteKit + Svelte 5 project. Load this file when you need to configure options beyond the minimal defaults.

## Current Config

```ts
// frontend/vite.config.ts
import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({ plugins: [tailwindcss(), sveltekit()] });
```

## Server Options

All options are dev-only unless noted.

### `server.host`

- **Default**: `'localhost'`
- Set to `'0.0.0.0'` or `true` to listen on all addresses (LAN + public)
- For VS Code Dev Containers, use `'127.0.0.1'` (port forwarding doesn't support IPv6)

### `server.port`

- **Default**: `5173`
- If port is in use, Vite auto-increments. Set `server.strictPort: true` to fail instead

### `server.open`

- **Default**: `false`
- Set to `true` or a pathname string like `'/docs/index.html'` to auto-open browser

### `server.proxy`

Proxy API requests to a backend during dev:

```ts
server: {
  proxy: {
    '/api': {
      target: 'http://localhost:8080',
      changeOrigin: true,
      rewrite: (path) => path.replace(/^\/api/, ''),
    },
  },
}
```

- Keys starting with `^` are treated as RegExp
- If using a non-relative `base`, prefix each key with that `base`
- WebSocket proxy: add `ws: true`

### `server.hmr`

- **Default**: enabled with auto-detected port
- Set `server.hmr.overlay: false` to disable the error overlay
- Set `server.hmr.port` if HMR websocket must use a different port from the HTTP server
- Behind a reverse proxy, set `server.hmr.clientPort` to match the external port

### `server.watch`

- Uses chokidar; skips `.git/`, `node_modules/`, `test-results/`, and cache dirs
- WSL2 fix: `{ usePolling: true }` (higher CPU) or edit files with WSL2 apps
- Cannot watch files inside `node_modules/` — use `--force` after linking packages instead

### `server.fs.allow`

- **Default**: auto-detected workspace root (looks for `pnpm-workspace.yaml`, `lerna.json`, or `workspaces` in `package.json`)
- Restrict which files can be served via `/@fs/` when `server.fs.strict: true` (default)

### `server.cors`

- **Default**: allows `localhost`, `127.0.0.1`, `::1` origins
- **Never set to `true`** — it allows any origin to access your dev server

### `server.allowedHosts`

- **Default**: `[]` (localhost and `.localhost` domains allowed)
- **Never set to `true`** — enables DNS rebinding attacks

### `server.warmup`

Pre-transform frequently used files for faster cold starts:

```ts
server: {
  warmup: {
    clientFiles: ['./src/routes/**/*.svelte', './src/lib/**/*.svelte.ts'],
  },
}
```

Only add files that are used on most pages — too many slows startup.

## Build Options

All options are build-only unless noted.

### `build.target`

- **Default**: `'baseline-widely-available'` (Chrome 111+, Edge 111+, Firefox 114+, Safari 16.4+)
- Minimum: `es2015` (but Vite always requires native ESM dynamic import support)

### `build.outDir`

- **Default**: `'dist'`
- **Don't override** — SvelteKit's adapter controls the output directory

### `build.sourcemap`

- **Default**: `false`
- `true` → separate `.map` files; `'inline'` → data URI; `'hidden'` → `.map` files without comments in bundle

### `build.minify`

- **Default**: `'oxc'` (fast, good compression)
- Alternatives: `'terser'` (best compression, slow), `false` (no minification)
- `'esbuild'` is deprecated

### `build.cssMinify`

- **Default**: `'lightningcss'`
- Set to `'esbuild'` if needed (must install esbuild)

### `build.assetsInlineLimit`

- **Default**: `4096` (4 KiB)
- Assets smaller than this are inlined as base64 URLs; set to `0` to disable inlining

### `build.rolldownOptions`

Directly customize the underlying Rolldown bundler. Replaces the deprecated `build.rollupOptions`:

```ts
build: {
  rolldownOptions: {
    output: {
      chunkFileNames: 'assets/[name]-[hash].js',
    },
  },
}
```

### `build.manifest`

- Set to `true` to generate `.vite/manifest.json` mapping unhashed → hashed asset names
- Useful for backend integration

## OptimizeDeps Options

Dev-only options for dependency pre-bundling.

### `optimizeDeps.include`

Force pre-bundling of linked packages or packages not auto-detected:

```ts
optimizeDeps: {
  include: ['problematic-package', 'esm-dep > cjs-dep'],
}
```

Glob patterns for deep imports (experimental): `'my-lib/components/**/*.svelte'`

### `optimizeDeps.exclude`

Exclude packages from pre-bundling. **Don't exclude CJS dependencies** — they need pre-bundling for ESM interop.

### `optimizeDeps.force`

Set to `true` to ignore cache and re-bundle all dependencies. Equivalent CLI: `pnpm dev --force`

### `optimizeDeps.noDiscovery`

Set to `true` to disable auto-discovery — only `optimizeDeps.include` entries are pre-bundled.

## Resolve Options

### `resolve.alias`

Define import path aliases. SvelteKit provides `$lib` automatically — don't re-define it:

```ts
resolve: {
  alias: {
    '$utils': path.resolve('./src/lib/utils'),
  },
}
```

Always use absolute paths for alias values.

### `resolve.dedupe`

Force Vite to resolve duplicated copies of the same dependency to a single copy. Useful in monorepos with hoisting issues:

```ts
resolve: {
  dedupe: ['svelte', '@sveltejs/kit'],
}
```

## Shared Options

### `define`

Define global constant replacements (statically replaced at build time):

```ts
define: {
  __APP_VERSION__: JSON.stringify('v1.0.0'),
}
```

Add type declarations in `vite-env.d.ts` for TypeScript support.

### `base`

- **Default**: `'/'`
- Set for nested deployments: `'/my-app/'`
- For unknown deployment paths: `'./'` or `''` (relative base)
- Access in code: `import.meta.env.BASE_URL` (must be exact string, not computed)

### `assetsInclude`

Treat additional file types as static assets:

```ts
assetsInclude: ['**/*.gltf']
```

### `envDir`

- **Default**: project root
- Directory from which `.env` files are loaded

### `envPrefix`

- **Default**: `'VITE_'`
- **Never set to `''`** — exposes all env variables including secrets

## Environment Variables

### `.env` File Priority (highest to lowest)

1. Existing system environment variables
2. `.env.[mode].local`
3. `.env.[mode]`
4. `.env.local`
5. `.env`

### Built-in Constants

- `import.meta.env.MODE` — current mode string
- `import.meta.env.BASE_URL` — base URL from config
- `import.meta.env.PROD` — `true` in production
- `import.meta.env.DEV` — `true` in development
- `import.meta.env.SSR` — `true` in server-side rendering

### NODE_ENV vs Mode

| Command | NODE_ENV | Mode |
|---|---|---|
| `vite build` | `"production"` | `"production"` |
| `vite build --mode development` | `"production"` | `"development"` |
| `NODE_ENV=development vite build` | `"development"` | `"production"` |

Key: `NODE_ENV` controls `PROD`/`DEV`; mode controls which `.env.[mode]` file is loaded.