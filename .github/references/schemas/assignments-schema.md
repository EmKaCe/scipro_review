# Assignments Registry Schema

> **Status**: v2 — Self-contained assignment registry replacing the legacy
> `references.json` configuration.

## File

`data/assignments.yaml`

## Overview

The assignments registry is the single source of truth for what assignments
exist, which criteria files they use, and which grading dimensions apply.
It replaces the legacy `references.json` which had a confusing split between
`general.json` and assignment-specific JSON files.

## Structure

```yaml
assignments:
  - id: <string>              # snake_case identifier
    title: <string>           # Display name
    enabled: <boolean>        # Whether the assignment is active
    criteria_files:           # Ordered list of criteria YAML files to load
      - <string>              # Relative path from data/criteria/
    dimensions:               # Which grading dimensions apply
      - <string>              # Key from grading_config.yaml
```

## Field Definitions

### Assignment

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | ✅ | `snake_case` identifier used in URLs, file names, and exports |
| `title` | string | ✅ | Human-readable display name |
| `enabled` | boolean | ✅ | Whether the assignment appears in the assignment selector |
| `criteria_files` | string[] | ✅ | Ordered list of criteria YAML files (relative to `data/criteria/`) |
| `dimensions` | string[] | ✅ | Keys from `grading_config.yaml` dimensions that apply |

### Criteria File Loading

The `criteria_files` list determines which rubric categories appear for an
assignment. Files are loaded and merged in order:

1. Files listed first appear first in the rubric
2. All files use the same `categories:` top-level key
3. Category keys must be unique across the merged set

The convention is to always include `general.yaml` first, followed by the
assignment-specific file:

```yaml
criteria_files:
  - general.yaml              # 6 shared categories
  - atom_interaction.yaml     # 5 assignment-specific categories
```

### Dimensions

The `dimensions` list specifies which grading dimensions from
`grading_config.yaml` apply to this assignment. This allows different
assignments to use different dimension sets if needed.

For the Atom Interaction assignment, all 5 dimensions apply:

```yaml
dimensions:
  - code_quality_design
  - code_execution_results
  - assignment_requirements
  - scientific_programming
  - creativity
```

## Full Example

```yaml
assignments:
  - id: atom_interaction
    title: Atom Interaction (Lennard-Jones / Pandas)
    enabled: true
    criteria_files:
      - general.yaml
      - atom_interaction.yaml
    dimensions:
      - code_quality_design
      - code_execution_results
      - assignment_requirements
      - scientific_programming
      - creativity

  - id: molecular_dynamics
    title: Molecular Dynamics (NumPy / Matplotlib)
    enabled: false
    criteria_files:
      - general.yaml
      - molecular_dynamics.yaml
    dimensions:
      - code_quality_design
      - code_execution_results
      - assignment_requirements
      - scientific_programming
      - creativity
```

## Migration from Legacy Formats

### From `references.json` (v1)

The legacy `references.json` had a confusing structure:

```json
{
  "general": "general.json",
  "assignment_specific": [
    "user_defined_functions.json",
    "calling_function.json",
    "pandas.json",
    "plotting.json",
    "significant_figures.json"
  ]
}
```

Problems with this format:
1. **Split across two systems**: `general` was a single file, `assignment_specific`
   was an array — different handling for each
2. **One category per file**: Each assignment-specific category was a separate
   JSON file, requiring 5+ files per assignment
3. **No assignment metadata**: No title, no enabled flag, no dimension list
4. **No assignment registry**: The web app had a hardcoded assignment list
5. **JSON format**: Inconsistent with the YAML-first design

### From Svelte Prototype `assignments.yaml` (v1.5)

The Svelte prototype had a partial assignments registry:

```yaml
assignments:
  - id: atom_interaction
    title: Atom Interaction (Lennard-Jones / Pandas)
    criteria:
      - general.yaml
      - atom_interaction.yaml
```

Improvements in v2:
- Added `enabled` flag for soft-disabling assignments
- Renamed `criteria` → `criteria_files` for clarity
- Added `dimensions` list for per-assignment dimension configuration
- Self-contained: no separate `references.json` needed

## Relationship to Other Schemas

```
assignments.yaml ──► criteria_files ──► criteria/*.yaml (Criteria Schema)
                 ──► dimensions ──► grading_config.yaml (Grading Config Schema)
                 ──► id ──► evaluations/*.yaml (Evaluation Output Schema)
```

The assignments registry is the entry point that ties together criteria,
grading configuration, and evaluation output.