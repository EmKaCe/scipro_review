---
name: github-actions
description: "Use when creating or modifying GitHub Actions workflows, configuring CI/CD pipelines for a SvelteKit project, setting up GitHub Pages deployment with actions/deploy-pages, troubleshooting workflow failures, or adding lint/type-check/build checks."
argument-hint: "<workflow-task>"
---

# GitHub Actions

Create and manage GitHub Actions workflows for a SvelteKit + Svelte 5 project deployed to GitHub Pages via `actions/deploy-pages`.

## Procedure

### 1. Create or modify a workflow

1. Determine the workflow type: **deploy** (build + deploy to Pages) or **CI** (lint + check).
2. Place the file in `.github/workflows/` (e.g., `deploy.yml`, `ci.yml`).
3. Load the appropriate template from `references/workflow-templates.md` and adapt it.
4. Verify all `run` steps include `working-directory: frontend`.
5. Confirm permissions, concurrency, and trigger events are correct.

### 2. Set up GitHub Pages deployment

1. In repo Settings → Pages, set **Source** to "GitHub Actions" (not "Deploy from a branch").
2. The deploy workflow uses `actions/upload-pages-artifact@v5` + `actions/deploy-pages@v5`.
3. The `deploy` job must reference the `github-pages` environment and `needs: build`.
4. Ensure the repo has the `github-pages` environment (auto-created on first deploy).

### 3. Troubleshoot a failing workflow

1. Check the workflow run logs in the Actions tab.
2. Common causes (ordered by likelihood):
   - Missing `working-directory: frontend` on a `run` step → "command not found" or "no such file"
   - Missing `id-token: write` permission → OIDC error on deploy
   - `pnpm install` without `--frozen-lockfile` → lockfile drift
   - Wrong `cache-dependency-path` → cache miss, slow builds
   - Node version < 22 → Svelte 5 incompatibility
3. If the deploy job fails, verify the `build` job completed and uploaded the artifact.

## Project-Specific Conventions

| Setting | Value |
|---------|-------|
| App directory | `frontend/` |
| Package manager | pnpm 11 (`pnpm/action-setup@v6`) |
| Node version | 22 (`actions/setup-node@v6`) |
| Build output | `frontend/build` |
| Lockfile path | `frontend/pnpm-lock.yaml` |
| Adapter | `@sveltejs/adapter-static` (SPA fallback) |
| Deploy action | `actions/deploy-pages@v5` |
| Artifact action | `actions/upload-pages-artifact@v5` |
| Checkout action | `actions/checkout@v6` |

## Required Permissions for Pages Deploy

```yaml
permissions:
  contents: read
  pages: write
  id-token: write   # OIDC — missing this causes silent deploy failure
```

## Concurrency Defaults

- **Deploy workflow**: `cancel-in-progress: false` (let current deploy finish)
- **CI workflow**: `cancel-in-progress: true` (cancel stale PR checks)

## Gotchas

- **`working-directory: frontend`**: Every `run` step needs this. The app is in a subdirectory, not the repo root. Missing this is the #1 cause of workflow failures.
- **`--frozen-lockfile`**: Always use `pnpm install --frozen-lockfile` in CI. Without it, pnpm may mutate the lockfile and cause inconsistent builds.
- **`id-token: write`**: Required for OIDC authentication with GitHub Pages. Omitting it causes the deploy step to fail with a cryptic OIDC error, not a clear permission message.
- **`cache-dependency-path`**: Must point to `frontend/pnpm-lock.yaml` for `actions/setup-node` caching to work. Wrong path = cache miss every run.
- **Node 22+**: Svelte 5 requires Node 18+. Node 22 is the project standard. Older versions may fail at build time.
- **`needs: build`**: The `deploy` job must declare `needs: build`. Without it, deploy runs before the artifact exists and fails.
- **`concurrency` group naming**: Use unique group names per workflow to avoid cross-workflow cancellation. Deploy: `group: pages`. CI: `group: ${{ github.workflow }}-${{ github.ref }}`.
- **GITHUB_TOKEN in forks**: Workflows triggered from forks get a read-only `GITHUB_TOKEN`. Secrets (except `GITHUB_TOKEN`) are not available. This affects PR CI checks from external contributors.
- **`defaults.run.working-directory`**: You can set this at the job level to avoid repeating `working-directory: frontend` on every step, but be aware it only applies to `run` steps, not `uses` steps.
- **Action version pinning**: Pin to major version tags (e.g., `@v6`) not patch versions. Dependabot handles minor/patch bumps automatically. All actions in this project use Node 24-based versions (v6/v5) — older Node 20-based versions (v4/v3) will show deprecation warnings starting June 2026.
- **`upload-pages-artifact@v5` excludes dotfiles by default**: If your build output includes hidden files (e.g., `.well-known/`), set `include-hidden-files: true`.
- **`setup-node@v6` auto-detects package manager cache**: If `packageManager` is set in `package.json`, caching is automatic. Set `package-manager-cache: false` to disable.

## When to Load References

- **`references/workflow-templates.md`**: Load when creating a new workflow file. Contains complete deploy.yml and ci.yml templates with all project-specific values filled in.