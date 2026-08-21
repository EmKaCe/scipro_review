# TypeScript Type Schema

> **Status**: v2 — Complete TypeScript type definitions for the SciPro Review
> application. Aligned with the YAML schema specification in
> `.github/references/schemas/`. The files described here live in
> `frontend/src/lib/types/`; a barrel (`index.ts`) re-exports the domain
> types and helpers.

## Overview

This document defines the TypeScript types for the entire review data model.
Types are organized into four domains:

| Domain | Source | Types File |
|--------|--------|------------|
| **Criteria** | `criteria/*.yaml` | `frontend/src/lib/types/criteria.ts` |
| **Grading** | `grading_config.yaml` | `frontend/src/lib/types/grading.ts` |
| **Evaluation** | `evaluations/*.yaml` | `frontend/src/lib/types/evaluation.ts` |
| **Assignments** | `assignments.yaml` | `frontend/src/lib/types/assignments.ts` |

Plus two supporting modules:

| Module | Purpose | Types File |
|--------|---------|------------|
| **Session** | In-progress review state | `frontend/src/lib/types/session.ts` |
| **Persistence** | IndexedDB / file storage | `frontend/src/lib/types/persistence.ts` |

> The **pipeline envelope types** (pre-evaluation wire contract) live
> separately in `frontend/src/lib/types/submissions.ts`: `PreEvalData`,
> `PreEvalGradeSuggestion`, `GradingConfidence`, `CalibrationAdjustment`,
> `OverTickResult`, `SubmissionMeta`, `SubmissionDetail`. Their server-side
> counterparts (`PreEvaluation`, `PreEvaluationWithPostProcess`,
> `StoredPreEvaluation`) are defined in
> `frontend/src/lib/server/copilot/pre-evaluation.ts` /
> `frontend/src/lib/server/results-store.ts`. See data-structures.md §2.

## Design Principles

1. **YAML keys = TS property names** — No mapping layer between YAML `snake_case`
   keys and TypeScript `camelCase` properties. The app uses `snake_case`
   throughout for data model properties.
2. **Branded types for IDs** — Stringly-typed identifiers like `StudentId` and
   `CategoryKey` are branded to prevent accidental mixing.
3. **Read-only config types** — Data loaded from YAML config files is typed as
   `readonly` / `as const` to distinguish it from mutable session state.
4. **Explicit unions** — Sentiment, dimension keys, and category keys are
   string unions, not `string`. This enables exhaustive checking.
5. **Separation of config vs. state** — Types loaded from YAML (criteria,
   grading config, assignments) are separate from types representing
   grader selections and computed results.

---

## `frontend/src/lib/types/criteria.ts` — Rubric Criteria

