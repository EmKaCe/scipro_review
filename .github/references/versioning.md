# Versioning & Release Notes

**Decision N2 (locked 2026-08-21):** semver + release-note convention, applied
from the first public tag **`v2.5.0`** — **continuity** from the private
`2.3.x` lineage, **not** a reset to `1.0.0`. This project is published as
`scipro_review`.

## Scheme

| Aspect | Convention |
|--------|------------|
| Scheme | [Semantic Versioning](https://semver.org/spec/v2.0.0.html) `MAJOR.MINOR.PATCH` |
| First public tag | `v2.5.0` (next after the private `2.3.2` line; intermediate versions were never released publicly) |
| Tag format | `v`-prefixed (`v2.5.0`) |
| MAJOR | Breaking change for users of public API / documented workflows |
| MINOR | Backward-compatible feature or non-breaking enhancement |
| PATCH | Backward-compatible bug fix |
| Pre-public history | Not renumbered — the private `2.x` lineage carries over |

## Release notes & CHANGELOG

| Step | Where | What |
|------|-------|------|
| 1 | Maintainer | Fold `[Unreleased]` in `CHANGELOG.md` into the new version entry |
| 2 | Release workflow | A pushed `v*` tag triggers `release.yml`; notes are auto-generated (`generate_release_notes: true`) |
| 3 | GitHub Release | Workflow-generated notes; the maintainer **appends the folded CHANGELOG entry** to the release body (the workflow does not read `CHANGELOG.md`) |
| 4 | CHANGELOG | Re-open `[Unreleased]` for the next cycle |

## First public tag (cutover sequence)

1. Bump `frontend/package.json` version to `2.5.0` (must match the tag — `release.yml` gates tag-vs-`package.json`).
2. Fold `[Unreleased]` in `CHANGELOG.md` into a `[2.5.0]` entry.
3. `git tag v2.5.0` and push it; the workflow creates the release with auto-generated notes.
4. Append the folded CHANGELOG entry to the release body.
5. Re-open `[Unreleased]` in `CHANGELOG.md` for the next cycle.

## Rules

- The `package.json` version must match the tag — `release.yml` gates
  tag-vs-`package.json`.
- No version bump without a corresponding CHANGELOG entry.
- Never tag while `[Unreleased]` is still accumulating — fold first, then tag.