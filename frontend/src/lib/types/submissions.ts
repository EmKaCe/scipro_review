/**
 * @file Teacher-facing submission, cell, and status types for the grading dashboard.
 *
 * These types define the data shapes used by the submissions dashboard and
 * per-submission review page.
 */

import type { CategoryFeedback } from "./evaluation.js";

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/** Lifecycle status of a submission within a grading batch. */
export type SubmissionStatus =
	| "pending"
	| "executing"
	| "executed"
	| "error"
	| "pre-evaluated"
	| "graded"
	/** Soft-archived: hidden from the default dashboard and batch processing,
	 *  but restorable (the notebook + grading stay on disk). */
	| "archived";

// ---------------------------------------------------------------------------
// Grading confidence
// ---------------------------------------------------------------------------

/**
 * Deterministic confidence level of a pre-evaluation, computed server-side
 * from pipeline signals (retry-loop exhaustion, post-processing fix count,
 * pre-analysis findings) — NOT an LLM judgement. Instructors use it to
 * prioritize reviews: `needs_review` rows first, `high_confidence` rows can
 * be skimmed or trusted.
 */
export type GradingConfidence = "needs_review" | "review_optional" | "high_confidence";

// ---------------------------------------------------------------------------
// Cell info
// ---------------------------------------------------------------------------

/** Marker indicating how a student's cell compares to the reference key. */
export type CellMarker =
	/** No comparison data yet — pre-evaluation has not run. */
	| "pending"
	/** Student used the same method/algorithm as the reference (rare). */
	| "same"
	/** Student solved it differently — neutral, expected (default). */
	| "different"
	/** Student's approach is incorrect or suboptimal. */
	| "questionable"
	/** Cell execution failed. */
	| "error";

/** One rich (non-text) output preserved for the teacher preview. */
export interface CellRichOutput {
	/** Mime type: "image/png" (data = base64) or "text/html" (data = raw HTML). */
	mime_type: "image/png" | "text/html" | string;
	/** Base64 encoded image bytes (image/png) or raw HTML string (text/html). */
	data: string;
}

/** A single cell from an executed notebook. */
export interface CellInfo {
	/** 0-based index within the notebook. */
	index: number;
	/** Cell type. */
	type: "code" | "markdown";
	/** Raw source code. */
	source: string;
	/** Cell output text (undefined for markdown or if execution failed). */
	output?: string;
	/**
	 * Rich (non-text) outputs for the teacher preview: image/png (data =
	 * base64) and text/html (data = raw HTML). Rendered in sandboxed
	 * iframes only — NEVER interpolated into copilot prompts.
	 */
	outputs?: CellRichOutput[];
	/** Error traceback if execution failed. */
	error?: string;
	/** Comparison marker against the reference key. */
	marker: CellMarker;
}

// ---------------------------------------------------------------------------
// Pre-evaluation
// ---------------------------------------------------------------------------

/** Pre-evaluation verdict kind for one compared cell. */
export type PreEvalMarker = "same" | "different" | "questionable";

/** One per-cell comparison verdict from pre-evaluation (wire, camelCase). */
export interface PreEvalCellVerdict {
	/** 0-based cell index within the executed notebook. */
	cellIndex: number;
	marker: PreEvalMarker;
	/** Human-readable explanation of the verdict. */
	reason: string;
}

/** Suggested grading values produced by pre-evaluation (read-only for the teacher). */
export interface PreEvalGradeSuggestion {
	/** Dimension id -> suggested value. */
	dimensions: Record<string, number>;
	/** Free-form justification for the suggested grade. */
	justification: string;
}

/**
 * Pre-evaluation comparison + suggestion data attached to the submission
 * detail. `markers: null` means pre-evaluation produced no
 * comparison data — the review UI must keep its pending/neutral state and
 * NEVER default non-error cells to "different".
 */
export interface PreEvalData {
	/** Per-cell verdicts; null = no comparison data yet. */
	markers: PreEvalCellVerdict[] | null;
	gradeSuggestion: PreEvalGradeSuggestion;
	/** Rubric sub-points selected by the LLM per category (categoryKey + optionKey). */
	rubricSelections?: { categoryKey: string; optionKey: string }[];
	/** Per-category additional notes filled by the teacher or pre-evaluation. */
	additionalNotes?: Record<string, string>;
	/** Draft feedback text produced by pre-evaluation. */
	feedbackDraft: string;
	/** Prose summary of the notebook for the teacher. */
	notebookSummary: string;
	/**
	 * Deterministic confidence level of the pre-evaluation (see
	 * {@link GradingConfidence}). Absent on legacy stored envelopes that
	 * predate the field.
	 */
	gradingConfidence?: GradingConfidence;
	/** ISO timestamp of the pre-evaluation run. */
	evaluatedAt: string;
}

// ---------------------------------------------------------------------------
// Over-tick guard (review-diff workflow, signed off 2026-08-18)
// ---------------------------------------------------------------------------

/**
 * One category flagged by the over-tick guard (Signal B): the pipeline
 * checked more items in this category than the cohort norm tolerates.
 * `categoryKey` is the pipeline's snake_case criteria key; `median` /
 * `threshold` come from the committed cohort norms.
 */
