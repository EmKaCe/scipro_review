# Criteria Schema

> **Status**: v2 — Unified YAML-only criteria format. Replaces both the legacy
> JSON criteria format and the Svelte prototype YAML format.

## Overview

Criteria YAML files define the rubric that graders use to evaluate student
submissions. Each file contains one or more **categories**, each with
**positive**, **neutral**, and **negative** feedback sections organized into
**main points** and **sub-points**.

There are two types of criteria files:

| Type | File | Loaded For |
|------|------|-----------|
| **General** | `criteria/general.yaml` | Every assignment |
| **Assignment-specific** | `criteria/<assignment>.yaml` | One assignment only |

## Structure

```yaml
# general.yaml — shared across all assignments
categories:
  <category_key>:
    title: <string>
    additional_notes: <boolean>
    positive:
      - main_point: <string>
        sub_points:
          - text: <string>
            comment: <boolean>          # default: false
            point_deduction: <boolean>   # default: false
    neutral:
      - main_point: <string>
        sub_points:
          - text: <string>
    negative:
      - main_point: <string>
        sub_points:
          - text: <string>
```

```yaml
# <assignment>.yaml — assignment-specific categories
categories:
  <category_key>:
    title: <string>
    additional_notes: <boolean>
    positive:
      - main_point: <string>
        sub_points:
          - text: <string>
            comment: <boolean>
            point_deduction: <boolean>
    neutral: []
    negative:
      - main_point: <string>
        sub_points:
          - text: <string>
```

## Field Definitions

### Category

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `title` | string | ✅ | — | Display heading (e.g., "Code Formatting") |
| `additional_notes` | boolean | ✅ | — | Whether a free-text notes textarea is shown |
| `positive` | MainPoint[] | ✅ | — | Positive feedback groups. Can be empty `[]`. |
| `neutral` | MainPoint[] | ✅ | — | Neutral feedback groups. Can be empty `[]`. |
| `negative` | MainPoint[] | ✅ | — | Negative feedback groups. Can be empty `[]`. |

### MainPoint

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `main_point` | string | ✅ | Group heading. Shown as a bold label above sub-points. Use `""` for ungrouped items. |
| `sub_points` | SubPoint[] | ✅ | Selectable checkbox items under this heading. |

### SubPoint

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `text` | string | ✅ | — | Checkbox label shown to the grader. Also used as the identifier in exports. |
| `comment` | boolean | ❌ | `false` | When `true`, selecting this item reveals a textarea for additional detail. |
| `point_deduction` | boolean | ❌ | `false` | When `true`, selecting this item reveals a numeric deduction input. |

## Category Keys

Category keys are `snake_case` identifiers used throughout the system. They
must be unique across the combined set of general + assignment-specific categories.

### General Categories

| Key | Title | Notes |
|-----|-------|-------|
| `code_formatting` | Code Formatting | ✅ |
| `coding_concept` | Coding Concept | ✅ |
| `jupyter_notebooks` | Jupyter Notebooks | ✅ |
| `academic_scholarship` | Academic Scholarship | ✅ |
| `following_instructions` | Following Instructions | ✅ |
| `general_feedback` | General Feedback | ✅ |

### Assignment-Specific Categories (Atom Interaction)

| Key | Title | Notes |
|-----|-------|-------|
| `user_defined_functions` | User-Defined Functions | ✅ |
| `function_calling` | Function (and Method) Calling | ✅ |
| `pandas` | Pandas | ✅ |
| `plotting` | Plotting Data | ✅ |
| `significant_figures` | Significant Figures | ✅ |

## Loading & Merging

When a grader selects an assignment, the app loads:

1. **`general.yaml`** → 6 shared categories
2. **`<assignment>.yaml`** → assignment-specific categories

Both files use the same `categories:` top-level key. The app merges them into
a single ordered list: general categories first, then assignment-specific.

```
general.yaml  ──►  categories: {code_formatting, coding_concept, ...}
                        │
atom_interaction.yaml ──►  categories: {user_defined_functions, pandas, ...}
                        │
                        ▼
              Merged rubric (11 categories)
```