```typescript
/**
 * Data models for rubric criteria loaded from YAML files.
 *
 * These types represent the READ-ONLY configuration data that defines
 * the rubric. They are loaded from criteria/*.yaml and never mutated.
 */

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Sentiment direction of a feedback item. */
export type Sentiment = "positive" | "neutral" | "negative";

/**
 * Branded category key — a snake_case string identifying a rubric category.
 *
 * Use `parseCategoryKey()` to create from untrusted input, or
 * `categoryKeyOf()` for known-literal values.
 */
export type CategoryKey = string & { readonly __brand: "CategoryKey" };

// ---------------------------------------------------------------------------
// Sub-point
// ---------------------------------------------------------------------------

/** A single selectable checkbox item under a main point. */
export interface SubPoint {
  /** Display text shown to the grader. */
  readonly text: string;
  /** When true, selecting this item reveals a comment textarea. */
  readonly comment?: boolean;
  /** When true, selecting this item reveals a numeric deduction input. */
  readonly point_deduction?: boolean;
}

// ---------------------------------------------------------------------------
// Main point
// ---------------------------------------------------------------------------

/** A group heading with its selectable sub-points. */
export interface MainPoint {
  /** Heading text. Empty string `""` for ungrouped items. */
  readonly main_point: string;
  /** Selectable checkbox items under this heading. */
  readonly sub_points: readonly SubPoint[];
}

// ---------------------------------------------------------------------------
// Category
// ---------------------------------------------------------------------------

/** A rubric category containing positive, neutral, and negative feedback. */
export interface Category {
  /** Human-readable title (e.g., "Code Formatting"). */
  readonly title: string;
  /** Whether a free-text notes textarea is shown for this category. */
  readonly additional_notes: boolean;
  /** Positive feedback groups. May be empty. */
  readonly positive: readonly MainPoint[];
  /** Neutral feedback groups. May be empty. */
  readonly neutral: readonly MainPoint[];
  /** Negative feedback groups. May be empty. */
  readonly negative: readonly MainPoint[];
}

// ---------------------------------------------------------------------------
// Criteria file
// ---------------------------------------------------------------------------

/**
 * Top-level structure of a criteria YAML file.
 *
 * Both `general.yaml` and assignment-specific files use this format.
 * The `categories` map is keyed by `CategoryKey`.
 */
export interface CriteriaFile {
  /** Rubric categories keyed by snake_case identifier. */
  readonly categories: Readonly<Record<string, Category>>;
}

// ---------------------------------------------------------------------------
// Merged rubric
// ---------------------------------------------------------------------------

/**
 * The complete rubric for an assignment, after merging general + specific.
 *
 * Categories are ordered: general first, then assignment-specific.
 * The map preserves insertion order (JS Map or typed array).
 */
export interface MergedRubric {
  /** Ordered categories for the selected assignment. */
  readonly categories: readonly CategoryEntry[];
}

/** A category entry in the merged rubric, pairing key with data. */
export interface CategoryEntry {
  /** Snake_case category identifier. */
  readonly key: CategoryKey;
  /** Category data. */
  readonly category: Category;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** All sub-points in a category, across all sentiments. */
export function allSubPoints(category: Category): readonly SubPoint[] {
  return [
    ...category.positive.flatMap((mp) => mp.sub_points),
    ...category.neutral.flatMap((mp) => mp.sub_points),
    ...category.negative.flatMap((mp) => mp.sub_points),
  ];
}

/** All main points in a category for a given sentiment. */
export function mainPointsFor(
  category: Category,
  sentiment: Sentiment
): readonly MainPoint[] {
  return category[sentiment];
}

/** Whether any sub-point in the category has `comment: true`. */
export function hasCommentItems(category: Category): boolean {
  return allSubPoints(category).some((sp) => sp.comment === true);
}

/** Whether any sub-point in the category has `point_deduction: true`. */
export function hasDeductionItems(category: Category): boolean {
  return allSubPoints(category).some((sp) => sp.point_deduction === true);
}
```

---

## `frontend/src/lib/types/grading.ts` — Grading Configuration & Calculation

