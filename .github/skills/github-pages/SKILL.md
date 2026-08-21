---
name: github-pages
description: "Use when: deploying a SvelteKit SPA to GitHub Pages, configuring adapter-static with SPA fallback, setting base path for sub-path deployment, troubleshooting 404s on direct route access, broken asset URLs, or configuring custom domains for a GitHub Pages site."
argument-hint: "<deployment-task>"
---

# GitHub Pages

Deploy a SvelteKit SPA to GitHub Pages using `@sveltejs/adapter-static` with `200.html` fallback for client-side routing.

## Procedure: Initial Setup

### 1. Install and configure adapter-static

```sh
pnpm add -D @sveltejs/adapter-static
```

Replace `adapter-auto` in `frontend/svelte.config.js`:

```js
import adapter from '@sveltejs/adapter-static';

export default {
  kit: {
    adapter: adapter({
      fallback: '200.html',
    }),
  },
};
```

### 2. Disable SSR

Create `frontend/src/routes/+layout.ts`:

```ts
export const ssr = false;
export const prerender = true;
```

### 3. Set base path (if deploying to a sub-path)

For project sites at `username.github.io/repo-name`, add `paths.base` to `svelte.config.js`:

```js
kit: {
  adapter: adapter({ fallback: '200.html' }),
  paths: {
    base: '/repo-name',
  },
}
```

For root deployment (`username.github.io`), omit `paths.base`.

### 4. Deploy via GitHub Actions

See the `github-actions` skill for the deploy workflow. Key points:
- Build runs in `frontend/` working directory
- Upload `frontend/build/` as the Pages artifact
- Deploy with `actions/deploy-pages@v4`

### 5. Verify deployment

After deployment, check:
- Direct navigation to sub-routes works (not just `/`)
- Client-side navigation between routes works
- Static assets (CSS, JS, images) load without 404s
- `200.html` is served for all unmatched paths

## Gotchas

- **`fallback: '200.html'` is required**: Without it, direct navigation to sub-routes returns 404. GitHub Pages serves static files only — the fallback file handles all routes.
- **`ssr: false` is required**: Without this, SvelteKit tries to SSR pages at build time, which fails without a backend. The app is client-side only.
- **`prerender: true` is required alongside `ssr: false`**: `adapter-static` needs at least one page to prerender. Setting both flags satisfies this requirement for SPA mode.
- **Base path must match repo name**: If deploying to `username.github.io/repo-name`, `paths.base` must be `/repo-name`. A mismatch breaks all asset URLs.
- **Base path requires leading slash, no trailing slash**: Use `/repo-name`, not `repo-name` or `/repo-name/`.
- **CNAME file for custom domains**: When using a custom domain with Actions deployment, add a `CNAME` file to `frontend/static/CNAME` containing your domain. This ensures it's included in the build output. Also configure the domain in repo Settings → Pages. See `references/custom-domains.md` for details.
- **`adapter-auto` must be replaced**: The default `adapter-auto` does not support GitHub Pages. It must be swapped for `adapter-static` — simply installing the package is not enough.
- **Build output is `frontend/build/`**: The artifact upload path must point to `frontend/build`, not `build`. The deploy workflow's `working-directory` and upload path must stay in sync.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Sub-routes return 404 on direct load | Missing `fallback: '200.html'` | Add `fallback: '200.html'` to adapter config |
| Build fails with "no prerendered pages" | Missing `prerender: true` | Add `export const prerender = true` to `+layout.ts` |
| Assets 404 (CSS/JS broken) | Base path mismatch | Set `paths.base` to match repo name |
| Custom domain shows GitHub 404 | DNS not propagated or CNAME missing | Verify DNS with `dig`; see `references/custom-domains.md` |
| HTTPS not enforced | Not enabled in settings | Enable "Enforce HTTPS" in repo Settings → Pages (may take up to 24h) |

## Reference Files

- **`references/custom-domains.md`** — Load when the user asks about custom domain setup, DNS configuration, apex vs subdomain records, or domain verification.

## Gotchas (continued)

- **Trailing slashes**: GitHub Pages may redirect URLs with/without trailing slashes. This can break SPA routing. Test both.
- **HTTPS only**: GitHub Pages enforces HTTPS for sites using `github.io` domains. Custom domains can opt into HTTPS enforcement.

## References

- [GitHub Pages docs](https://docs.github.com/en/pages)
- [SvelteKit adapter-static](https://svelte.dev/docs/kit/adapter-static)
- [GitHub Pages quickstart](https://docs.github.com/en/pages/quickstart)