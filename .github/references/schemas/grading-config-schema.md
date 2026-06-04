# Grading Configuration Schema

> **Status**: v2 — Unified YAML format with consistent `snake_case` keys.

## File

`data/grading_config.yaml`

## Structure

```yaml
dimensions:
  - key: <string>           # snake_case identifier
    title: <string>          # Display label
    max_points: <number>     # Maximum raw score
    weight: <number>         # Multiplier for weighted percentage

grade_boundaries:
  - min_percentage: <number>
    grade: <number>          # German grade (1.0–5.0)
    label: <string>          # US equivalent (A+, A, A-, ...)
```

## Field Definitions

### Dimension

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `key` | string | ✅ | `snake_case` identifier used in grading inputs, session data, and exports |
| `title` | string | ✅ | Display label shown in the grading sidebar |
| `max_points` | number | ✅ | Maximum raw score (typically 6.0 or 4.0) |
| `weight` | number | ✅ | Multiplier for weighted percentage calculation |

### GradeBoundary

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `min_percentage` | number | ✅ | Lower bound (inclusive) of the percentage range |
| `grade` | number | ✅ | German grade (1.0 = best, 5.0 = fail) |
| `label` | string | ✅ | US letter-grade equivalent for display |

## Current Configuration

### Dimensions

| Key | Title | Max Points | Weight | Weighted Max |
|-----|-------|-----------|--------|-------------|
| `code_quality_design` | Code Quality & Design | 6.0 | 4 | 24 |
| `code_execution_results` | Code Execution & Results | 6.0 | 4 | 24 |
| `assignment_requirements` | Assignment Requirements | 6.0 | 4 | 24 |
| `scientific_programming` | Scientific Programming | 6.0 | 4 | 24 |
| `creativity` | Creativity | 4.0 | 1 | 4 |
| **Total** | | | | **100** |

### Grade Boundaries

| Min % | Grade | Label |
|-------|-------|-------|
| 95 | 1.0 | A+ |
| 90 | 1.3 | A |
| 85 | 1.7 | A- |
| 80 | 2.0 | B+ |
| 75 | 2.3 | B |
| 70 | 2.7 | B- |
| 65 | 3.0 | C+ |
| 60 | 3.3 | C |
| 55 | 3.7 | C- |
| 50 | 4.0 | D |
| 0 | 5.0 | F |

## Grade Calculation

$$\text{percentage} = \frac{\sum_i (\text{score}_i \times \text{weight}_i)}{\sum_i (\text{max}_i \times \text{weight}_i)} \times 100$$

### Example

Scores: CQ=4.5, CE=5.5, AR=5.0, SP=4.5, CR=2.0

$$\frac{4.5 \times 4 + 5.5 \times 4 + 5.0 \times 4 + 4.5 \times 4 + 2.0 \times 1}{6 \times 4 + 6 \times 4 + 6 \times 4 + 6 \times 4 + 4 \times 1} \times 100 = \frac{82}{100} \times 100 = 82.0\%$$

→ Grade 2.0 (B+)

## Full Example

```yaml
dimensions:
  - key: code_quality_design
    title: Code Quality & Design
    max_points: 6.0
    weight: 4
  - key: code_execution_results
    title: Code Execution & Results
    max_points: 6.0
    weight: 4
  - key: assignment_requirements
    title: Assignment Requirements
    max_points: 6.0
    weight: 4
  - key: scientific_programming
    title: Scientific Programming
    max_points: 6.0
    weight: 4
  - key: creativity
    title: Creativity
    max_points: 4.0
    weight: 1

grade_boundaries:
  - min_percentage: 95
    grade: 1.0
    label: A+
  - min_percentage: 90
    grade: 1.3
    label: A
  - min_percentage: 85
    grade: 1.7
    label: A-
  - min_percentage: 80
    grade: 2.0
    label: B+
  - min_percentage: 75
    grade: 2.3
    label: B
  - min_percentage: 70
    grade: 2.7
    label: B-
  - min_percentage: 65
    grade: 3.0
    label: C+
  - min_percentage: 60
    grade: 3.3
    label: C
  - min_percentage: 55
    grade: 3.7
    label: C-
  - min_percentage: 50
    grade: 4.0
    label: D
  - min_percentage: 0
    grade: 5.0
    label: F
```

## Migration from Legacy Formats

| v1 / v1.5 | v2 | Notes |
|-----------|-----|-------|
| `codequality-grading` | `code_quality_design` | camelCase → snake_case |
| `code_quality_and_design` | `code_quality_design` | Removed "and" |
| Grade boundaries in code | `grade_boundaries` in YAML | Data-driven |
| Separate `table.js` | `grade_boundaries` list | Single source of truth |