# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to the versioning convention in
[`.github/references/versioning.md`](.github/references/versioning.md)
(semver applied from the first public tag `2.5.0`).

## [Unreleased]

## [2.9.0] - 2026-08-31

### Added

- **Offline docs-index setup — three options (2.7.0)**: the docs leg can be
  A — download the prebuilt release corpus (~600 MB, no API key), B — re-embed
  the released chunks locally against the configured endpoint, or C — skip
  vectors and stay BM25-only. A new `docs-embed-rebuild` job runner writes
  staged vectors at deterministic offsets and swaps them in atomically;
  single-flight is shared between download and rebuild (409 on contention);
  crashes surface as an `interrupted` retryable state. Manifest-driven query
  embedding mirrors the `e5-` prefix, and the embedding model is optional
  (`llm.embedding_model`, settings → env → built-in default).
- **Onboarding setup wizard (2.8.0)**: teacher builds land on a step-shell
  wizard (`/onboarding`) until core setup is complete — fresh-vs-restore
  fork, in-place LLM provider (key + model + base URL + timeout), docs-index
  install, live executor health probe, one-click reference-assignment seed
  (verify + enable the bundled `soil_contamination`), and a non-blocking
  "you're done" closing step. The wizard reuses the existing restore /
  settings / docs-embeddings endpoints; only the seed endpoint, the executor
  health probe, and the persisted dismiss record are new. `.env` was demoted
  to deployment-only documentation — runtime provider config lives in the
  settings store.
- **Real download progress (2.8.1)**: the prebuilt download is a tracked job
  like the embed rebuild — the fetch script streams bytes and the card shows
  MB downloaded / total, MB/s, ETA, a progress bar, and a Cancel button.
  Both jobs share one status contract (`GET
  /api/onboarding/docs-embeddings/status`), including crash recovery.
- Executor: pytest declared as a dev dependency (`uv add --dev`).
- Release workflow now builds and uploads the student/teacher tarballs
  (`release.yml`), and the docs-index release carries a regenerated manifest
  (38,380 chunks, correct sha256s, stale-manifest cross-checks).

### Changed

- **BM25 gate calibrated (fix)**: `docs-rag` compared its semantic-embed
  score against a normalized assumption; live measurement showed raw BM25
  scores scale with query length, so the semantic leg never fired. Threshold
  moved to raw-score space (150) with an env override and a kept eval
  harness — semantic retrieval now actually runs on real queries.
- **Chunks-only fetch**: `fetch-docs-index.mjs` gained `--chunks-only`
  (corpus without the 600 MB vectors bin) for the local re-embed path, with
  stale-manifest guards (chunk counts cross-checked after sha256).
- **Settings page cleanup**: the read-only "Configuration map" card was
  removed — every file-backed row linked to an editor already on the same
  page, env rows were read-only by nature, and values went stale between
  manual refreshes. The page keeps the real editors (Execution & AI, Docs
  index, Grading, Data management, Danger zone); the README's purpose-grouped
  tables remain the documentation home.
- **Entrypoint redirect fix**: the wizard redirect previously consulted only
  the persisted dismiss flag, so a stale `data/wizard_state.json` silently
  disabled the wizard and stranded the teacher on the dashboard. The gate now
  keys on core completeness (assignment + scoring + LLM provider) — dismiss
  never suppresses the wizard while setup is incomplete; the runtime state
  file is gitignored. Root-path precedence over the `/ → /submissions` page
  redirect is pinned by a regression test.

## [2.6.1] - 2026-08-30

### Fixed

- **Copilot chat failed with `The model 'gpt-oss-120b' does not exist`**
  when `settings.yaml` carried the unprefixed model id. The copilot agent
  passes `llm.model` to KI Connect **raw** (the Phase-2 pipeline auto-prefixes,
  the agent does not), and KI Connect's registry uses **mixed vendor
  prefixes** (`openai-gpt-oss-120b` is prefixed, `qwen3-30b-…` is not), so
  ids cannot be auto-corrected — they must match the registry exactly.
  `data/settings.yaml` now carries the canonical `openai-gpt-oss-120b`.
  Found in the fresh-machine smoke run of the public v2.6.0 (clean clone,
  docker compose, full pipeline exercised with synthetic submissions).
