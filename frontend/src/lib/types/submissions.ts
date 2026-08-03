/**
 * @file Teacher-facing submission, cell, and status types for the grading dashboard.
 *
 * These types define the data shapes used by the submissions dashboard,
 * per-submission review page, and stub data service.
 *
 * Phase 2: Stub data from submissions-store.ts.
 * Phase 3: Real data from API routes, executed notebook output.
 * Phase 4: LLM pre-evaluation data enriches existing types.
 */

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/** Lifecycle status of a submission within a grading batch. */
export type SubmissionStatus =
	"pending" | "executing" | "executed" | "error" | "pre-evaluated" | "graded";

// ---------------------------------------------------------------------------
// Cell info
// ---------------------------------------------------------------------------

/** Marker indicating how a student's cell compares to the reference key. */
export type CellMarker =
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
	/** Last execution error message (when status is "error"). */
	error?: string | null;
	/** LLM-suggested overall grade (Phase 4). */
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
	/** Executed notebook cells. */
	cells: CellInfo[];
	/** Reference key cells for comparison (loaded from assignment materials). */
	referenceCells?: CellInfo[];
	/** Persisted grading state (rubric/dimensions/notes) — from the record. */
	grading?: {
		/** Free-form teacher notes (autofix notes append here). */
		notes?: string;
	};
}