```typescript
/**
 * Grading configuration, dimension keys, score inputs, and grade results.
 *
 * Config types are READ-ONLY (loaded from grading_config.yaml).
 * Input and result types are mutable (grader enters scores, app computes results).
 */

// ---------------------------------------------------------------------------
// Dimension keys (branded union)
// ---------------------------------------------------------------------------

/**
 * Branded dimension key — identifies a grading dimension.
 *
 * Known values: code_quality_design, code_execution_results,
 * assignment_requirements, scientific_programming, creativity.
 */
export type DimensionKey = string & { readonly __brand: "DimensionKey" };

// ---------------------------------------------------------------------------
// Configuration (read-only)
// ---------------------------------------------------------------------------

/** A single grading dimension from the configuration. */
export interface GradeDimension {
  /** Snake_case identifier (e.g., "code_quality_design"). */
  readonly key: DimensionKey;
  /** Display label (e.g., "Code Quality & Design"). */
  readonly title: string;
  /** Maximum raw score (typically 6.0 or 4.0). */
  readonly max_points: number;
  /** Weight multiplier for percentage calculation. */
  readonly weight: number;
  /** Optional per-score-range descriptions for tooltip display. */
  readonly descriptions?: Record<string, string>;
}

/** A grade boundary in the German grading scale. */
export interface GradeBoundary {
  /** Lower bound (inclusive) of the percentage range. */
  readonly min_percentage: number;
  /** German grade value (1.0 = best, 5.0 = fail). */
  readonly grade: number;
  /** German grade descriptor (e.g., "excellent", "good"). */
  readonly label: string;
  /** US letter-grade equivalent (e.g., "A+", "B-"). */
  readonly us_equiv: string;
}

/** Full grading configuration parsed from grading_config.yaml. */
export interface GradingConfig {
  /** Ordered list of grading dimensions. */
  readonly dimensions: readonly GradeDimension[];
  /** Grade boundaries sorted by min_percentage descending. */
  readonly grade_boundaries: readonly GradeBoundary[];
}

// ---------------------------------------------------------------------------
// Score inputs (mutable — grader enters these)
// ---------------------------------------------------------------------------

/**
 * Raw scores entered by the grader for each dimension.
 *
 * Keys match `GradeDimension.key`. Values are numbers in [0, max_points].
 */
export interface GradingInputs {
  code_quality_design: number;
  code_execution_results: number;
  assignment_requirements: number;
  scientific_programming: number;
  creativity: number;
}

// ---------------------------------------------------------------------------
// Computed results (derived from inputs + config)
// ---------------------------------------------------------------------------

/** A single dimension enriched with computed scores. */
export interface DimensionResult {
  /** The dimension definition. */
  readonly dimension: GradeDimension;
  /** Raw score entered by the grader. */
  readonly score: number;
  /** Score × weight. */
  readonly weighted_score: number;
  /** Maximum possible weighted score (max_points × weight). */
  readonly weighted_max: number;
  /** Percentage for this dimension alone (0–100). */
  readonly percentage: number;
}

/** Computed grade result returned by the calculator. */
export interface GradeResult {
  /** Per-dimension breakdown. */
  readonly dimensions: readonly DimensionResult[];
  /** Sum of all weighted scores. */
  readonly total_weighted: number;
  /** Sum of all weighted maxes (= 100 for standard config). */
  readonly total_weighted_max: number;
  /** Overall percentage (0–100). */
  readonly percentage: number;
  /** German grade (1.0–5.0). */
  readonly grade: number;
  /** German grade descriptor (e.g., "excellent", "good"). */
  readonly label: string;
  /** US letter-grade equivalent (e.g., "A+", "B-"). */
  readonly us_equiv: string;
  /** Points needed to reach the next better grade band. Null at 1.0. */
  readonly points_to_next_grade: number | null;
  /** Points above the current grade boundary. */
  readonly points_above_boundary: number;
}

// ---------------------------------------------------------------------------
// Summary (aggregated across students)
// ---------------------------------------------------------------------------

/** A single student's grade summary for the overview table. */
export interface StudentGradeSummary {
  readonly student_id: string;
  readonly assignment: string;
  readonly percentage: number;
  readonly grade: number;
  readonly label: string;
}

/** Statistics computed across all graded students. */
export interface GradeStatistics {
  readonly count: number;
  readonly mean_percentage: number;
  readonly median_percentage: number;
  readonly min_percentage: number;
  readonly max_percentage: number;
  readonly grade_distribution: Readonly<Record<number, number>>;
}
```

---

## `frontend/src/lib/types/evaluation.ts` — Evaluation Output

