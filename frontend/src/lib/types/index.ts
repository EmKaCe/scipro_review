/**
 * @file Barrel export for all type definitions.
 *
 * Domain types are organized into separate modules by concern.
 * UI-only types that don't belong to a specific domain are defined here.
 *
 * @see criteria.ts — Rubric criteria data models
 * @see grading.ts — Grading configuration and calculation types
 * @see evaluation.ts — Evaluation output types
 * @see assignments.ts — Assignment registry types
 * @see session.ts — In-progress review session types
 * @see persistence.ts — IndexedDB and file export types
 */

// ---------------------------------------------------------------------------
// Domain types (re-exported for convenience)
// ---------------------------------------------------------------------------

export type {
	Sentiment,
	CategoryKey,
	SubPoint,
	MainPoint,
	Category,
	CriteriaFile,
	MergedRubric,
	CategoryEntry,
} from "./criteria.js";

export {
	parseCategoryKey,
	categoryKeyOf,
	allSubPoints,
	mainPointsFor,
	hasCommentItems,
	hasDeductionItems,
} from "./criteria.js";

export type {
	DimensionKey,
	GradeDimension,
	GradeBoundary,
	GradingConfig,
	GradingInputs,
	DimensionResult,
	GradeResult,
} from "./grading.js";

export {
	parseDimensionKey,
	dimensionKeyOf,
	defaultGradingInputs,
	weightPercentage,
} from "./grading.js";

export type {
	StudentId,
	CategoryFeedback,
	EvaluationScores,
	EvaluationResult,
	Evaluation,
} from "./evaluation.js";

export { parseStudentId, studentIdOf } from "./evaluation.js";

export type { AssignmentsRegistry } from "./assignments.js";

export { findAssignment, enabledAssignments } from "./assignments.js";

export type { CategorySelections, ReviewSession } from "./session.js";

export { categorySelectionsToFeedback } from "./session.js";

export type {
	ReviewRecord,
	CurrentSessionRecord,
	BulkExport,
	ExportFormat,
	ExportOptions,
} from "./persistence.js";

export {
	CURRENT_SESSION_KEY,
	DB_NAME,
	DB_VERSION,
	SESSION_STORE,
	extractSemester,
	generateId,
} from "./persistence.js";

// ---------------------------------------------------------------------------
// UI-only types (not part of the domain model)
// ---------------------------------------------------------------------------

/** Toast notification severity level. */
export type ToastType = "success" | "error" | "warning" | "info";

/** A transient notification message displayed to the user. */
export interface Toast {
	/** Unique toast identifier. */
	id: string;
	/** Severity level determining icon and color. */
	type: ToastType;
	/** Message text to display. */
	message: string;
	/** Auto-dismiss duration in milliseconds. */
	duration: number;
}

/** Theme preference: light, dark, or follow system preference. */
export type ThemeMode = "light" | "dark" | "system";

/** Maps a minimum percentage threshold to German and US grade equivalents. */
export interface GradeMapping {
	/** Minimum percentage to qualify for this grade. */
	min: number;
	/** German university grade (e.g. "1.0", "2.3"). */
	grade: string;
	/** US letter grade equivalent (e.g. "A+", "B"). */
	us: string;
}
