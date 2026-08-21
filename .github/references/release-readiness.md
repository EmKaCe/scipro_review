# Release Readiness Roadmap — Public Open-Source Launch

**Date:** 2026-08-20 · **Status:** decisions locked; ready to sequence sessions.
Companion to `.github/references/concepts.md` (architecture) and
`quality-statement.md` (quality posture). This is the **decision + sequencing
record** for taking `svelte-review-copilot` public, published as
**`scipro_review` / "SciPro Review"**.

---

## 0. Locked context & decisions (owner, 2026-08-20)

| # | Item | Decision |
|---|------|----------|
| D1 | `soil_contamination` | It was a **prototyping crutch**, not a permanent anchor. It **stays** as the reference/test fixture (golden prompt + grading gate are keyed to it) but is **framed as a documented example**, never "the assignment". |
| D2 | LLM/embeddings provider | **KI Connect (`kiconnect.nrw`, H-BRS/NRW)** stays the default, but the goal is **full OpenAI-compatible swap** (e.g. openrouter — newer/cheaper models). Provider-agnostic config is intended; the swap must be *validated good*, not just compatible. |
| D3 | Institution branding | **H-BRS may be named** openly; keep open-source friendly. Personal/tribal content gets reviewed. |
| D4 | Hosting / executor | **By-design localhost-only.** External binding is an **accepted, documented security risk — NOT fixed by sandboxing.** Deliverable = a docs warning, not hardening. |
| D5 | Licensing | **AGPL-3.0** (in repo). Non-profit/open source → no fees; redistributed docstrings need **attribution notices only**. |
| D6 | **Git history (B1)** | **Do NOT rewrite history.** Develop/verify in this private repo; at release, **create a NEW public repo** with clean/fresh history + secrets/releases/CI-CD set correctly; delete the private repo afterwards. Simple, safe, no archaeology. |
| D7 | First-run onboarding (T6) | **Guided checklist/onboarding page first** (cheaper, fast); full in-app wizard deferred. |
| D8 | User guide (T7) | **Both, doc-first:** standalone teacher-facing guide first, in-app help panel later. |
| D9 | CI scope | **Lean CI:** lib + lint + `check` + vitest + **synthetic grading gate** (+ executor tests). **No Playwright e2e in CI** (cost), e2e stays local. |
| D10 | Naming | **`scipro_review` / "SciPro Review"**. |

---

## 1. Confirmed state (grounded 2026-08-20)

- License AGPL-3.0 present. Real student data removed **forward** (blocker B1 strategy in D6).
- `pnpm check` 0/0, full vitest green, synthetic grading gate green, byte-exact golden prompt fixture.
- Docs index reproducible from pinned PyPI docstrings — **38,380 chunks / 10 libs**, published + consumer-fetch verified.
- CI (`ci.yml`), `release.yml`, `deploy.yml` exist.
- Working tree clean: `.env`/`frontend/.env` gitignored; no live key in `settings.yaml`.

---

## 2. BLOCKERS — resolve before publishing anything public

| ID | Item | Why it blocks | Effort | Plan |
|----|------|----------------|--------|------|
| **B1** | **Student data still in this repo's git history** | Removal (`13a3817`) was a forward delete, so real grades + cohort norms remain in history. | — | **Resolved by D6:** new public repo with fresh history at release; this private repo never published. No filter-repo needed. |
| **B2** | History secret audit | Any key ever committed would carry into history. | Fold into B1 | Before copying to the public repo, verify the **current tree** is free of secrets (B2a) and that `git log` history isn't being carried over (it won't, per D6). |
| **B3** | CI completeness | `ci.yml` runs only `prebuild + lint + check` — no tests → public PRs can merge red. | Low | Add vitest + grading gate + executor tests (D9: lean, no e2e). |
| **B4** | Provider/config story **+ tested swap** | External users can't reach `kiconnect.nrw`; LLM + embeddings must point at any OpenAI-compatible endpoint; openrouter swap verified. | Low–Med | `.env.example`, baseURL/key/model docs, openrouter validation. |

---

## 3. Tier 1 — do-soon, low-decision (safe to execute)