```typescript
/**
 * Structured evaluation output — the canonical data format produced when
 * a grader completes a review.
 *
 * This is the v2 nested format that replaces the legacy flat key-value export.
 * See .github/references/schemas/evaluation-output-schema.md for the full specification.
 */

import type { CategoryKey } from "./criteria.js";
import type { DimensionKey } from "./grading.js";

// ---------------------------------------------------------------------------
// Branded student ID
// ---------------------------------------------------------------------------

/**
 * Branded student identifier (e.g., "2026SS_03").
 *
 * Format: `{year}SS_{two-digit-number}`.
 */
export type StudentId = string & { readonly __brand: "StudentId" };

// ---------------------------------------------------------------------------
// Category feedback
// ---------------------------------------------------------------------------

/** Feedback selections for a single rubric category. */
export interface CategoryFeedback {
  /** Texts of checked sub-points. */
  readonly checked: readonly string[];
  /** Sub-point text → grader comment. Only for items with `comment: true`. */
  readonly comments: Readonly<Record<string, string>>;
  /** Sub-point text → numeric deduction. Only for items with `point_deduction: true`. */
  readonly deductions: Readonly<Record<string, number>>;
  /** Free-text additional notes. */
  readonly notes: string;
}

// ---------------------------------------------------------------------------
// Scores
// ---------------------------------------------------------------------------

/**
 * Dimension scores, keyed by dimension identifier.
 *
 * Values are in [0, max_points] for the corresponding dimension.
 */
export type EvaluationScores = Readonly<Record<DimensionKey, number>>;

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/** Computed grade information. */
export interface EvaluationResult {
  /** Weighted percentage (0–100). */
  readonly percentage: number;
  /** German grade (1.0–5.0). */
  readonly grade: number;
  /** US letter-grade label. */
  readonly label: string;
}

// ---------------------------------------------------------------------------
// Full evaluation
// ---------------------------------------------------------------------------

/**
 * Complete evaluation output — the canonical format for a graded review.
 *
 * Serialized as YAML or JSON for export. Also rendered as Markdown.
 */
export interface Evaluation {
  /** Student identifier. */
  readonly student_id: StudentId;
  /** Assignment key from assignments.yaml. */
  readonly assignment: string;
  /** Grader name or identifier. */
  readonly reviewer: string;
  /** ISO date of the review (YYYY-MM-DD). */
  readonly date: string;
  /** Scores for each grading dimension. */
  readonly scores: EvaluationScores;
  /** Feedback for each rubric category. */
  readonly feedback: Readonly<Record<CategoryKey, CategoryFeedback>>;
  /** Computed grade result (optional for backward compatibility). */
  readonly result?: EvaluationResult;
  /** Free-text feedback notes (top-level, teacher-written). */
  readonly notes?: string;
}
```

---

## `frontend/src/lib/types/assignments.ts` — Assignment Registry

```typescript
/**
 * Assignment registry — the single source of truth for what assignments exist,
 * which criteria files they use, and which grading dimensions apply.
 *
 * Loaded from data/assignments.yaml.
 */

import type { DimensionKey } from "./grading.js";

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------

/** A single assignment defined in the registry. */
export interface Assignment {
  /** Snake_case identifier (e.g., "atom_interaction"). */
  readonly id: string;
  /** Human-readable display title. */
  readonly title: string;
  /** Whether the assignment appears in the selector. */
  readonly enabled: boolean;
  /** Ordered list of criteria YAML files (relative to data/criteria/). */
  readonly criteria_files: readonly string[];
  /** Optional per-assignment scoring config (data/scoring/<id>.yaml). */
  readonly scoring_file?: string;
  /** Dimension keys that apply to this assignment. */
  readonly dimensions: readonly DimensionKey[];
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** Full assignments registry parsed from assignments.yaml. */
export interface AssignmentsRegistry {
  /** All registered assignments. */
  readonly assignments: readonly Assignment[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Find an assignment by ID. Returns undefined if not found. */
export function findAssignment(
  registry: AssignmentsRegistry,
  id: string
): Assignment | undefined {
  return registry.assignments.find((a) => a.id === id);
}

/** Get only enabled assignments. */
export function enabledAssignments(
  registry: AssignmentsRegistry
): readonly Assignment[] {
  return registry.assignments.filter((a) => a.enabled);
}
```

---

## `frontend/src/lib/types/session.ts` — In-Progress Review State

