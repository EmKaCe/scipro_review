# Evaluation Markdown Schema

> **Status**: v2 — Human-readable evaluation format with consistent
> `snake_case` frontmatter keys and unified category layout.

## File

`data/evaluations/2026SS_03.md`

## Overview

Each student evaluation is stored as a Markdown file with YAML frontmatter
and structured checkbox sections. This is the human-readable format that
graders write and read. It is a rendering of the same data stored in the
structured evaluation output (see `evaluation-output-schema.md`).

## Structure

```markdown
---
student_id: <string>
assignment: <string>
reviewer: <string>
date: <YYYY-MM-DD>
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

# Evaluation — <student_id>

## <Category Title>
### Positive
- **<Main Point Text>**
    - [x] <checked sub-point text>
    - [ ] <unchecked sub-point text>
### Neutral
- **<Main Point Text>**
    - [ ] <sub-point text>
### Negative
- **<Main Point Text>**
    - [x] <checked sub-point text>
### Notes
> <free-text notes>

## <Next Category Title>
...
```

## YAML Frontmatter

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `student_id` | string | ✅ | Student identifier (e.g., `2026SS_03`) |
| `assignment` | string | ✅ | Assignment key from `assignments.yaml` |
| `reviewer` | string | ✅ | Grader name or identifier |
| `date` | string | ✅ | ISO date of the review |
| `scores` | object | ✅ | One entry per grading dimension |
| `result` | object | ✅ | Computed grade information |

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

### v2 Changes from v1

| v1 | v2 | Reason |
|----|-----|--------|
| `## General Feedback` / `## Assignment-Specific Feedback` | No section split | All categories are equal under `categories:` |
| `### Category Title:` (trailing colon) | `## Category Title` (no colon) | Cleaner Markdown |
| `#### Positive:` / `#### Negative:` | `### Positive` / `### Negative` | Less nesting |
| `- Main Point:` (trailing colon) | `- **Main Point**` | Bold, not colon-terminated |
| `#### Additional Notes:` | `### Notes` with `>` blockquote | Clearer visual separation |
| `id` | `student_id` | More descriptive |
| `grading_table` | `scores` | Simpler name |
| `code_quality_and_design` | `code_quality_design` | Consistent snake_case |

### Category Format

Each category is a `##` heading with three sentiment subsections and a notes
section:

```markdown
## Code Formatting
### Positive
- **Formatting is done well, which includes**
    - [x] concise, clean and clearly written code
    - [x] commenting - appropriate amount provided
### Neutral
- **Okay formatting, but the following could be improved**
    - [ ] blank lines - could be more consistent
### Negative
- **The following formatting issues were present**
    - [x] naming - variable names not descriptive enough
### Notes
> Generally well-written code. Minor PEP8 issues.
```

### Checkbox Format

- **Checked**: `- [x] <text>` (lowercase `x`)
- **Unchecked**: `- [ ] <text>` (space between brackets)

### Indentation

- Category headings: `##` (level 2)
- Sentiment headings: `###` (level 3)
- Main points: `- **text**` (list item, bold)
- Sub-points: `    - [x] text` (4-space indent under main point)
- Notes: `> text` (blockquote under `### Notes`)

### Special Cases

1. **Empty main point**: When `main_point` is `""`, sub-points appear directly
   without a bold heading:
   ```markdown
   ### Negative
   - formatting - placing each parameter on a new line is not necessary
   - keyword arguments - include the parameter name
   ```

2. **Comment sub-points**: When a sub-point has `comment: true`, the grader's
   comment follows the checked item as an indented blockquote:
   ```markdown
   - [x] execution - the code does not run because of the following problem(s):
       > Missing import for pandas. Cell 3 raises NameError.
   ```

3. **Point deduction sub-points**: When a sub-point has `point_deduction: true`,
   the deduction amount follows in parentheses:
   ```markdown
   - [x] Your solution was very similar to another student's solution (-1.5)
       > Code structure and variable names matched 2026SS_07 almost exactly.
   ```

## Full Example

```markdown
---
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
result:
    percentage: 82.0
    grade: 2.0
    label: B+
---

# Evaluation — 2026SS_03

## Code Formatting
### Positive
- **Formatting is done well, which includes**
    - [x] concise, clean and clearly written code
    - [x] commenting - appropriate amount provided (i.e., not excessive or insufficient)
    - [x] imports - libraries were alphabetized
### Neutral
### Negative
- **The following formatting issues were present in your code**
    - [x] blank lines - missing the required two blank lines after imports and/or around user-defined functions (PEP8)
### Notes
> The code is generally well-written. PEP8 blank line issues around functions.

## Coding Concept
### Positive
### Neutral
### Negative
### Notes
> Good use of Pandas vectorized operations.

## Academic Scholarship
### Positive
- **Scholarship done well, which includes**
    - [x] citing - source of information and knowledge
### Neutral
### Negative
- **Scholarship done poorly, which includes the following**
    - [x] citing - missing references for knowledge (e.g., datasets, equations, libraries)
### Notes

## Pandas
### Positive
- **Overall Pandas feedback**
    - [x] Effective use of Pandas and its built-in functions
### Neutral
### Negative
### Notes
> Good use of dropna and drop_duplicates for data cleaning.
```

## Relationship to Evaluation Output

The evaluation MD file and the evaluation output YAML/JSON contain the same
data in different formats:

```
Evaluation Output (YAML/JSON)  ←──app──►  Evaluation MD
     (structured)                           (human-readable)
```

The app can render the structured output as MD for display, and parse MD
back into structured data. The structured YAML/JSON is the canonical format;
the MD is a rendering.

## Conversion to JSON

The `md_to_json.py` script converts these MD files to JSON format. It:
1. Parses the YAML frontmatter for scores and student ID
2. Parses the checkbox sections for checked/unchecked items
3. Uses the criteria JSON files as the source of truth for exact text matching
4. Produces a flat JSON object with scoped keys

See [json-export-schema.md](json-export-schema.md) for the output format.

## Example

```markdown
---
id: 2026SS_03
grading_table:
    code_quality_and_design: 4.5
    code_execution_and_results: 5.5
    assignment_requirements: 5.0
    scientific_programming: 4.5
    creativity: 2.0
---

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