- **Phase-2 model ids now pass through verbatim — provider-neutral by
  design.** `getPhase2Model()` no longer prepends the `openai-` KI Connect
  convention: that auto-prefix was a leftover from when settings.yaml stored
  the unprefixed id (2.6.1 ships the canonical id), and it actively broke
  other providers (`openai-` + `qwen/qwen3-30b` → a mangled id that fails
  Phase 2 on OpenRouter while the copilot worked). The configured
  `llm.model` must match the provider's registry exactly — true for KI
  Connect and any OpenAI-compatible endpoint alike; `PHASE_2_MODEL` remains
  as the explicit override. Regression tests pin pass-through for
  OpenRouter-style slashed ids and unchanged resolution for the KI Connect
  canonical id (golden prompt fixture unaffected).
- **Configured model id is now verified against the live registry** at the
  first pipeline/copilot use: `warnIfUnknownModel` (ki-connect.ts) fetches
  `GET {baseUrl}/models` (via the existing non-throwing `listModels()`),
  warns loudly once per process when the configured id is absent, and stays
  completely silent when the registry is unreachable — a failed check can
  never break a grading run. Wired into pre-evaluation and the copilot chat
  turn, the two paths that consume `llm.model`.
- **Transitive dependency alerts (Dependabot fold):** lockfile re-resolve
  cleared 5 of 7 advisories — `brace-expansion` (3× DoS) → 5.0.9, `fast-uri`
  (host confusion) → 3.1.6, `nanoid` (infinite loop) → 3.3.18. The remaining
  2 low-severity advisories (`cookie@0.6` under SvelteKit's `^0.6.0` pin,
  `@ai-sdk/provider-utils@3.0.30` under mastra's exact alias) are
  upstream-pinned and tracked by Dependabot — forcing them via overrides
  would run the frameworks against semver-incompatible dependencies.
  `@mastra/core` 1.61.0 → 1.63.2, `@mastra/memory` 1.27.0 → 1.28.1.

### Added

- **`SECURITY.md`** — security policy (supported versions, private
  vulnerability reporting, trust-boundary notes on the untrusted-input
  screening / static-student vs teacher-node split / key handling).

### Docs

- README troubleshooting: new entry for `The model '…' does not exist`
  (mixed registry prefixes, how to list valid ids, restart-to-apply for
  settings changes).
- `.env.example`: `KI_CONNECT_MODEL` documented as registry-exact (with the
  `GET /models` pointer), and `data/settings.yaml` comments use the
  canonical id.

## [2.6.0] - 2026-08-24

### Added

- **Live configuration map** (settings): `GET /api/config/map` aggregates the
  running server's configuration from the real loaders (settings.yaml,
  grading_config.yaml, assignments.yaml, env, code constants) — the Settings
  "Configuration map" card now reports live values with source, edit
  affordance, and reload semantics per row; file-backed rows deep-link to
  their owning editor cards; env rows show "restart to apply" honestly; the
  API-key row reports masked presence only (never read back).
- **Two-path onboarding**: a "Restore a backup from another machine" card
  (two-click confirm, 200 MB cap, one-click download of the current backup)
  plus in-place LLM setup on the checklist — write-only API-key field and a
  model picker with recommendation badges ("Recommended" for the
  pipeline-tuned grading model, "Fast — good for validation" for cheap
  models, gated on the instance's live model list). Dashboard first-run
  callout invites "set up your first assignment or restore a backup".
- **"Pre-evaluation results" redesign**: per-cell verdict reasons now render
  inside the cell cards next to the code; the old collapsed "Reference
  Comparison" bar is a compact always-visible summary (notebook summary +
  suggested grade with grading-config dimension titles + Apply in the
  header); pending state is an invitation to run pre-evaluation.
- **Dimension-attributed criteria**: optional `dimensions` on main-point
  groups (default) and sub-points (override, replace-never-merge) with a
  shared resolver; soft validation (absent allowed, malformed/unknown keys
  rejected with the known set); the criteria editor gains subtle dimension
  chip controls and a quiet "no dimension" indicator; preview shows resolved
  chips.
