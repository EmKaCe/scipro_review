/**
 * @file Grading YAML export for a submission.
 *
 * Builds the teacher-facing grading export from a SubmissionRecord plus its
 * grading state (rubric selections, dimension scores, notes, teacher grade).
 * The YAML shape mirrors the evaluation-output conventions used elsewhere in
 * the app (student_id / assignment / scores), flattened for the submission
 * record:
 *
 *   student_id: 2026SS_03
 *   assignment: soil_contamination
 *   assignment_title: "..."
 *   semester: 2026SS
 *   file_name: 2026SS_03.ipynb
 *   status: graded
 *   teacher_grade: 12
 *   created_at: <ISO>
 *   updated_at: <ISO>
 *   rubric:
 *     <criterion_key>: <selected_option_key>
 *   scores:
 *     <dimension_id>: <number>
 *   notes: |-
 *     <free text>
 *
 * Serialization is a small hand-rolled YAML emitter (no new dependencies):
 * scalars are emitted plain when safe, double-quoted otherwise; notes use a
 * literal block scalar. Only sections that exist on the record are emitted.
 *
 * This module runs only on the SvelteKit server (`$lib/server/`).
 */

import type { SubmissionRecord } from "./metadata";
import type { CategoryFeedback } from "$lib/types/evaluation";

// ---------------------------------------------------------------------------
// Export data
// ---------------------------------------------------------------------------

/** Structured grading export built from a submission record. */
export interface GradingExport {
	/** Student id, e.g. "2026SS_03". */
	studentId: string;
	/** Assignment id, e.g. "soil_contamination". */
	assignmentId: string;
	/** Human-readable assignment title (optional). */
	assignmentTitle?: string;
	/** Semester derived from the student id prefix. */
	semester?: string;
	/** Original uploaded file name. */
	fileName: string;
	/** Submission lifecycle status. */
	status: string;
	/** Teacher's final grade (points deducted or score). */
	teacherGrade?: number;
	/** Rubric selections: criterion key -> selected option key. */
	rubric?: Record<string, string>;
	/** Dimension scores: dimension id -> slider value. */
	scores?: Record<string, number>;
	/** Per-category feedback (v2 CategoryFeedback shape, keyed by category key). */
	feedback?: Record<string, CategoryFeedback>;
	/** Free-form teacher notes. */
	notes?: string;
	/** ISO timestamp of upload. */
	createdAt: string;
	/** ISO timestamp of the last change. */
	updatedAt: string;
}

/** Build the structured export from a submission record. */
export function buildGradingExport(
	record: SubmissionRecord,
	opts: { assignmentTitle?: string } = {},
): GradingExport {
	return {
		studentId: record.studentId,
		assignmentId: record.assignmentId,
		assignmentTitle: opts.assignmentTitle,
		semester: record.semester,
		fileName: record.fileName,
		status: record.status,
		teacherGrade: record.teacherGrade,
		rubric: record.grading?.rubric,
		scores: record.grading?.dimensions,
		feedback: record.grading?.feedback,
		notes: record.grading?.notes,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
	};
}

// ---------------------------------------------------------------------------
// YAML emitter
// ---------------------------------------------------------------------------

/**
 * Serialize a GradingExport to a YAML string.
 *
 * Deterministic, key-ordered, no anchors/aliases. Undefined fields and empty
 * maps are omitted.
 */
