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
// Cell info
// ---------------------------------------------------------------------------

/** Marker indicating how a student's cell compares to the reference key. */
export type CellMarker =
	/** No comparison data yet — pre-evaluation (Phase 4) has not run. */
	| "pending"
	/** Student used the same method/algorithm as the reference (rare). */
	| "same"
	/** Student solved it differently — neutral, expected (default). */
	| "different"
	/** Student's approach is incorrect or suboptimal. */
	| "questionable"
	/** Cell execution failed. */
	| "error";

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
	/** Error traceback if execution failed. */
	error?: string;
	/** Comparison marker against the reference key. */
	marker: CellMarker;
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
	/** LLM-suggested overall grade from pre-evaluation. */
	preEvalGrade?: number;
	/** Teacher's final grade. */
	teacherGrade?: number;
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