```typescript
/**
 * Session state types representing an in-progress review.
 *
 * These types are MUTABLE — they represent the grader's live selections
 * before the review is finalized and exported as an Evaluation.
 *
 * Contrast with `types/evaluation.ts` which represents the immutable output.
 */

import type { CategoryKey } from "./criteria.js";
import type { GradingInputs } from "./grading.js";

// ---------------------------------------------------------------------------
// Category selection state
// ---------------------------------------------------------------------------

/**
 * Selection state for a single rubric category.
 *
 * Uses Set<string> for O(1) lookup when toggling checkboxes.
 * The strings are sub-point `text` values.
 */
export interface CategorySelections {
  /** Set of checked sub-point texts. */
  checked_items: Set<string>;
  /** Free-text additional notes. */
  notes: string;
  /** Inline comments keyed by sub-point text. */
  comments: Record<string, string>;
  /** Point deductions keyed by sub-point text. */
  deductions: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Review session
// ---------------------------------------------------------------------------

/**
 * Complete in-progress review session.
 *
 * This is the mutable working state that gets persisted to IndexedDB
 * on every change. When finalized, it's converted to an immutable Evaluation.
 */
export interface ReviewSession {
  /** Student identifier. */
  student_id: string;
  /** Assignment key. */
  assignment_id: string;
  /** Review mode (for backward compatibility with persisted sessions). */
  mode: string;
  /** Per-category selections keyed by category key. */
  category_selections: Record<CategoryKey, CategorySelections>;
  /** Raw scores for each grading dimension. */
  grading: GradingInputs;
  /** Generated evaluation text (Markdown). */
  generated_text: string;
  /** Free-text feedback notes (top-level, teacher-written; optional). */
  notes?: string;
  /** ISO timestamp when the session was started. */
  started_at: string;
  /** ISO timestamp of the last update. */
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Conversion: Session → Evaluation
// ---------------------------------------------------------------------------

/**
 * Convert category selections to category feedback (immutable output).
 *
 * This is called when the grader finalizes the review.
 */
export function categorySelectionsToFeedback(selections: CategorySelections): {
  checked: string[];
  comments: Record<string, string>;
  deductions: Record<string, number>;
  notes: string;
} {
  return {
    checked: [...selections.checked_items],
    comments: { ...selections.comments },
    deductions: { ...selections.deductions },
    notes: selections.notes,
  };
}
```

---

## `frontend/src/lib/types/persistence.ts` — Storage & Export

```typescript
/**
 * Types for IndexedDB persistence and file export.
 */

import type { ReviewSession } from "./session.js";

// ---------------------------------------------------------------------------
// IndexedDB records
// ---------------------------------------------------------------------------

/** A persisted review record in IndexedDB. */
export interface ReviewRecord {
  /** Unique record identifier (auto-generated). */
  readonly id: string;
  /** Academic semester derived from student_id (e.g., "2026SS"). */
  readonly semester: string;
  /** Student identifier. */
  readonly student_id: string;
  /** Assignment key. */
  readonly assignment_id: string;
  /** Review mode. */
  readonly mode: string;
  /** ISO timestamp when the review was started. */
  readonly started_at: string;
  /** ISO timestamp of the last update. */
  readonly updated_at: string;
  /** Full serialized session state. */
  data: ReviewSession;
}

/** Auto-save sentinel record for the current in-progress session. */
export interface CurrentSessionRecord extends Omit<ReviewRecord, "id"> {
  readonly id: "__current__";
}

// ---------------------------------------------------------------------------
// Bulk export
// ---------------------------------------------------------------------------

/** Structure of a bulk export containing all persisted reviews. */
export interface BulkExport {
  /** ISO timestamp when the export was generated. */
  readonly exported_at: string;
  /** All review records. */
  readonly reviews: readonly ReviewRecord[];
}

// ---------------------------------------------------------------------------
// File export
// ---------------------------------------------------------------------------

/** Supported export formats. */
export type ExportFormat = "yaml" | "json" | "md";

/** Options for exporting a single evaluation. */
export interface ExportOptions {
  /** Output format. */
  readonly format: ExportFormat;
  /** Whether to include the generated Markdown text. */
  readonly include_generated_text: boolean;
  /** Whether to pretty-print JSON output. */
  readonly pretty: boolean;
}

// ---------------------------------------------------------------------------
// DB constants
// ---------------------------------------------------------------------------

/** Fixed key for the auto-saved current session. */
export const CURRENT_SESSION_KEY = "__current__" as const;

/** IndexedDB database name. */
export const DB_NAME = "scipro_reviews" as const;

/** IndexedDB schema version. */
export const DB_VERSION = 1 as const;

/** Object store name for review records. */
export const SESSION_STORE = "reviews" as const;
```

---

## Type Dependency Graph