## Examples

### General Category with All Three Sentiments

```yaml
categories:
  code_formatting:
    title: Code Formatting
    additional_notes: true
    positive:
    - main_point: Formatting is done well, which includes
      sub_points:
      - text: blank lines - consistent and good usage
      - text: concise, clean and clearly written code
      - text: commenting - appropriate amount provided (i.e., not excessive or insufficient)
    neutral: []
    negative:
    - main_point: The following formatting issues were present in your code
      sub_points:
      - text: blank lines - missing the required two blank lines after imports and/or around user-defined functions (PEP8)
      - text: naming - object/variable (e.g., df, data, x, y) is not descriptive enough
```

### Category with Comment and Point Deduction

```yaml
categories:
  academic_scholarship:
    title: Academic Scholarship
    additional_notes: true
    negative:
    - main_point: Plagiarism - classmate
      sub_points:
      - text: Your solution was very similar to another student's solution, with minor differences. Consequently, I was unable to identify whose work it actually was. Points remove
        comment: true
        point_deduction: true
```

### Category with Only Negative Items

```yaml
categories:
  function_calling:
    title: Function (and Method) Calling
    additional_notes: true
    positive: []
    neutral: []
    negative:
    - main_point: ''
      sub_points:
      - text: formatting - placing each parameter being passed onto a new line is not necessary and makes the code less concise
      - text: keyword arguments calls - include the parameter that are being assigned the argument to
```

### Assignment-Specific File (Atom Interaction)

```yaml
categories:
  user_defined_functions:
    title: User-Defined Functions
    additional_notes: true
    positive:
    - main_point: Good use of the following
      sub_points:
      - text: docstring - providing context; stating what the function does
      - text: docstring - clearly defining all input variables/objects
      - text: internal check - proper use of 'if not isinstance', 'raise' statements, etc.
    neutral:
    - main_point: Okay user-defined function(s), but the following could be improved
      sub_points:
      - text: assert vs. raise - it is better to use 'raise' since 'assert' can be bypassed
    negative:
    - main_point: Your user-defined functions had the following problems
      sub_points:
      - text: docstring - none provided for specifying context
      - text: internal checks - none provided (e.g., 'if not isinstance')
      - text: type hinting - none provided

  pandas:
    title: Pandas
    additional_notes: true
    positive:
    - main_point: Overall Pandas feedback
      sub_points:
      - text: Effective use of Pandas and its built-in functions
      - text: Plotting - Nicely made plots containing all key elements
    negative:
    - main_point: Reading Data Into Pandas
      sub_points:
      - text: Delimiter (`sep`) - Incorrectly specified the separator used within the CSV-formatted file.
      - text: Incorrectly read in the data.
    - main_point: Data Cleaning & Preparation
      sub_points:
      - text: Cleaning not done - You failed to drop duplicated rows.
      - text: Cleaning not done - You failed to drop rows with empty/missing cells.
```

## Migration from Legacy Formats

### From JSON Criteria (v1)

| v1 JSON | v2 YAML | Notes |
|---------|---------|-------|
| `"subPoints": ["text"]` | `sub_points: [{text: text}]` | Strings → objects |
| `additionalNotes` | `additional_notes` | camelCase → snake_case |
| `mainPoint` | `main_point` | camelCase → snake_case |
| `codeFormatting` | `code_formatting` | camelCase → snake_case |
| Implicit `:` suffix | `comment: true` | Explicit flag |
| One category per file | Multiple categories per file | Under `categories:` |
| `references.json` | `assignments.yaml` | Merged into registry |

### From Svelte Prototype YAML (v1.5)

| v1.5 YAML | v2 YAML | Notes |
|-----------|---------|-------|
| `general:` top key | `categories:` top key | Clearer naming |
| `assignment_specific: []` | Removed | No longer needed |
| `codeFormatting` | `code_formatting` | camelCase → snake_case |
| `additional_notes` | `additional_notes` | Unchanged |
| `main_point` | `main_point` | Unchanged |
| `text` / `comment` / `point_deduction` | Same | Unchanged |