---
name: criteria-authoring
description: "Use when drafting or revising assignment criteria (rubric) YAML for the SciPro grading harness — including the 'Draft with AI' criteria endpoint, the Mastra/LLM copilot, or any human author adding rubric categories. Enforces QUANTIFIABLE, observable sub-points and verbatim worksheet-option wording."
argument-hint: "<criteria-drafting-task>"
---

# Criteria Authoring (quantifiable rubric rules)

Rules for authoring the per-assignment rubric YAML (`data/criteria/<assignment>.yaml`,
the `categories:` map with `positive`/`neutral`/`negative` main-point groups and
their `sub_points`) so that every checkbox the grader ticks is actually checkable
against a student notebook. These rules bind the **LLM draft endpoint**
(`POST /api/assignments/[id]/criteria/draft`) and any automated or human author.

## The five non-negotiable rules

### 1. Every sub-point must be checkable by observable evidence

A sub-point is only acceptable if a grader (or the automated pre-evaluation
harness) can decide it from **observable notebook evidence** — a specific import,
a cell marker, an output pattern — **or** from a single bounded LLM pass. If the
text cannot be confirmed or refuted by looking at the cells, rephrase or drop it.

- **Good (observable):** `Functions: good use of Pandas functions.` →
  verifiable by scanning imported Pandas APIs used in code cells.
- **Good (bounded LLM pass):** a single-pass judgment scoped to one concrete
  claim (e.g. one specific plot property), never a sprawling qualitative verdict.
- **Bad (un-checkable):** `Demonstrates a thoughtful approach.` — no cell marker,
  no output, no bounded claim maps to this.

### 2. Sub-point wording MUST match the worksheet option texts VERBATIM

Worksheet checkbox texts must equal the rubric sub-point `text` **byte for byte —
no synonyms, no abbreviations, no rephrasing.** The worksheet validation is
exact-text (`hasOption` only normalizes case/whitespace/trailing punctuation, not
wording) and typo-for-typo (e.g. `separatation`, `encode ideas`, `PEP8 guidelines- followed`
are matched verbatim). See `docs/directives/turn-based-preeval.md` (worksheet =
per-category edited markdown, checked items matched verbatim to rubric sub-points).

- When drafting a NEW category, write each `text` once and reuse that exact
  string everywhere the option appears. Never emit a paraphrase of your own text.

### 3. Actively rephrase VAGUE options

The legacy vanilla-JS JSON criteria failed precisely because its sub-points were
vague and un-checkable (rule 1 violations that no deterministic or LLM pass could
recover). When you encounter a vague option, **rephrase it into an observable form**
rather than copying it — a vague option is a defect, not a style choice.

- Vague → rephrased:
  - `shows good pandas knowledge` → `Functions: good use of Pandas functions.`
  - `handles data correctly` → `Delimiter: separator correctly specified in read_csv.`

### 4. One category per natural grouping

Each category must be a single coherent concern (e.g. `pandas`, `numpy`,
`code_formatting`). Do not pack unrelated concerns into one category, and do not
split one concern across several categories. Categories apply as a whole, so a
category should be decision-checkable as a unit.

### 5. No N/A escape hatch

There is **no N/A verdict** for a category. Every category must hold applicable,
checkable sub-points — never a generic "not applicable" option that lets the
grader (or the LLM) opt out of a hard category. If a category would only be
"usually N/A", it does not belong in the per-assignment rubric.

## Draft-route contract

The `POST /api/assignments/[id]/criteria/draft` endpoint:

- Grounds the draft on the assignment's OWN rubric file (the first
  `criteria_files` entry that is not the shared `data/criteria/general.yaml`).
- Emits ONLY the assignment-specific `categories` map — never general.yaml
  categories (those apply automatically and are not editable here).
- Validates the produced document through the criteria validation/load path
  (`validateCriteriaYaml`) so a model document that cannot load is rejected with
  a clear 400 before the teacher sees it.
- **NEVER writes.** The teacher reviews the draft in the criteria editor and saves
  explicitly through the existing `PUT /api/assignments/[id]/criteria` compile gate.

## Verification

A drafted criteria document is acceptable when:

- every sub-point is observable (rule 1) or a single bounded LLM pass;
- no `text` is a paraphrase of itself or a legacy vague option (rules 2–3);
- each category is one coherent grouping (rule 4);
- no "N/A" / opt-out option exists (rule 5);
- the document round-trips through `validateCriteriaYaml` (`pnpm vitest run
  src/tests/routes/criteria-draft-api.test.ts`).
