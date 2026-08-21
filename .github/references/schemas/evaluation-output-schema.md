# Evaluation Output Schema

> **Status**: v2 — Structured nested format replacing the legacy flat key-value
> export. Supports both YAML and JSON serialization.

## Overview

The evaluation output is the structured data produced when a grader completes
a review. It contains:

- **Student metadata** — ID, assignment, reviewer, date
- **Dimension scores** — Numeric scores for each grading dimension
- **Category feedback** — Checked items, comments, deductions, and notes per category
- **Computed results** — Percentage, grade, label

The v2 format uses **nested objects** instead of flat scoped keys. This
eliminates fragile text-matching and makes the output self-describing.

## File

The evaluation is not written to a `data/evaluations/` directory (that v1-era
layout is gone). Both serializations are produced on demand:

- **YAML/JSON**: `generateEvaluation` (`frontend/src/lib/services/text-generator.ts`)
  builds the `Evaluation` object; `exportSession` / `exportAsYaml`
  (`frontend/src/lib/services/session-persistence.ts`) serialize it for
  download.
- **JSON**: identical structure — `exportSession` with `format: "json"`.
- **Server-side per-submission export**: `frontend/src/lib/server/export-service.ts`
  emits a flattened `GradingExport` (student_id / assignment / scores / rubric /
  notes) from a `SubmissionRecord` + grading state (`GET /api/submissions/[id]/export`).

## Structure

```yaml
student_id: <string>
assignment: <string>           # e.g., "atom_interaction"
reviewer: <string>
date: <YYYY-MM-DD>

scores:
  code_quality_design: <number>
  code_execution_results: <number>
  assignment_requirements: <number>
  scientific_programming: <number>
  creativity: <number>

feedback:
  <category_key>:
    checked:                   # List of checked sub-point texts
      - <string>
    comments:                  # Map of sub-point text → grader comment
      <sub_point_text>: <string>
    deductions:                # Map of sub-point text → point deduction
      <sub_point_text>: <number>
    notes: <string>            # Free-text additional notes

result:
  percentage: <number>
  grade: <number>              # German grade (1.0–5.0)
  label: <string>              # US equivalent (A+, A, A-, ...)
```

## Field Definitions

### Top Level

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `student_id` | string | ✅ | Student identifier (e.g., `2026SS_03`) |
| `assignment` | string | ✅ | Assignment key from `assignments.yaml` |
| `reviewer` | string | ✅ | Grader name or identifier |
| `date` | string | ✅ | ISO date of the review |
| `scores` | object | ✅ | One entry per grading dimension |
| `feedback` | object | ✅ | One entry per rubric category |
| `result` | object | ✅ | Computed grade information |

### Scores

Keys match the `key` field from `grading_config.yaml` dimensions.

| Key | Type | Range | Description |
|-----|------|-------|-------------|
| `code_quality_design` | number | 0.0–6.0 | Code Quality & Design score |
| `code_execution_results` | number | 0.0–6.0 | Code Execution & Results score |
| `assignment_requirements` | number | 0.0–6.0 | Assignment Requirements score |
| `scientific_programming` | number | 0.0–6.0 | Scientific Programming score |
| `creativity` | number | 0.0–4.0 | Creativity score |

### Feedback (per category)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `checked` | string[] | ✅ | `[]` | Texts of checked sub-points |
| `comments` | object | ✅ | `{}` | Sub-point text → grader comment (only for sub-points with `comment: true`) |
| `deductions` | object | ✅ | `{}` | Sub-point text → numeric deduction (only for sub-points with `point_deduction: true`) |
| `notes` | string | ✅ | `""` | Free-text additional notes |

### Result

| Field | Type | Description |
|-------|------|-------------|
| `percentage` | number | Weighted percentage (0–100) |
| `grade` | number | German grade from `grade_boundaries` |
| `label` | string | US letter-grade label |

## Full Example

```yaml
student_id: "2026SS_03"
assignment: atom_interaction
reviewer: Cetin
date: "2026-07-15"

scores:
  code_quality_design: 4.5
  code_execution_results: 5.5
  assignment_requirements: 5.0
  scientific_programming: 4.5
  creativity: 2.0

feedback:
  code_formatting:
    checked:
      - "concise, clean and clearly written code"
      - "commenting - appropriate amount provided (i.e., not excessive or insufficient)"
      - "imports - libraries were alphabetized"
      - "blank lines - missing the required two blank lines after imports and/or around user-defined functions (PEP8)"
    comments: {}
    deductions: {}
    notes: "The code is generally well-written. PEP8 blank line issues around functions."
  coding_concept:
    checked: []
    comments: {}
    deductions: {}
    notes: "Good use of Pandas vectorized operations."
  academic_scholarship:
    checked:
      - "citing - source of information and knowledge"
      - "citing - missing references for knowledge (e.g., datasets, equations, libraries)"
    comments: {}
    deductions: {}
    notes: ""
  pandas:
    checked:
      - "Effective use of Pandas and its built-in functions"
    comments: {}
    deductions: {}
    notes: "Good use of dropna and drop_duplicates for data cleaning."

result:
  percentage: 82.0
  grade: 2.0
  label: B+
```

## JSON Serialization

When serialized as JSON, the structure is identical — only the syntax changes:

```json
{
  "student_id": "2026SS_03",
  "assignment": "atom_interaction",
  "reviewer": "Cetin",
  "date": "2026-07-15",
  "scores": {
    "code_quality_design": 4.5,
    "code_execution_results": 5.5,
    "assignment_requirements": 5.0,
    "scientific_programming": 4.5,
    "creativity": 2.0
  },
  "feedback": {
    "code_formatting": {
      "checked": ["concise, clean and clearly written code"],
      "comments": {},
      "deductions": {},
      "notes": "The code is generally well-written."
    }
  },
  "result": {
    "percentage": 82.0,
    "grade": 2.0,
    "label": "B+"
  }
}
```

## Migration from Legacy Flat Format (v1)

| v1 Flat Key | v2 Nested Path | Notes |
|-------------|---------------|-------|
| `"codeFormatting-positive-...-concise, clean..."` → `"checked"` | `feedback.code_formatting.checked[]` | No text-matching needed |
| `"codeFormatting-textarea"` → `"notes text"` | `feedback.code_formatting.notes` | Explicit field |
| `"codequality-grading"` → `"4.5"` | `scores.code_quality_design` | snake_case key |
| `"name"` → `"2026SS_03"` | `student_id` | Renamed for clarity |
| *(missing)* | `assignment`, `reviewer`, `date` | New metadata fields |
| *(missing)* | `result` | Computed grade info |

### Why the v1 Flat Format Was Problematic

1. **Fragile text-matching**: Keys like `codeFormatting-positive-Formatting is done well, which includes-concise, clean...` broke if the criteria text changed even slightly
2. **No structure**: Everything was a flat key-value pair with no nesting
3. **Inconsistent key conventions**: camelCase category keys, camelCase-grading dimension keys, snake_case YAML keys
4. **Missing metadata**: No assignment, reviewer, or date information
5. **Implicit semantics**: Whether a key was a checkbox, textarea, or score had to be inferred from its format

## Conversion Pipeline

```
Grading Session ──app──► YAML Output ──serialize──► JSON Output
                              │
                              └──► Evaluation MD (human-readable)
```

The app produces the YAML output as the canonical format. JSON is derived
via serialization. The evaluation Markdown file is a separate human-readable
rendering of the same data (see `evaluation-md-schema.md`).

## Example

```json
{
  "codeFormatting-positive-Formatting is done well, which includes-concise, clean and clearly written code": "checked",
  "codeFormatting-positive-Formatting is done well, which includes-commenting - appropriate amount provided (i.e., not excessive or insufficient)": "checked",
  "codeFormatting-positive-Formatting is done well, which includes-imports - libraries were alphabetized": "checked",
  "codeFormatting-negative-The following formatting issues were present in your code-blank lines - missing the required two blank lines after imports and/or around user-defined functions (PEP8)": "checked",
  "codeFormatting-textarea": "The code is generally well-written. PEP8 blank line issues around functions.",
  "codingConcept-textarea": "Good use of Pandas vectorized operations.",
  "academicScholarship-positive-Scholarship done well, which includes-citing - source of information and knowledge": "checked",
  "academicScholarship-negative-Scholarship done poorly, which includes the following-citing - missing references for knowledge (e.g., datasets, equations, libraries)": "checked",
  "Pandas-positive-Overall Pandas feedback-Effective use of Pandas and its built-in functions": "checked",
  "Pandas-textarea": "Good use of dropna and drop_duplicates for data cleaning.",
  "codequality-grading": "4.5",
  "codeexecution-grading": "5.5",
  "assignmentrequirements-grading": "5.0",
  "scientific-grading": "4.5",
  "creativity-grading": "2.0",
  "name": "2026SS_03"
}
```

## Internal Session Format (v1.5 prototype, historical)

Within the legacy Svelte Review App, the session was stored differently:

```typescript
// Scoped key format for checked items (uses :: separator, no mainPoint)
"categoryKey::sentiment::subPointText"

// Example:
"codeFormatting::positive::concise, clean and clearly written code"
```

The Svelte app uses `::` as separator and does not include `mainPoint` in the
scoped key. This is different from the JSON export format which uses `-` as
separator and includes `mainPoint`.

## Conversion Pipeline (v1, historical)

```
Evaluation MD ──md_to_json.py──► JSON Export ──web app──► Grade Calculation
                                    │
                                    └──► grading_summary.md
```

The v1 converter scripts **no longer exist** — `md_to_json.py`,
`validate_json.py`, the `grading_summary.md` aggregation, and the legacy
`scipro_assignments_grading/` web app were removed with the 2026-08-20
student-data strip. The current app never parses Markdown or flat JSON
back into grades: review data is kept structured in the session, exported
via `exportSession` (`frontend/src/lib/services/session-persistence.ts`),
and imported back as YAML/JSON only (`parseImport`).

## Related Files

- `frontend/src/lib/services/session-persistence.ts` — session serialization,
  YAML/MD/JSON export (`exportSession`), YAML/JSON import (`parseImport`)
- `frontend/src/lib/services/text-generator.ts` — `generateEvaluation` /
  `generateEvaluationMarkdown` (the Evaluation object + MD rendering)
- `frontend/src/lib/services/db.ts` — IndexedDB persistence
  (`exportAll` / `importAll` / `listReviews`), `DbExport` bulk format
- `frontend/src/lib/server/export-service.ts` — server-side per-submission
  grading export (`GradingExport`)