| ID | Item | Notes |
|----|------|-------|
| T1 | **Third-party notices** | `THIRD_PARTY_NOTICES.md` (+ `LICENSES/`): BSD notices for numpy/pandas/scipy/sklearn/matplotlib docstrings, PSF for stdlib/builtins; provenance note in the docstrings build. |
| T2 | **CI additions** | vitest + synthetic grading gate + executor tests into `ci.yml` (D9: lean, no e2e). **Post-implementation caveat (2026-08-20, RESOLVED 2026-08-21):** every step was proven locally, but the workflow had **never run on a real GitHub Actions runner**. The smoke run (5 runs on the private repo, `ci-smoke` branch, `workflow_dispatch` added for manual triggers) caught and fixed: (1) executor `DATA_DIR` defaulted to `/app/data` (Docker-only) → runner-temp path; (2) 108-file prettier drift — the tree was never lint-clean because `pnpm lint` was not in the local recipe → one-time normalization + eslint gate enabled by fixing 30 pre-existing errors; (3) machine-specific `/root/projects/...` test paths (45 EACCES in CI) → portable `REPO_ROOT` resolution. Final run `32497912574` (ci-smoke @ `b9b43ad`): **check ✅ + executor-tests ✅**. CI is proven for public PRs. |
| T3 | **`.env.example` + provider docs** | baseURL/key/model for LLM + embeddings; settings-UI-vs-env split; openrouter as a first-class documented target. |
| T4 | **Docs package** | README quickstart; honest feature/limitation section (disclose weak paraphrase/embedding leg); CONTRIBUTING + CODE_OF_CONDUCT + issue/PR templates; two-build deployment explainer ("which one do you want and how"). |
| T5 | **Release mechanics** | Verify `release.yml` artifacts; fix `fetch-docs-index.mjs` to plain release download (public) instead of `gh` (private-only); set up the new public repo (D6) with correct secrets/release/CI-CD. **Assessment (2026-08-20):** `release.yml` currently produces a **notes-only GitHub Release with NO build artifacts** — `softprops/action-gh-release@v3` runs with `generate_release_notes: true` and `fail_on_unmatched_files: true` but **no `files:` input and no build step**, so a pushed `v*` tag creates a release with auto-generated notes and zero attached binaries. It only gates tag-vs-`package.json` version. **Artifact (bundle) publishing is deferred to cutover (N3)** — the fresh public-repo bootstrap sets up correct release/CI-CD that actually attaches built artifacts. |

> **T5 note (2026-08-20, UPDATED 2026-08-21):** ~~no rename done — this is a recorded dependency for cutover~~ → **rename-complete.** `deploy.yml` itself contains **no hardcoded repo name** (it uses the GitHub Pages environment + `actions/upload-pages-artifact`), but the **static SPA build depends on the repo name via `frontend/svelte.config.js`**, which hardcoded `paths.base = "/svelte_review"` for the non-node build — the base path is now **`/scipro_review`** (plus all `/svelte_review` probe-path references in AGENTS/CONTRIBUTING/developer-guide and the test comments updated) and verified end-to-end: `pnpm build:student` emits `base` = `/scipro_review` in the built chunks, zero `svelte_review` strings in `build/` output (Wave 1, commit `0d42a8f`). Additionally, `docs-index.yml` (ref only — separate from `release.yml`) hardcoded `EmKaCe/svelte_review`; both hardcoded owners/repos are now reconciled to **`EmKaCe/scipro_review`** (`docs-index.yml`, `fetch-docs-index.mjs` default, README, CONTRIBUTING, in-app clone/about links) (same Wave 1 commit). `fetch-docs-index.mjs` was extended (T5) with a `--public` plain-HTTPS download path (redirect-following `fetch`, sha256-verified) so public-repo consumers won't need `gh`; the `gh` path stays the default for the private repo. **N2 (2026-08-21):** versioning convention locked — semver from first public tag **`v2.5.0`** (continuity from the private 2.3.x lineage, NOT a reset); `CHANGELOG.md` (repo root) + `.github/references/versioning.md` created.

> **Cutover status (2026-08-21, Session D):** private checkpoint pushed — `phase-3b` fast-forwarded to `main` (private, `8e8a367`), CI green on real runner. Old April 2026 PyScript prototype renamed to **`EmKaCe/scipro-review-pyscript-prototype`** (private, untouched). Fresh public **`EmKaCe/scipro_review`** created with **one root commit** (`117de0e`, v2.5.0 tree, fresh history per D6 — no private history, no `.hermes`, no runtime data), Pages enabled (workflow build type). `docs-index` release published on the public repo (38,380 chunks / 10 libs, json+bin+manifest). **COMPLETED:** tag `v2.5.0` pushed → `release.yml` created the release; folded CHANGELOG appended to the body; student-static + teacher-node build tarballs attached. Pages verified at `/scipro_review/` (HTTP 200, correct base assets; deep routes serve the SPA 404.html fallback shell — status 404 is cosmetic on GH Pages). Remaining (user): fresh-machine smoke test, then **delete the private repo manually** (`gh repo delete` unsupported for fine-grained PAT; browser path). 

---

## 4. Tier 2 — scoped, sign-off given

| ID | Item | Scope (locked) |
|----|------|----------------|
| T6 | **First-run onboarding** | **Guided checklist/onboarding page** first (create/import assignment → wire criteria + scoring + provider → fetch docs index → first pre-eval). Full wizard deferred. |
| T7 | **User guide (teacher/new-user)** | **Doc-first** standalone guide (calibrate, pre-evaluate, review copilot worksheet, export grades), **in-app help panel later**. |
| T8 | **Two-build deployment explainer** | Folded into T4 docs; "which build" guidance. |

