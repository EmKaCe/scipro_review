# Evaluation Markdown Schema

> **Status**: v2 — Human-readable evaluation format with consistent
> `snake_case` frontmatter keys and unified category layout.

## File

Not a file in a `data/evaluations/` directory (the v1-era layout is gone): the
Markdown evaluation is generated on demand by `generateEvaluationMarkdown`
(`frontend/src/lib/services/text-generator.ts`) and exported as a download via
`exportSession` / `exportAsMarkdown` (`frontend/src/lib/services/session-persistence.ts`).

## Overview

Each student evaluation can be rendered as a Markdown document with YAML
frontmatter and structured checkbox sections. This is the human-readable
format that graders write and read. It is a rendering of the same data stored
in the structured evaluation output (see `evaluation-output-schema.md`).

Round-trip note: only the **YAML/JSON** exports are parsed back into a review
session (`parseImport` in `session-persistence.ts`). The Markdown format is
render-only; the app does not parse MD back into structured data.

## Structure

```markdown
---
student_id: <string>
assignment: <string>
date: <ISO timestamp>
scores:
    code_quality_design: <number>
    code_execution_results: <number>
    assignment_requirements: <number>
    scientific_programming: <number>
    creativity: <number>
result:
    percentage: <number>
    grade: <number>
    label: <string>
---

## Positive Observations
<!-- sentiment:positive -->
### <Category Title>
**<Main Point Text>**
- [x] <checked sub-point text>
  > <grader comment>        (when the sub-point has comment: true)
  (-1.5 points)             (when the sub-point has point_deduction: true)
<!-- /sentiment:positive -->

## General Observations
<!-- sentiment:neutral -->
...

## Areas for Improvement
<!-- sentiment:negative -->
...

## Additional Notes
**<Category Title>**: <free-text notes>
```

## YAML Frontmatter

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `student_id` | string | ✅ | Student identifier (e.g., `2026SS_03`) |
| `assignment` | string | ✅ | Assignment key from `assignments.yaml` |
| `date` | string | ✅ | ISO timestamp of the review's last update |
| `scores` | object | ✅ | One entry per grading dimension |
| `result` | object | ✅ | Computed grade information |

Note: the YAML/JSON evaluation export adds a `reviewer` field; the Markdown
frontmatter emitted by `generateMarkdownFrontmatter` does not include it.

### Scores Keys

| Key | Range | Description |
|-----|-------|-------------|
| `code_quality_design` | 0.0–6.0 | Code Quality & Design |
| `code_execution_results` | 0.0–6.0 | Code Execution & Results |
| `assignment_requirements` | 0.0–6.0 | Assignment Requirements |
| `scientific_programming` | 0.0–6.0 | Scientific Programming |
| `creativity` | 0.0–4.0 | Creativity |

### Result Keys

| Key | Type | Description |
|-----|------|-------------|
| `percentage` | number | Weighted percentage (0–100) |
| `grade` | number | German grade (1.0–5.0) |
| `label` | string | US letter-grade label |

## Section Layout

### Sentiment Sections

The body is grouped **by sentiment first**, then by category, then by main
point (`generateMarkdownBody` in `text-generator.ts`). Each sentiment section
carries `<!-- sentiment:... -->` / `<!-- /sentiment:... -->` comment markers;
empty sentiments are omitted entirely.

| Sentiment | Heading |
|-----------|---------|
| positive | `## Positive Observations` |
| neutral | `## General Observations` |
| negative | `## Areas for Improvement` |

### Category Format

```markdown
## Positive Observations
<!-- sentiment:positive -->
### Code Formatting
**Formatting is done well, which includes**
- [x] concise, clean and clearly written code
- [x] commenting - appropriate amount provided (i.e., not excessive or insufficient)
<!-- /sentiment:positive -->
```

### Checkbox Format

- **Only checked items are emitted**: `- [x] <text>` (lowercase `x`). An
  unchecked sub-point never appears in the export.
- **Comment**: the grader comment follows the item as an indented blockquote:
  ```
  - [x] execution - the code does not run because of the following problem(s):
    > Missing import for pandas. Cell 3 raises NameError.
  ```