export function gradingExportToYaml(data: GradingExport): string {
	const lines: string[] = [];

	pushScalar(lines, "student_id", data.studentId);
	pushScalar(lines, "assignment", data.assignmentId);
	if (data.assignmentTitle !== undefined) {
		pushScalar(lines, "assignment_title", data.assignmentTitle);
	}
	if (data.semester !== undefined) {
		pushScalar(lines, "semester", data.semester);
	}
	pushScalar(lines, "file_name", data.fileName);
	pushScalar(lines, "status", data.status);
	if (data.teacherGrade !== undefined) {
		pushScalar(lines, "teacher_grade", data.teacherGrade);
	}
	pushScalar(lines, "created_at", data.createdAt);
	pushScalar(lines, "updated_at", data.updatedAt);

	if (data.rubric && Object.keys(data.rubric).length > 0) {
		lines.push("rubric:");
		for (const [key, value] of Object.entries(data.rubric)) {
			lines.push(`  ${yamlKey(key)}: ${yamlScalar(value)}`);
		}
	}

	if (data.scores && Object.keys(data.scores).length > 0) {
		lines.push("scores:");
		for (const [key, value] of Object.entries(data.scores)) {
			lines.push(`  ${yamlKey(key)}: ${yamlScalar(value)}`);
		}
	}

	if (data.feedback !== undefined && Object.keys(data.feedback).length > 0) {
		feedbackToYaml(lines, data.feedback);
	}

	if (data.notes !== undefined && data.notes !== "") {
		lines.push("notes: |-");
		for (const line of data.notes.replace(/\r\n/g, "\n").split("\n")) {
			lines.push(line === "" ? "" : `  ${line}`);
		}
	}

	return `${lines.join("\n")}\n`;
}

/** Build the complete grading YAML for a submission record. */
export function buildGradingYaml(
	record: SubmissionRecord,
	opts: { assignmentTitle?: string; plagiarism?: PlagiarismExportSection } = {},
): string {
	let lines = gradingExportToYaml(buildGradingExport(record, opts));
	if (opts.plagiarism && opts.plagiarism.pairs.length > 0) {
		lines += plagiarismToYaml(opts.plagiarism);
	}
	return lines;
}

// ---------------------------------------------------------------------------
// Teacher-only plagiarism audit section
// ---------------------------------------------------------------------------

/** One plagiarism pair as exported in the teacher YAML. */
export interface PlagiarismExportPair {
	/** The other student id in the flagged pair. */
	studentB: string;
	/** "high" | "medium" | "low". */
	severity: string;
	/** Notebook-level similarity in [0, 1]. */
	notebookOverlap: number;
	/** Teacher's per-pair review status. */
	reviewStatus: string;
}

/** Plagiarism audit block attached to the teacher YAML. */
export interface PlagiarismExportSection {
	pairs: PlagiarismExportPair[];
}

