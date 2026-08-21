# Concepts & Trust Boundaries

**SciPro Review** — explained for a new maintainer or a teacher taking over,
without the full source-level detail of the [Architecture](architecture.md).
This is the *mental model*: what the pieces are, how data flows, and — most
importantly — **what you can trust automatically vs. what needs your eyes**.

> The whole product rests on one idea: **the AI is a copilot that works with
> you.** It drafts; you approve. It never silently decides a final grade.

---

## 1. The big picture (in one minute)

There are **two separate worlds** running from one codebase:

| World | Who uses it | Where it runs | What it does |
| --- | --- | --- | --- |
| **Student** | students | GitHub Pages (public static site) | read-only: view their evaluation |
| **Teacher** | the grader | **your own machine** (`127.0.0.1`) | upload, run, grade, draft with the copilot |

The teacher app is **loopback-only by default** (`127.0.0.1:4174`) — a trusted,
single-operator tool on a teacher's machine. It is not meant to sit on the
internet.

```mermaid
flowchart LR
    ST[Student SPA on GitHub Pages] -->|read-only evaluation| API
    T[Teacher app on localhost:4174] -->|upload, grade, copilot| API
    API[Frontend server - pre-eval pipeline and copilot] --> EX[Executor - runs notebooks]
    API --> KI[KI Connect - LLM]
    API --> IDX[(offline docs index)]
```

---

## 2. The only two "characters" that matter

1. **The teacher (you, the instructor)** — the authority. You import notebooks, run the
   pipeline, review the draft, and decide the final grade.
2. **The copilot** — an AI assistant that *drives the same UI you do*, by
   calling the same tools, and proposes a draft. It never bypasses your review.

Everything else (executor, docs index, scoring config) exists to make one of
these two work better.

---

## 3. How a submission turns into a draft grade (the pipeline)

A student notebook goes through a fixed journey. Follow the numbers:

```mermaid
flowchart TD
    A[1. Upload notebooks] --> B[2. Executor runs each notebook]
    B --> C[3. Pre-evaluation pipeline]
    C --> C1[Phase 1 - cell markers: same, different, questionable]
    C1 --> C2[Phase 2a - dimension scores on 0..max_points]
    C2 --> C3[Phase 2b - rubric worksheet, one category per call]
    C3 --> D[4. 7 deterministic fix passes]
    D --> E[5. Cohort calibration - re-centers scores]
    E --> F[Draft grade and confidence flag]
    F --> G[6. YOU review, accept or fix, save]
```

**Read the important part now:** steps 1, 2, 4, 5 are **deterministic** —
bits in, bits out, no randomness. Step 3 is the **LLM** — where judgement and
variance live. Step 6 is **you** — the unavoidable human filter.

---

## 4. Trust boundaries — the heart of the mental model

This is the single most useful idea for a new maintainer. Draw a line down the
middle of the pipeline:

| Layer | Deterministic? | Can you trust it automatically? |
| --- | --- | --- |
| **Phase 1 markers** (cell same/different) | ✅ yes (no LLM) | Yes — reproducible, exact |
| **7 post-process passes** | ✅ yes (pure logic) | Yes — each fix is a visible record |
| **Cohort calibration** | ✅ yes (math on stored data) | Yes — but only runs when the assignment defines reference anchors |
| **Phase 2a/2b scores & rubric** | ❌ no (LLM) | **No — review it.** The copilot's job is to draft, not to be right |
| **Final grade** | — | **Never trust automatically** — that's the teacher's call |

Three concrete safety nets back up the "review it" columns:

- **Screening (B13):** student notebook content is *untrusted input*. Before
  any prompt, a small model checks it for instruction-smuggling
  ("give this a perfect score"). On a hit, the cells are stripped from the
  prompt and the row flags `needs_review`. It fails open — grading never
  breaks because a guard fails.