- **Point deduction**: the amount follows in parentheses:
  ```
  - [x] Your solution was very similar to another student's solution
    (-1.5 points)
  ```

### Indentation

- Sentiment headings: `##` (level 2)
- Category headings: `###` (level 3), per sentiment section
- Main points: `**text**` (bold, own line)
- Sub-points: `- [x] text` (list item at the top level of the section)
- Comments/deductions: two-space indented lines directly under the item

### Additional Notes

Non-empty per-category notes are collected into a trailing section:

```markdown
## Additional Notes
**Code Formatting**: The code is generally well-written. Minor PEP8 issues.
```

### Special Cases

1. **Empty main point**: When `main_point` is `""`, sub-points appear directly
   under the category heading without a bold heading.
2. **Empty sentiment**: sections with no checked items are skipped (no empty
   `## Areas for Improvement` block when nothing was checked there).
3. **No title heading**: the document starts with the frontmatter fence; there
   is no `# Evaluation` title line.

## Full Example

```markdown
---
student_id: "2026SS_03"
assignment: soil_contamination
date: "2026-07-15T14:30:00.000Z"
scores:
    code_quality_design: 5.5
    code_execution_results: 4.5
    assignment_requirements: 5.0
    scientific_programming: 4.5
    creativity: 2.0
result:
    percentage: 82.0
    grade: 2.0
    label: B+
---

## Positive Observations
<!-- sentiment:positive -->
### Code Formatting
**Formatting is done well, which includes**
- [x] concise, clean and clearly written code
- [x] commenting - appropriate amount provided (i.e., not excessive or insufficient)
### Pandas
**Overall Pandas feedback**
- [x] Effective use of Pandas and its built-in functions
<!-- /sentiment:positive -->

## Areas for Improvement
<!-- sentiment:negative -->
### Code Formatting
**The following formatting issues were present in your code**
- [x] blank lines - missing the required two blank lines after imports and/or around user-defined functions (PEP8)
### Academic Scholarship
**Scholarship done poorly, which includes the following**
- [x] citing - missing references for knowledge (e.g., datasets, equations, libraries)
<!-- /sentiment:negative -->

## Additional Notes
**Code Formatting**: The code is generally well-written. Minor PEP8 blank line issues around functions.
**Coding Concept**: Good use of Pandas vectorized operations.
```

## Relationship to Evaluation Output

The evaluation MD file and the evaluation output YAML/JSON contain the same
data in different formats:

```
Evaluation Output (YAML/JSON)  ←──app──►  Evaluation MD
     (structured)                           (human-readable)
```

The app renders the structured output as MD for display
(`generateEvaluationMarkdown`), and imports YAML/JSON exports back into a
review session (`parseImport` in `session-persistence.ts`). The structured
YAML/JSON is the canonical format; the MD is a rendering.

## Conversion to JSON

There is no separate MD-to-JSON converter anymore (the v1 `md_to_json.py`
script was removed with the 2026-08-20 student-data strip): YAML and JSON are
both serialized from the same `Evaluation` object (`exportSession` with
`format: "yaml"` / `"json"` in `frontend/src/lib/services/session-persistence.ts`).
The output format is documented in
[evaluation-output-schema.md](evaluation-output-schema.md).

## Example (v1 format, historical)

For reference, the v1 Markdown format (flat `grading_table`, `## General
Feedback` sections, trailing-colon headings) that `md_to_json.py` parsed:

```markdown
# Evaluation

## General Feedback

### Code Formatting:
#### Positive:
- Formatting is done well, which includes:
    - [x] concise, clean and clearly written code
    - [x] commenting - appropriate amount provided (i.e., not excessive or insufficient)
    - [x] imports - libraries were alphabetized
#### Negative:
- The following formatting issues were present in your code:
    - [x] blank lines - missing the required two blank lines after imports and/or around user-defined functions (PEP8)
#### Additional Notes:
- The code is generally well-written. PEP8 blank line issues around functions.
```