/** Serialize the plagiarism audit block (teacher-only; never in student copies). */
function plagiarismToYaml(section: PlagiarismExportSection): string {
	const lines = ["plagiarism:"];
	for (const pair of section.pairs) {
		lines.push(`  - student_b: ${yamlScalar(pair.studentB)}`);
		lines.push(`    severity: ${yamlScalar(pair.severity)}`);
		lines.push(`    notebook_overlap: ${yamlScalar(pair.notebookOverlap)}`);
		lines.push(`    review_status: ${yamlScalar(pair.reviewStatus)}`);
	}
	return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Student-facing export (v2 evaluation-output schema)
// ---------------------------------------------------------------------------

/**
 * Build the student-facing evaluation YAML for a submission record.
 *
 * Uses the v2 evaluation-output schema — the format the student webapp's
 * import flow (`parseImport`) accepts. Teacher-internal fields (status,
 * file_name, timestamps, plagiarism verdicts) are deliberately excluded.
 *
 * `feedback` carries the per-category rubric feedback (v2 CategoryFeedback
 * shape) when present; the v2 parser requires the key, so it is emitted as an
 * empty map when there is nothing to report.
 * Teacher notes are included (top-level `notes`, optional in the schema).
 */
export function buildStudentYaml(
	record: SubmissionRecord,
	_opts: { assignmentTitle?: string } = {},
): string {
	const lines: string[] = [];
	pushScalar(lines, "student_id", record.studentId);
	pushScalar(lines, "assignment", record.assignmentId);
	pushScalar(lines, "reviewer", "SciPro Review");
	pushScalar(lines, "date", (record.updatedAt ?? record.createdAt).slice(0, 10));
	lines.push("scores:");
	const scores = record.grading?.dimensions ?? {};
	if (Object.keys(scores).length === 0) {
		lines.push("  {}");
	} else {
		for (const [key, value] of Object.entries(scores)) {
			lines.push(`  ${yamlKey(key)}: ${yamlScalar(value)}`);
		}
	}
	// `feedback` is required by the v2 parser (`parseYamlImport` rejects YAML
	// without it). Emitted as `feedback: {}` when there is nothing to report.
	feedbackToYaml(lines, record.grading?.feedback);
	const notes = record.grading?.notes;
	if (notes !== undefined && notes !== "") {
		lines.push("notes: |-");
		for (const line of notes.replace(/\r\n/g, "\n").split("\n")) {
			lines.push(line === "" ? "" : `  ${line}`);
		}
	}
	return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Emitter helpers
// ---------------------------------------------------------------------------

/**
 * Emit the v2 `feedback` block: category key -> { checked, comments,
 * deductions, notes }. Only categories with any content are emitted; when
 * nothing has content, `feedback: {}` is emitted (the v2 parser requires
 * the key).
 */
function feedbackToYaml(
	lines: string[],
	feedback: Record<string, CategoryFeedback> | undefined,
): void {
	const entries = Object.entries(feedback ?? {}).filter(([, fb]) => hasFeedbackContent(fb));
	if (entries.length === 0) {
		lines.push("feedback: {}");
		return;
	}
	lines.push("feedback:");
	for (const [key, fb] of entries) {
		lines.push(`  ${yamlKey(key)}:`);
		if (fb.checked.length === 0) {
			lines.push("    checked: []");
		} else {
			lines.push("    checked:");
			for (const item of fb.checked) {
				lines.push(`      - ${yamlScalar(item)}`);
			}
		}
		const comments = Object.entries(fb.comments);
		if (comments.length === 0) {
			lines.push("    comments: {}");
		} else {
			lines.push("    comments:");
			for (const [key, value] of comments) {
				lines.push(`      ${yamlKey(key)}: ${yamlScalar(value)}`);
			}
		}
		const deductions = Object.entries(fb.deductions);
		if (deductions.length === 0) {
			lines.push("    deductions: {}");
		} else {
			lines.push("    deductions:");
			for (const [key, value] of deductions) {
				lines.push(`      ${yamlKey(key)}: ${yamlScalar(value)}`);
			}
		}
		if (fb.notes === "") {
			lines.push('    notes: ""');
		} else {
			lines.push("    notes: |-");
			for (const line of fb.notes.replace(/\r\n/g, "\n").split("\n")) {
				lines.push(line === "" ? "" : `      ${line}`);
			}
		}
	}
}

/** True when a category feedback entry carries anything to report. */
function hasFeedbackContent(fb: CategoryFeedback): boolean {
	return (
		fb.checked.length > 0 ||
		Object.keys(fb.comments).length > 0 ||
		Object.keys(fb.deductions).length > 0 ||
		fb.notes !== ""
	);
}

/** Push a `key: scalar` line for a defined value. */
function pushScalar(lines: string[], key: string, value: string | number): void {
	lines.push(`${yamlKey(key)}: ${yamlScalar(value)}`);
}

/**
 * Emit a map key. Keys are trusted (student ids, assignment ids, criterion
 * keys, dimension ids) but quoted defensively when they contain characters
 * outside the safe plain-scalar set.
 */
function yamlKey(value: string): string {
	return yamlScalar(value);
}

/**
 * Emit a scalar value: plain when it is unambiguously safe, double-quoted
 * otherwise. Double-quoted YAML scalars are JSON strings, so JSON.stringify
 * produces valid YAML.
 */
function yamlScalar(value: string | number): string {
	if (typeof value === "number") {
		if (Number.isFinite(value)) {
			return String(value);
		}
		return JSON.stringify(String(value));
	}
	if (value === "") {
		return '""';
	}
	// Plain style is safe when the value starts with an alphanumeric/underscore,
	// contains no YAML-significant characters, and has no leading/trailing space.
	if (
		/^[A-Za-z0-9_]/.test(value) &&
		/^[A-Za-z0-9_./@()+,\- ]*$/.test(value) &&
		!/:\s|:\s*$|#|^\s|\s$/.test(value)
	) {
		return value;
	}
	return JSON.stringify(value);
}