- **Turn-based "Draft with AI"** for criteria: phased pipeline (grounding →
  category planning → per-category turns → deterministic merge → consistency
  pass with surfaced coverage notes → validation gate with retry, max 3).
  Grounds on assignment PDF + key notebook + input-data list + the fixed
  dimension contract, so it no longer requires an existing own rubric
  (chicken-and-egg removed). Never writes — the teacher reviews and saves.
- Dashboard **first-run state**: when `assignments.yaml` is absent the
  dashboard shows an onboarding callout pointing at the setup checklist
  instead of the red misconfiguration banner; `GET /api/assignments` returns a
  machine-readable `code: "assignments-missing"` to drive it.
- **Single-source criteria sharing** (2.6 deployment model): compose binds the
  repo's tracked `data/` directly into `/app/data` in both containers — no
  named volume, no seed, no sync step. Criteria authored in the app are
  immediately changes in the git tree; `git pull` makes shared criteria live
  on the next page load. Gitignored runtime state (submissions, materials,
  copilot, plagiarism, the ~680 MB docs index) lives in the same tree but is
  never committed; `data/docs-index/` was added to `.gitignore`, and the
  student build's `../data` copy now strips runtime dirs. Migration for older
  named-volume installs is documented in the README (the
  `criteria-export`/`criteria-import` scripts remain as host/migration
  helpers, no longer part of the Docker workflow).

### Changed

- **Dependency bumps (Dependabot)**: dev-tools group (svelte 5.56.10,
  vite 8.2.2, vitest 4.1.11, @sveltejs/kit 2.70.3, lucide 1.33, svelte-check,
  typescript-eslint, eslint, globals, @playwright/test, @types/node,
  @sveltejs/vite-plugin-svelte), @mastra/core 1.61.0,
  @ai-sdk/openai-compatible 3.0.34, and **pdf-parse 1.1.1 → 2.4.5** (migrated
  to the v2 `PDFParse` class API; the old `lib/pdf-parse.js` subpath import
  and its ambient declaration are gone).
- README Configuration section: purpose-group table, the code-constant
  inventory the UI no longer shows, and a pointer to the in-app live map.

### Fixed

- **Uploads over 512K failed with a misleading `400 "Expected a
  multipart/form-data body"`.** SvelteKit's adapter-node enforces
  `BODY_SIZE_LIMIT` (default 512K) by erroring the request stream mid-read;
  the per-route `catch` turned that into the generic multipart error, so
  real notebooks, materials PDFs, and backups (routinely > 512K) could not
  be uploaded. `BODY_SIZE_LIMIT` is now 50M in the Dockerfile,
  `.env.example`, and `start:teacher`, and all multipart routes (materials,
  submissions/upload, criteria upload, backup restore) route through a
  shared `parseMultipartFormData` that rethrows the body-limit rejection as
  a genuine 413 with the real message (new unit tests).
- **Intermittent pre-eval failures:** KI Connect retried only 429 — a
  transient upstream 5xx, request timeout, or network blip failed the whole
  row immediately. Transient classes now get bounded retries with backoff
  (429 rate-limits always retried with backoff + `Retry-After`; other 4xx
  client errors are never retried), and after a batch the dashboard toasts
  the per-row failure reasons (previously reasons lived only in the
  pipeline log).
- **Material upload panel** labeled every non-data file "Material" — key
  notebooks now show **Key** (with a key icon) and PDFs show **PDF**; the
  detection was always correct (`hasKey`), only the row label was wrong.
- **Submissions toolbar** (Plagiarism / Pre-evaluate All / Manage
  Assignments / Backup) was clipped by the table container at narrow
  widths — the toolbar and action group now wrap instead of overflowing.
- **Pipeline log timestamps** wrapped on locales with AM/PM and could line-
  break inside the fixed-width time column — now forced 24-hour format with
  no-wrap + ellipsis.

### Docs

- Removed the closed monolith-split ADR (decision is stable; git history keeps
  it) and its pointers; corrected the README's CI and Dependabot claims.
- README Configuration section refresh (purpose-group table, code constants,
  live-map pointer).

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