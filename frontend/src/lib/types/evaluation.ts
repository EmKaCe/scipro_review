/**
 * @file Structured evaluation output — the canonical data format produced when
 * a grader completes a review.
 *
 * This is the v2 nested format that replaces the legacy flat key-value export.
 *
 * @see .github/references/schemas/evaluation-output-schema.md
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

/** Create a StudentId from an untrusted string. */
export function parseStudentId(value: string): StudentId {
	return value.trim() as StudentId;
}

/** Create a StudentId from a known-literal value. */
export function studentIdOf(value: string): StudentId {
	return value as unknown as StudentId;
}

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
	/** Computed grade result. */
	readonly result?: EvaluationResult;
	/**
	 * Free-text feedback notes (top-level, teacher-written).
	 * Optional for backward compatibility with exports that predate it.
	 */
	readonly notes?: string;
}