---

## 5. Tier 3 — backlog

| ID | Item | Origin |
|----|------|--------|
| T9 | **B13 injection hardening** | Existing plan — student notebook content flows **unsanitized** into pre-eval/tool-result prompt paths. Quality + security. **Status (2026-08-21):** core screening was already landed (`8b9c8af`, pre-eval + get-submission-context); Session C closed the remaining gap — plagiarism semantic pass screens both notebooks before the LLM call (skip pair only on positive verdict, fail-open, commit `5741721`). **Executor decision (user, 2026-08-21, REVISED by C2):** no Python-side screening — autofix output is a code patch (not a grade) sanity-checked with `ast.parse`; the analyze path is optional preprocessing. **C2 revision (implemented 2026-08-21, `8c68ecb`):** the autofix's verified clean re-run (`fixedCells`) now enters the grading prompt (consequential-error grading) — the patched content is LLM-generated from student content, so it is screened at the frontend boundary before reaching any prompt (reuse `screenNotebookCells`; injection → mask + `needs_review`). The pre-eval autofix block flags the root error as a negative and judges downstream cells on the fixed run (disposition-aware + wrong-fix guard); `get-submission-context` returns the verified re-run as screened, bounded previews so the teacher can discuss the fix with the copilot. `get-executor-logs` verified NOT to leak cell source. |
| T10 | **Provider-swap results validation (openrouter)** | Confirm "good or better", not merely compatible (D2). **Status (2026-08-21):** validated. Exposed + fixed a provider-swap gap — `PHASE_2_MODEL` was hardcoded (`openai-gpt-oss-120b`) and overrode settings/env at 4 call sites; now env-overridable with the default unchanged (commit `9af266b`). Same-model A/B (qwen3-30b-a3b-instruct-2507 on both providers, same day, same code): **KI Connect** — 2026SS_00 {4, 3.5, 5, 4, 3} needs_review / 2026SS_04 {4, 5, 5, 4.5, 2.5} needs_review. **OpenRouter** — 2026SS_00 {3.5, 2.5, 3.5, 4, 2.5} needs_review / 2026SS_04 {4, 5, 6, 4.5, 2.5} review_optional. Verdict: **compatible, not yet proven good-or-better on the scoring phases** — 2026SS_00 scored lower on openrouter (3 dims down, 1 equal, 1 same); 2026SS_04 equal or better. Sample 2, rubric-selection validation warnings on both providers (NumPy/Jupyter categories) — same-class behavior. OpenRouter needs a stronger model for the quality-critical Phase 2a before it can be a documented first-class target; cheap-model swap is acceptable for screening/Phase 1/Phase 3. |
| T11 | **Generalization beyond `soil_contamination`** | Lift soil out of the default identity toward a proper demo/example as authoring docs mature. Non-blocking. |

---

## 6. Lighter items

| ID | Item | Status |
|----|------|--------|
| N1 | Naming | **Locked: `scipro_review` / "SciPro Review"** (D10). |
| N2 | Versioning + CHANGELOG | **Decided (2026-08-21):** semver from first public tag **`v2.5.0`** (continuity from the private 2.3.x lineage, NOT a reset); release notes auto-generated by `release.yml`; `CHANGELOG.md` (repo root) + `.github/references/versioning.md` landed in Wave 1. Apply at cutover: bump `package.json` to `2.5.0`, fold `[Unreleased]`, tag `v2.5.0`. |
| N3 | New-repo bootstrap (B1/D6) | Part of T5 — set secrets, releases, CI/CD on the fresh public repo. |

---

## 7. Sequencing (suggested sessions)

1. **Session A — Tier 1 (T1–T5):** licensing notices, CI additions (lean), `.env.example` + provider docs, docs package, release mechanics + new-repo bootstrap. Covers all four blockers' code/docs side.
2. **Session B — Tier 2 (T6–T8):** build the onboarding checklist page; write the teacher guide; two-build explainer.
3. **Session C — Tier 3 (T9–T11):** injection hardening; openrouter validation; generalization as it matures. **Completed 2026-08-21** (16 commits ahead of origin, tree clean).
4. **Session C2 — Consequential-error grading (2026-08-21, BEFORE Session D):** autofix-informed pre-eval — the verified clean re-run (`fixedCells`) enters the grading prompt so downstream cells aren't cascade-penalized by a root error; disposition-aware (teacher's accepted/ignored per-cell fixes feed the prompt); patched content screened at the frontend boundary (revises the T9 executor decision); `get-submission-context` returns the fixed run so the teacher can discuss fixes with the copilot. Brief: `.hermes/plans/2026-08-21-sessionC2-kickoff.md`.
5. **Session D — cutover (D6/D7/D10, N2):** create the public `scipro_review` repo with clean history, correct secrets/CI-CD, tagged first release; then delete the private repo. **Adjusted: runs AFTER C2** so the public repo ships with consequential-error grading.
