# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to the versioning convention in
[`.github/references/versioning.md`](.github/references/versioning.md)
(semver applied from the first public tag `2.5.0`).

## [Unreleased]

### Docs

- Removed the closed monolith-split ADR (decision is stable; git history keeps
  it) and its pointers; corrected the README's CI and Dependabot claims.

## [2.5.1] - 2026-08-21

### Added

- Static/student build: **Local data** settings card — back up all locally stored
  reviews (JSON), restore from a backup with counts, clear with an inline
  confirm. Student Settings carries no reference to teacher mode.
- App favicon: green check-mark SVG + 32 px and apple-touch PNG fallbacks
  (replaces the SvelteKit default).

### Changed

- Runtime dependency bumps (katex, marked, js-yaml, @mastra/core,
  @mastra/memory, @tiptap/*, highlight.js, @ai-sdk/openai-compatible).
- CI: `actions/setup-python@v7` and `astral-sh/setup-uv@v7` (removes Node 20
  deprecation warnings); dependabot config drops the dead gitsubmodule entry.

### Fixed

- Static/student build: Settings hides teacher-only cards via the `base === ""`
  gate; the placeholder "teacher-only" notice is gone.
- README mermaid diagrams render on GitHub (removed fragile `<br/>` / unicode
  label markup); corrected the stale "teacher routes render stubs" claim.

## [2.5.0] - 2026-08-21

### Added

- First-run onboarding checklist page (create/import assignment → wire
  criteria, scoring and provider → fetch docs index → first pre-eval).
- Standalone teacher-facing guide on calibrating, pre-evaluating, reviewing
  the copilot worksheet, and exporting grades.
- Synthetic grading-quality gate replacing the removed real-data gate.
- Docs index: 38,000+ chunks across 10 libraries, built from pinned PyPI
  docstrings; `fetch-docs-index` gains a `--public` plain-HTTPS download path.
- Copilot `get-submission-context` with screened, bounded previews of the
  autofix re-run so teachers can discuss fixes with the copilot.
- Consequential-error grading (Session C2): the autofix's verified clean
  re-run enters the grading prompt so downstream cells are not
  cascade-penalized by a root error; dispositions feed the prompt.
- Screening of student notebook content before every prompt path (pre-eval,
  plagiarism semantic pass, tool-result previews).

### Changed

- Provider config is now env-overridable (`PHASE_2_MODEL`) for
  OpenAI-compatible provider swaps; default unchanged.
- Design tokens centralized; UI-library surface reduced and dead fallbacks
  swept.
- Documentation consolidated under `.github/references/` as a single docs
  home.

### Fixed

- Grading-dimension tool values bounded to the rubric's `max_points` instead
  of a 0–1000 scale.
- `sklearn` no longer mislisted as a disallowed library.
- Docs-index volume/coverage staleness — migrated to a reproducible,
  config-driven build from installed PyPI docstrings.
- KI Connect concurrency ceiling restored to 2, with 429 retry/backoff and
  stream/JSON-repair hardening.