```
frontend/src/lib/types/criteria.ts
  ├── CategoryKey (branded)
  ├── SubPoint, MainPoint, Category
  ├── CriteriaFile, MergedRubric, CategoryEntry
  └── Sentiment

frontend/src/lib/types/grading.ts
  ├── DimensionKey (branded)
  ├── GradeDimension, GradeBoundary, GradingConfig  ← read-only config
  ├── GradingInputs                                ← mutable grader input
  └── GradeResult, DimensionResult                 ← computed output

frontend/src/lib/types/evaluation.ts
  ├── StudentId (branded)
  ├── CategoryFeedback                             ← per-category output
  ├── EvaluationScores, EvaluationResult           ← scores + grade
  ├── Evaluation                                   ← canonical output format
  └── imports CategoryKey (criteria), DimensionKey (grading)

frontend/src/lib/types/assignments.ts
  ├── Assignment, AssignmentsRegistry               ← read-only config
  └── imports DimensionKey

frontend/src/lib/types/session.ts
  ├── CategorySelections, ReviewSession              ← mutable state
  └── imports CategoryKey, GradingInputs

frontend/src/lib/types/persistence.ts
  ├── ReviewRecord, CurrentSessionRecord             ← IndexedDB
  ├── BulkExport, ExportOptions                      ← file export
  └── imports ReviewSession
```

## Key Naming Convention

All data model properties use `snake_case` to match the YAML keys directly.
This eliminates the need for a mapping/serialization layer.

```typescript
// ✅ v2: snake_case everywhere — matches YAML keys
const category: Category = {
  title: "Code Formatting",
  additional_notes: true,
  positive: [...],
};

// ❌ v1: camelCase — required mapping from YAML
const category = {
  title: "Code Formatting",
  additionalNotes: true,  // doesn't match YAML key
  positive: [...],
};
```

## Branded Types

Branded types prevent accidental mixing of stringly-typed identifiers:

```typescript
// Without branding — easy to mix up:
function grade(studentId: string, categoryKey: string) { ... }
grade("code_formatting", "2026SS_03");  // Oops! Swapped args, no error

// With branding — compiler catches the mistake:
function grade(studentId: StudentId, categoryKey: CategoryKey) { ... }
grade(categoryKeyOf("code_formatting"), studentIdOf("2026SS_03"));  // OK
grade(studentIdOf("2026SS_03"), categoryKeyOf("code_formatting"));  // Error!
```

### Brand Helpers

The brand factories are **per-module plain functions**, not a shared
`types/helpers.ts` object:

```typescript
// in frontend/src/lib/types/criteria.ts
/** Create a CategoryKey from an untrusted string. Trims whitespace. */
export function parseCategoryKey(value: string): CategoryKey {
  return value.trim() as CategoryKey;
}

/** Create a CategoryKey from a known-literal value (no validation). */
export function categoryKeyOf(value: string): CategoryKey {
  return value as unknown as CategoryKey;
}

// grading.ts / evaluation.ts provide the same pair for their brands:
// parseDimensionKey / dimensionKeyOf, parseStudentId / studentIdOf
```

All three modules are re-exported together from the `index.ts` barrel.

## Migration from v1.5 Svelte Prototype Types

| v1.5 Type | v2 Type | Changes |
|-----------|---------|---------|
| `CriteriaBundle.general` | `CriteriaFile.categories` | Unified under `categories:` |
| `CriteriaBundle.assignment_specific` | Merged into `MergedRubric.categories` | No split |
| `AssignmentConfig` | `Assignment` | Added `dimensions` field |
| `GradingConfig` (no boundaries) | `GradingConfig` (with `grade_boundaries`) | Boundaries in config |
| `GradeBoundary.min_pct` | `GradeBoundary.min_percentage` | snake_case |
| `GradeBoundary.us_equiv` | `GradeBoundary.us_equiv` (kept) | Now alongside `label` (German descriptor) — both fields exist |
| `CategorySelections.additional_notes` | `CategorySelections.notes` | Renamed |
| `ReviewSession.subpoint_comments` | `CategorySelections.comments` | Moved into category |
| `ReviewSession.subpoint_deductions` | `CategorySelections.deductions` | Moved into category |
| No `Evaluation` type | `Evaluation` | New canonical output type |
| No `CategoryFeedback` type | `CategoryFeedback` | New structured feedback |
| No branded types | `CategoryKey`, `DimensionKey`, `StudentId` | New branded types |