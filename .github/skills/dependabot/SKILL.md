---
name: dependabot
description: "Use when: configuring Dependabot for dependency updates, setting up version updates, configuring auto-merge, managing security updates, or troubleshooting Dependabot configuration in a pnpm monorepo."
argument-hint: "<dependabot-task>"
---

# Dependabot

Configure Dependabot for automated dependency updates in a pnpm-based SvelteKit monorepo. The frontend lives in `frontend/` — this affects every `directory` setting.

## Procedure: Set Up Dependabot

1. Create `.github/dependabot.yml` at the repository root
2. Define one `package-ecosystem: npm` entry with `directory: /frontend`
3. Add `package-ecosystem: github-actions` with `directory: /` for CI workflows
4. Add `package-ecosystem: gitsubmodule` with `directory: /` for submodule references
5. Group dev and production dependencies separately to reduce PR noise
6. Load `references/config-reference.md` for the full config template and all available options

## Procedure: Add or Modify Groups

1. Open `references/config-reference.md` → "Groups Options" for available fields
2. Use `patterns` with `@scope/*` or `prefix-*` globs to match dependency names
3. Use `update-types: [minor, patch]` to limit SemVer levels per group
4. Use `dependency-type: development` or `production` as an alternative to `patterns`
5. First matching group wins — order your groups from specific to general
6. Unmatched dependencies get individual PRs

## Procedure: Ignore Specific Updates

1. Add an `ignore` block under the relevant `package-ecosystem` entry
2. Use `update-types: [version-update:semver-major]` to block major bumps
3. Use `versions: [">=5.0.0"]` with npm range syntax to pin versions
4. `ignore` overrides `allow` — if both match, the dependency is ignored

## Procedure: Enable Auto-Merge

1. Enable "Allow auto-merge" in repo Settings → General
2. Create a CI workflow that runs on `pull_request` targeting the default branch
3. Add required status checks via branch protection rules
4. Set `open-pull-requests-limit: 10` to allow more concurrent PRs (default is 5)
5. Auto-merge only triggers after all required checks pass

## Procedure: Troubleshoot Dependabot PRs

1. If no PRs appear, verify `directory` points to a location with a manifest file
2. If PRs are missing pnpm updates, confirm `pnpm-lock.yaml` exists in the same directory as `package.json`
3. If a security PR bypasses your schedule — this is expected; security updates ignore `schedule` and `open-pull-requests-limit`
4. If grouped PRs are too large, narrow `patterns` or add `exclude-patterns`
5. If Dependabot reopens a PR you closed, add an `ignore` rule for that dependency
6. Check the "Insights → Dependency graph" tab to see what Dependabot detects

## Gotchas

- **`directory: /frontend`** — The `package.json` is in `frontend/`. Using `/` (root) will fail because there's no manifest there.
- **pnpm uses `package-ecosystem: npm`** — Dependabot reads `pnpm-lock.yaml` automatically. There is no `package-ecosystem: pnpm`. Never create one.
- **Lockfile updates are automatic** — Dependabot updates both `package.json` and `pnpm-lock.yaml`. Always review lockfile changes in PRs.
- **Security updates bypass everything** — Security vulnerability PRs ignore `schedule`, `open-pull-requests-limit`, and `ignore` rules. They always fire.
- **Security updates have a separate limit** — Internal limit of 10 open security PRs (not configurable).
- **`ignore` overrides `allow`** — If a dependency matches both, it is ignored.
- **Groups match first-to-last** — Order groups from specific to general. Unmatched deps get individual PRs.
- **Git submodules need their own entry** — Add `package-ecosystem: gitsubmodule` with `directory: /` for submodule references like `svelte_prototype`.
- **`version-update` vs `version-update:semver-*`** — In `ignore`, use `version-update:semver-major` (not `version-update`). In `groups.update-types`, use `minor`/`patch`/`major` (no prefix).
- **Cooldown only affects version updates** — The `cooldown` option delays new-release adoption but never blocks security updates.

## References

- **`references/config-reference.md`** — Full option reference, groups detail, ignore syntax, versioning strategies, cooldown, and complete config template for this project. Load when writing or modifying `dependabot.yml`.
- [Dependabot options reference](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference) — Official GitHub docs for all configuration options