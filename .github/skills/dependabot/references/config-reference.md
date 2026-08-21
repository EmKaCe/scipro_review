# Dependabot Configuration Reference

Complete reference for `.github/dependabot.yml` options relevant to this project.

## Required Structure

```yaml
version: 2
updates:
  - package-ecosystem: <string>      # Required
    directory: <string>               # Required
    schedule:
      interval: <string>              # Required
```

## Package Ecosystems for This Project

| Ecosystem | `package-ecosystem` value | Notes |
|-----------|--------------------------|-------|
| npm/pnpm/yarn | `npm` | pnpm uses `npm` ecosystem — reads `pnpm-lock.yaml` automatically |
| GitHub Actions | `github-actions` | Scans `/.github/workflows` when `directory: "/"` |
| Git submodules | `gitsubmodule` | For submodule references like `svelte_prototype` |

## Schedule Options

| Option | Values | Default |
|--------|--------|---------|
| `interval` | `daily`, `weekly`, `monthly`, `quarterly`, `semiannually`, `yearly`, `cron` | Required |
| `day` | `monday`–`sunday` | Monday (for weekly) |
| `time` | `hh:mm` | Random |
| `timezone` | IANA timezone string | UTC |
| `cronjob` | Cron expression (requires `interval: cron`) | — |

## Groups Options

Groups bundle related dependency updates into a single PR.

| Option | Description |
|--------|-------------|
| `patterns` | Glob patterns matching dependency names (supports `*` wildcard) |
| `exclude-patterns` | Patterns to exclude from the group |
| `update-types` | `minor`, `patch`, `major` — limit to SemVer level |
| `dependency-type` | `development` or `production` (npm supports both) |
| `applies-to` | `version-updates` (default) or `security-updates` |
| `group-by` | `dependency-name` — cross-directory grouping in monorepos |

**Matching rules**: If a dependency matches multiple groups, it joins the first match. Unmatched dependencies get individual PRs.

## Ignore Options

| Option | Description |
|--------|-------------|
| `dependency-name` | Name of dependency to ignore (supports `*` wildcard) |
| `versions` | Version range to ignore (npm syntax: `^1.0.0`) |
| `update-types` | `version-update:semver-major`, `version-update:semver-minor`, `version-update:semver-patch` |

**Note**: `ignore` takes precedence over `allow`. If a dependency matches both, it is ignored.

## Versioning Strategy

Controls how Dependabot edits `package.json` version constraints.

| Strategy | Behavior |
|----------|----------|
| `auto` | Default — `increase` for apps, `widen` for libraries |
| `increase` | Bump minimum version to match new release |
| `increase-if-necessary` | Leave constraint if it already allows new version; otherwise widen |
| `lockfile-only` | Only update lockfile, never change `package.json` |
| `widen` | Widen range to include both old and new versions |

For this project (SPA app, not a library), `auto` resolves to `increase`, which is correct.

## Cooldown (Version Updates Only)

Delay updates for newly released versions to avoid adopting broken releases.

| Option | Description |
|--------|-------------|
| `default-days` | Default cooldown for all dependencies |
| `semver-major-days` | Cooldown for major updates |
| `semver-minor-days` | Cooldown for minor updates |
| `semver-patch-days` | Cooldown for patch updates |
| `include` | Dependencies to apply cooldown (supports `*` wildcard, max 150) |
| `exclude` | Dependencies excluded from cooldown (takes precedence over `include`) |

Cooldown does **not** apply to security updates.

## Commit Message Options

| Option | Description |
|--------|-------------|
| `prefix` | Prefix for all commit messages (max 50 chars; colon auto-appended if ends with letter/digit) |
| `prefix-development` | Separate prefix for dev dependency commits (npm supports this) |
| `include` | `scope` — appends `deps` or `deps-dev` after prefix |

## Other Options

| Option | Description |
|--------|-------------|
| `open-pull-requests-limit` | Max concurrent version-update PRs (default: 5; security updates have separate limit of 10) |
| `labels` | Replace default labels (default: `dependencies` + ecosystem label) |
| `reviewers` | GitHub usernames or team mentions |
| `assignees` | GitHub usernames (must have write access) |
| `target-branch` | Branch to target PRs against (default: repository default branch) |
| `rebase-strategy` | `disabled` to stop auto-rebasing |
| `exclude-paths` | Glob patterns for files/dirs to skip during scans |
| `registries` | Reference to top-level private registry definitions |
| `allow` | Whitelist specific dependencies for updates |
| `milestone` | Numeric milestone ID to associate with PRs |

## Full Config Example for This Project

```yaml
# .github/dependabot.yml
version: 2

updates:
  # Frontend npm/pnpm dependencies
  - package-ecosystem: npm
    directory: /frontend
    schedule:
      interval: weekly
      day: monday
    open-pull-requests-limit: 10
    labels:
      - dependencies
      - frontend
    commit-message:
      prefix: chore
      include: scope
    versioning-strategy: increase
    groups:
      dev-dependencies:
        patterns:
          - "@eslint/*"
          - "@tailwindcss/*"
          - "@sveltejs/*"
          - "eslint-*"
          - "prettier-*"
          - "typescript*"
        update-types:
          - minor
          - patch
      production-dependencies:
        patterns:
          - "@lucide/*"
          - "clsx"
          - "tailwind-merge"
          - "tailwind-variants"
        update-types:
          - patch
    ignore:
      - dependency-name: svelte
        update-types: [version-update:semver-major]

  # GitHub Actions workflows
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
      day: monday
    labels:
      - dependencies
      - ci

  # Git submodules
  - package-ecosystem: gitsubmodule
    directory: /
    schedule:
      interval: monthly
    labels:
      - dependencies
      - submodules
```