export interface OverTickCategory {
	/** Pipeline category key (criteria YAML snake_case, e.g. "plotting_visualization"). */
	categoryKey: string;
	/** Pipeline checked-item count in this category. */
	count: number;
	/** Cohort median for the category (professor's typical count). */
	median: number;
	/** Flag threshold = median + 3. */
	threshold: number;
	/** The pipeline-checked sub-point texts in this category (the extras to review). */
	items: string[];
}

/**
 * Advisory over-tick flags for one submission, computed server-side from
 * the committed cohort norms (data/cohort_norms/<assignment>.yaml) and the
 * stored pipeline rubric selections. The flag NEVER blocks export — it is
 * teacher-review input (Q3 sign-off).
 */
export interface OverTickResult {
	/** Signal A: total checked count exceeds max(median*1.5, median+10). */
	totalFlagged: boolean;
	/** Signal B: categories whose count exceeds category_median + 3. */
	overTickCategories: OverTickCategory[];
	/** Signal C: informational note when the count looks normal but overlap with a typical review is < 60%. */
	overlapNote?: string;
	/** Total pipeline-checked item count. */
	total: number;
	/** Cohort median total (the professor's typical checked count). */
	median: number;
}

// ---------------------------------------------------------------------------
// Submission metadata
// ---------------------------------------------------------------------------

/** Dashboard-level submission record. */
export interface SubmissionMeta {
	/** Unique identifier within the current assignment. */
	id: string;
	/** Student ID extracted from filename (e.g., "2026SS_03"). */
	studentId: string;
	/** Assignment this submission belongs to. */
	assignmentId: string;
	/** Semester derived from student ID prefix. */
	semester: string;
	/** Current processing/grading status. */
	status: SubmissionStatus;
	/** Summary of cell comparison: "6 cells, 1 diff". */
	cellSummary?: string;
	/**
	 * True when the stored result carries a VERIFIED clean auto-fix
	 * (autofix.succeeded === 1) — the dashboard badge affordance pointing
	 * the teacher at the original↔fixed toggle. Derived from results.json,
	 * never stored on the record.
	 */
	autofixAvailable?: boolean;
	/** Last execution error message (when status is "error"). */
	error?: string | null;
	/** Teacher's final grade. */
	teacherGrade?: number;
	/**
	 * Deterministic pre-evaluation confidence (see {@link GradingConfidence}),
	 * enriched from the stored pre-eval envelope by GET /api/submissions.
	 * Absent when pre-evaluation has not run (or the envelope predates the
	 * field) — such rows only match the "All" confidence filter.
	 */
	gradingConfidence?: GradingConfidence;
	/**
	 * Advisory over-tick flags (review-diff workflow): categories where the
	 * pipeline checked more items than the cohort norm tolerates (Signal B),
	 * enriched from the stored pre-eval/postProcessed envelope by
	 * GET /api/submissions. Absent when no norm is committed for the
	 * assignment or the submission carries no rubric selections. The flag
	 * never blocks export — it is teacher-review input.
	 */
	overTickCategories?: OverTickCategory[];
	/** ISO timestamp of upload. */
	createdAt: string;
	/** ISO timestamp of last status change. */
	updatedAt: string;
}

// ---------------------------------------------------------------------------
// Submission detail (per-submission page)
// ---------------------------------------------------------------------------

/** Full submission data including cell execution output. */
export interface SubmissionDetail extends SubmissionMeta {
	/** Executed notebook cells — the AUTHENTIC original execution. */
	cells: CellInfo[];
	/**
	 * Verified fixed execution from the automatic autofix stage, aligned by
	 * index. Present only when the pipeline produced a clean re-run; the
	 * original `cells` are never modified (student work stays authentic).
	 */
	fixedCells?: CellInfo[];
	/**
	 * Pre-evaluation comparison + suggestion data. Absent, or
	 * `preEval.markers === null`, means pre-evaluation has not produced
	 * comparison data yet — the review UI keeps its pending/neutral state.
	 */
	preEval?: PreEvalData;
	/**
	 * Advisory over-tick flags (review-diff workflow): full result —
	 * Signal A total flag, Signal B per-category extras, Signal C overlap
	 * note — computed server-side from the committed cohort norms and the
	 * stored pipeline selections. Absent when no norm is committed or the
	 * submission carries no rubric selections.
	 */
	overTick?: OverTickResult;
	/** Reference key cells for comparison (loaded from assignment materials). */
	referenceCells?: CellInfo[];
	/** Persisted grading state (rubric/dimensions/feedback/notes) — from the record. */
	grading?: {
		/** Criterion key -> selected option key (legacy mapping; feedback is authoritative). */
		rubric?: Record<string, string>;
		/** Dimension id -> slider value (points). */
		dimensions?: Record<string, number>;
		/** Per-category feedback: category key -> v2 CategoryFeedback. */
		feedback?: Record<string, CategoryFeedback>;
		/** Free-form teacher notes (autofix notes append here). */
		notes?: string;
		/**
		 * Teacher's per-cell decision on each verified fix: cell index ->
		 * "accepted" | "ignored". The ONLY durable autofix data; view state
		 * (which cells show the fixed version) is never persisted.
		 */
		autofixDispositions?: Record<string, "accepted" | "ignored">;
		/** ISO timestamp of the last grading save. */
		updatedAt?: string;
	};
}
