# Workflow Templates

Complete GitHub Actions workflow templates for this project. Load this file when creating a new workflow.

## Deploy Workflow (GitHub Pages)

```yaml
# .github/workflows/deploy.yml
name: Deploy to GitHub Pages

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: pnpm/action-setup@v6
        with:
          version: 11
      - uses: actions/setup-node@v6
        with:
          node-version: 22
          cache: pnpm
          cache-dependency-path: frontend/pnpm-lock.yaml

      - run: pnpm install --frozen-lockfile
        working-directory: frontend
      - run: pnpm build
        working-directory: frontend

      - uses: actions/upload-pages-artifact@v5
        with:
          path: frontend/build

  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - uses: actions/deploy-pages@v5
        id: deployment
```

## CI Workflow (Lint + Type-Check)

```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: pnpm/action-setup@v6
        with:
          version: 11
      - uses: actions/setup-node@v6
        with:
          node-version: 22
          cache: pnpm
          cache-dependency-path: frontend/pnpm-lock.yaml

      - run: pnpm install --frozen-lockfile
        working-directory: frontend
      - run: pnpm lint
        working-directory: frontend
      - run: pnpm check
        working-directory: frontend
```

## Using `defaults.run.working-directory` (Alternative)

To avoid repeating `working-directory: frontend` on every step, set it as a job default:

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: frontend
    steps:
      - uses: actions/checkout@v6
      - uses: pnpm/action-setup@v6
        with:
          version: 11
      - uses: actions/setup-node@v6
        with:
          node-version: 22
          cache: pnpm
          cache-dependency-path: frontend/pnpm-lock.yaml

      - run: pnpm install --frozen-lockfile
      - run: pnpm build

      - uses: actions/upload-pages-artifact@v5
        with:
          path: frontend/build
```

**Note**: `defaults.run.working-directory` only applies to `run` steps. `uses` steps (like `actions/upload-pages-artifact`) still need the correct `path` set explicitly.

## Adding a Build Verification Step

To verify the build output exists after `pnpm build`:

```yaml
- run: pnpm build
  working-directory: frontend
- name: Verify build output
  run: test -d build || (echo "Build output missing!" && exit 1)
  working-directory: frontend
```

## Adding Path Filters

To only run CI when frontend files change:

```yaml
on:
  push:
    branches: [main]
    paths:
      - 'frontend/**'
  pull_request:
    branches: [main]
    paths:
      - 'frontend/**'
```

**Note**: If a workflow is skipped due to path filtering, associated required status checks remain "Pending" and block PR merging. Only add path filters if the check is not a required status check.