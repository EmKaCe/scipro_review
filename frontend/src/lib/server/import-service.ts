/**
 * @file Teacher-YAML import service (Phase 3f / 3i).
 *
 * Turns a teacher grading YAML string (the format produced by
 * `export-service.buildGradingYaml`) into a parsed, validated payload and
 * applies it to a submission record + plagiarism cache:
 *
 *   - teacherGrade + status "graded"  (only when teacher_grade is present)
 *   - grading.{dimensions, rubric, feedback, notes} — notes REPLACE the
 *     existing value (the YAML is the authoritative record for the
 *     re-uploaded notebook)
 *   - plagiarism review_status per pair — applied only when the assignment's
 *     cache already contains the pair (absent cache/pair is skipped)
 *
 * This module runs only on the SvelteKit server (`$lib/server/`).
 */

import * as yaml from "js-yaml";

import { isFeedbackMap, isNumberMap, isStringMap } from "$lib/server/grading-validation";
import { saveGrading, upsertSubmission, type SubmissionRecord } from "$lib/server/metadata";
import { updatePairReviewStatus } from "$lib/server/plagiarism/cache";
import type { PairReviewStatus } from "$lib/server/plagiarism/structural";
import type { CategoryFeedback } from "$lib/types/evaluation";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Raised when a teacher-YAML document is missing or malformed. */
export class ImportError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ImportError";
	}
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One plagiarism pair as parsed from the teacher YAML. */
export interface ParsedPlagiarismPair {
	/** The other student id in the flagged pair. */
	studentB: string;
	/** Teacher's per-pair review status. */
	reviewStatus: PairReviewStatus;
}

/** Validated teacher-YAML payload for one submission. */
export interface ParsedTeacherYaml {
	studentId: string;
	assignmentId: string;
	/** Teacher's final grade (points deducted or score). */
	teacherGrade?: number;
	/** Dimension scores: dimension id -> number. */
	scores?: Record<string, number>;
	/** Rubric selections: criterion key -> option key. */
	rubric?: Record<string, string>;
	/** Per-category feedback (v2 CategoryFeedback shape, keyed by category key). */
	feedback?: Record<string, CategoryFeedback>;
	/** Free-form teacher notes. */
	notes?: string;
	/** Per-pair plagiarism review statuses to apply. */
	plagiarism?: ParsedPlagiarismPair[];
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

const REVIEW_STATUSES = new Set<PairReviewStatus>([
	"unreviewed",
	"accepted",
	"dismissed",
	"ignored",
]);

/**
 * Parse and validate a teacher-YAML document (snake_case keys as emitted by
 * `buildGradingYaml`: student_id, assignment, teacher_grade, rubric, scores,
 * notes, feedback, plagiarism with per-pair student_b / review_status).
 *
 * Throws ImportError on any missing or malformed field.
 */
export function parseTeacherYaml(yamlText: string): ParsedTeacherYaml {
	let raw: unknown;
	try {
		raw = yaml.load(yamlText);
	} catch (err) {
		throw new ImportError(`Invalid YAML: ${(err as Error).message}`);
	}
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		throw new ImportError("teacher YAML must be a mapping of fields");
	}
	const doc = raw as Record<string, unknown>;

	const studentId = doc.student_id;
	if (typeof studentId !== "string" || studentId.trim() === "") {
		throw new ImportError('missing or invalid "student_id": expected a non-empty string');
	}
	const assignmentId = doc.assignment;
	if (typeof assignmentId !== "string" || assignmentId.trim() === "") {
		throw new ImportError('missing or invalid "assignment": expected a non-empty string');
	}

	let teacherGrade: number | undefined;
	if (doc.teacher_grade !== undefined) {
		if (typeof doc.teacher_grade !== "number" || !Number.isFinite(doc.teacher_grade)) {
			throw new ImportError('"teacher_grade" must be a finite number');
		}
		teacherGrade = doc.teacher_grade;
	}

	let scores: Record<string, number> | undefined;
	if (doc.scores !== undefined) {
		if (!isNumberMap(doc.scores)) {
			throw new ImportError(
				'"scores" must be an object mapping dimension ids to finite numbers',
			);
		}
		scores = doc.scores;
	}

	let rubric: Record<string, string> | undefined;
	if (doc.rubric !== undefined) {
		if (!isStringMap(doc.rubric)) {
			throw new ImportError(
				'"rubric" must be an object mapping criterion keys to option keys',
			);
		}
		rubric = doc.rubric;
	}

	let feedback: Record<string, CategoryFeedback> | undefined;
	if (doc.feedback !== undefined) {
		if (!isFeedbackMap(doc.feedback)) {
			throw new ImportError(
				'"feedback" must be an object mapping category keys to { checked: string[], comments: Record<string,string>, deductions: Record<string,number>, notes: string }',
			);
		}
		feedback = doc.feedback as Record<string, CategoryFeedback>;
	}

	let notes: string | undefined;
	if (doc.notes !== undefined) {
		if (typeof doc.notes !== "string") {
			throw new ImportError('"notes" must be a string');
		}
		notes = doc.notes;
	}

	let plagiarism: ParsedPlagiarismPair[] | undefined;
	if (doc.plagiarism !== undefined) {
		if (!Array.isArray(doc.plagiarism)) {
			throw new ImportError('"plagiarism" must be a list of pairs');
		}
		plagiarism = doc.plagiarism.map((entry, index) => {
			if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
				throw new ImportError(`plagiarism entry ${index} must be a mapping`);
			}
			const pair = entry as Record<string, unknown>;
			if (typeof pair.student_b !== "string" || pair.student_b.trim() === "") {
				throw new ImportError(
					`plagiarism entry ${index} has invalid "student_b": expected a non-empty string`,
				);
			}
			const reviewStatus = pair.review_status;
			if (
				typeof reviewStatus !== "string" ||
				!REVIEW_STATUSES.has(reviewStatus as PairReviewStatus)
			) {
				throw new ImportError(
					`plagiarism entry ${index} has invalid "review_status": expected one of unreviewed|accepted|dismissed|ignored`,
				);
			}
			return { studentB: pair.student_b, reviewStatus: reviewStatus as PairReviewStatus };
		});
	}

	return { studentId, assignmentId, teacherGrade, scores, rubric, feedback, notes, plagiarism };
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

/**
 * Apply a parsed teacher-YAML payload to a submission record and the
 * plagiarism cache. Creates the record when missing (upsert).
 *
 * Plagiarism review statuses are applied per pair only when the assignment's
 * cache already contains the pair; absent cache/pair is silently skipped
 * (updatePairReviewStatus returns null in that case).
 *
 * Returns the updated submission record.
 */
export async function applyTeacherYaml(
	assignmentId: string,
	studentId: string,
	parsed: ParsedTeacherYaml,
): Promise<SubmissionRecord> {
	await upsertSubmission(assignmentId, studentId, {
		teacherGrade: parsed.teacherGrade,
		status: parsed.teacherGrade !== undefined ? "graded" : undefined,
		error: null,
	});

	const record = await saveGrading(assignmentId, studentId, {
		dimensions: parsed.scores,
		rubric: parsed.rubric,
		feedback: parsed.feedback,
		notes: parsed.notes,
	});

	for (const entry of parsed.plagiarism ?? []) {
		// Null means the cache (or the pair) is absent — skip, never throw.
		await updatePairReviewStatus(assignmentId, studentId, entry.studentB, entry.reviewStatus);
	}

	return record;
}