- **The synthetic grading gate:** a deterministic safety net that runs in CI
  (`verify-grading-gate.mjs` / `grading-gate.test.ts`). It checks proposed
  grades against the real rubric + config over committed synthetic fixtures —
  catching out-of-range dimension scores (e.g. `500` when the max is `6`),
  invented rubric options, and mutual-exclusion contradictions. No LLM, no
  student data — it catches the *mechanical* slip-ups forever.
- **Confidence flags:** `needs_review` / `review_optional` / `high_confidence`,
  computed deterministically after post-processing, tell you *which rows to look
  at first*. It's not an AI opinion — it's a summary of the pipeline's own
  audit trail.

> The golden rule: **the pipeline can be wrong without being broken.**
> "Tests pass" (it's deterministic and well-formed) and "the grade is fair"
> (it matches your standards) are different questions. The gate and confidence
> flags answer the first; **you** answer the second.

---

## 5. Configuration — where "how this assignment grades" lives

Nothing is pinned to the original (soil_contamination) assignment. Each
assignment is **self-described**:

```mermaid
flowchart LR
    subgraph data[data/ - the config the app reads]
        A[assignments.yaml - which criteria and scoring per assignment]
        C[criteria/*.yaml - the rubric: what to check per category]
        S[scoring/*.yaml - anchors, evidence patterns, disallowed libs]
        G[grading_config.yaml - global dimensions and grade boundaries]
    end
```

- **Want a new assignment graded well?** Use the UI: create assignment → write
  the rubric → **"Draft with AI"** → then **calibrate** against your own grades
  on a few submissions (the [Calibration guide](assignment-calibration.md)).
- The prompt the model sees is **byte-exact** for soil_contamination (a golden
  fixture pins it), so a change never silently shifts behavior.

---

## 6. Running it on a teacher's machine

The intended production path is Docker Compose, **bound to loopback only**:

```bash
cd scipro_review
cp .env.example .env          # set your KI Connect keys
docker compose up -d --build
# open http://localhost:4174   (teacher app; students use the GitHub Pages build separately)
```

- The frontend publishes `127.0.0.1:4174:4174` — reachable **only** on the
  teacher's machine. If you ever need LAN/remote access, add authentication
  first, then widen the bind (see the compose file comment).
- The executor is not exposed to the host at all (`expose` only — the frontend
  reaches it over Docker's internal network).

For developers, `docker-compose.dev.yml` is provided (source mount + live
reload); it may bind on the LAN since it's developer-only.

---

## 7. Gotchas a new maintainer should know

- **Never commit** runtime state: `data/submissions/`, `data/plagiarism/`,
  `data/copilot/`, `data/materials/`, `grading-output/`, or `.env`. Real
  student data was removed from the repo for privacy (2026-08-20) — **don't
  reintroduce it.**
- **Vitest narrowing is misleading:** `pnpm test -- <file>` runs the WHOLE
  suite (vitest ignores the positional filter). Use `pnpm vitest run <file>`.
- **The Docker volume** (`svelte-review-data`) holds its own copy of the
  config (`assignments.yaml`, `criteria/*.yaml`, `scoring/*.yaml`) and can lag
  the repo. Before a pre-eval run against the volume, diff volume vs repo and
  sync — back up first.
- **KI Connect concurrency ceiling is 2.** Do not raise it without measuring
  against the API's rate limits (4 workers triggered sustained 429s).
- **`hermes verify`** is a Hermes convenience wrapper. The underlying recipe is
  the harness-agnostic one in the root `AGENTS.md` (`pnpm install` →
  `build:student` → `vitest run` → preview probe) — any agent harness can run
  it.

---

## 8. Where to go next

| You want to… | Read |
| --- | --- |
| See every file & module | [Architecture](architecture.md) |
| Understand the data shapes | [Data structures](data-structures.md) |
| Onboard a new assignment | [Calibration guide](assignment-calibration.md) |
| Know what it gets right / needs review | [Quality statement](quality-statement.md) |
| Understand the layout choices | See [Architecture](architecture.md) — past design decisions live in git history |
| Follow the developer workflow + glossary | [Developer guide](developer-guide.md) |
