# AGENTS.md — data/ (runtime configuration)

Conventions for the `data/` directory. Read the
[root `AGENTS.md`](../AGENTS.md) first — the per-package discipline and
invariants apply here too.

## What lives here

**Tracked config (committed):**

- `assignments.yaml` — assignment registry
- `grading_config.yaml` — grading configuration
- `settings.yaml` — runtime settings
- `criteria/*.yaml` — rubric criteria
- `scoring/*.yaml` — scoring configuration
- `cohort_norms/` — cohort normalization config

**Gitignored runtime state (never commit):**

- `submissions/` — student submissions
- `plagiarism/` — plagiarism detection cache
- `copilot/` — copilot audit log
- `materials/` — assignment materials (keys, PDFs, input data)

## Rules

- Treat the tracked config files as the source of truth for whatever loads
  them (`criteria-loader.ts`, `grading-config.ts`, the executor, etc.).
- **Never commit** anything under the gitignored runtime-state directories.
- Structural changes to `scoring/*.yaml` can affect the byte-exact golden
  prompt contract — see the root / frontend `AGENTS.md` invariants.
