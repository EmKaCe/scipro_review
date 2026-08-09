/**
 * @file metadata.json CRUD for submission batches.
 *
 * One metadata.json per assignment, stored at:
 *   <DATA_DIR>/submissions/<assignmentId>/metadata.json
 *
 * The file holds a record per studentId (the batch's submission index) with
 * lifecycle status, timestamps, and grading state. Written atomically
 * (temp file + rename) so concurrent API requests never observe a torn file.
 *
 * Environment:
 *   DATA_DIR — data root (default: ./data, i.e. /app/data in Docker)
 *
 * This module runs only on the SvelteKit server (`$lib/server/`).
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { SubmissionStatus } from "$lib/types/submissions";
import type { CategoryFeedback } from "$lib/types/evaluation";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Teacher grading state for one submission (rubric + dimension sliders). */
export interface GradingState {
	/** Rubric selections: criterion key -> selected option key. */
	rubric: Record<string, string>;
	/** Dimension scores: dimension id -> slider value (points deducted). */
	dimensions: Record<string, number>;
	/** Per-category feedback (v2 CategoryFeedback shape, keyed by category key). */
	feedback?: Record<string, CategoryFeedback>;
	/** Free-form teacher notes (Generate button output). */
	notes?: string;
	/**
	 * Teacher's per-cell decision on each verified auto-fix: cell index ->
	 * "accepted" | "ignored". The only durable autofix data (view state —
	 * which cells show the fixed version — is never persisted).
	 */
	autofixDispositions?: Record<string, "accepted" | "ignored">;
	/** ISO timestamp of the last grading change. */
	updatedAt: string;
}

/** Persistent record for one submission within an assignment batch. */
export interface SubmissionRecord {
	/** Unique id within the assignment — the studentId. */
	id: string;
	studentId: string;
	assignmentId: string;
	/** Semester derived from the student ID prefix, e.g. "2026SS". */
	semester: string;
	/** Original uploaded file name. */
	fileName: string;
	/** Notebook path relative to DATA_DIR, e.g. "submissions/soil/2026SS_03.ipynb". */
	notebookPath: string;
	status: SubmissionStatus;
	/** Summary of cell comparison, e.g. "6 cells, 1 diff". */
	cellSummary?: string;
	/** Teacher's final grade (points deducted or score — set by grade endpoint). */
	teacherGrade?: number;
	/** Last execution error summary (when status is "error"). */
	error?: string | null;
	grading?: GradingState;
	/** Pre-archive status — set by archiveSubmission, cleared on restore. */
	archivedFrom?: SubmissionStatus;
	/** ISO timestamp of upload. */
	createdAt: string;
	/** ISO timestamp of the last change. */
	updatedAt: string;
}

/** metadata.json contents — a map keyed by studentId. */
export type MetadataFile = Record<string, SubmissionRecord>;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class MetadataError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MetadataError";
	}
}

// ---------------------------------------------------------------------------
// Status transitions
// ---------------------------------------------------------------------------

/**
 * Allowed lifecycle transitions. Lifecycle: pending -> executing ->
 * executed | error; grading finalizes executed -> graded. Re-runs are allowed
 * from error/executed back to executing.
 */
export const STATUS_TRANSITIONS: Record<SubmissionStatus, SubmissionStatus[]> = {
	pending: ["executing", "archived"],
	executing: ["executed", "error", "archived"],
	executed: ["graded", "executing", "error", "archived"],
	error: ["executing", "archived"],
	"pre-evaluated": ["graded", "executing", "archived"],
	graded: ["executing", "archived"],
	// Archived records keep their prior status for restore — the caller
	// passes the status to return to (e.g. "executed" or "graded").
	archived: ["pending", "executing", "executed", "error", "pre-evaluated", "graded"],
};

const VALID_STATUSES = new Set<SubmissionStatus>(
	Object.keys(STATUS_TRANSITIONS) as SubmissionStatus[],
);

// ---------------------------------------------------------------------------
// Paths & safety
// ---------------------------------------------------------------------------

export function getDataDir(): string {
	if (typeof process !== "undefined" && process.env && process.env.DATA_DIR) {
		return process.env.DATA_DIR;
	}
	// Vitest sets VITEST=true; tests must always use an explicit temp DATA_DIR
	// so audit/memory writes can never land in the real ./data tree.
	if (typeof process !== "undefined" && process.env?.VITEST) {
		throw new MetadataError(
			"DATA_DIR must be set explicitly when running under vitest (tests write only to temp dirs)",
		);
	}
	return path.resolve("./data");
}

/** Reject path segments that could escape the data dir (traversal guard). */
export function assertSafeSegment(value: string, label: string): void {
	if (!value || value === "." || value === "..") {
		throw new MetadataError(`Invalid ${label}: "${value}"`);
	}
	if (/[/\\\0]/.test(value)) {
		throw new MetadataError(`Invalid ${label}: must be a single path segment, got "${value}"`);
	}
}

export function getMetadataPath(assignmentId: string): string {
	assertSafeSegment(assignmentId, "assignmentId");
	return path.join(getDataDir(), "submissions", assignmentId, "metadata.json");
}

// ---------------------------------------------------------------------------
// Read / write
// ---------------------------------------------------------------------------

/** Read the batch metadata file; returns {} when no file exists yet. */
export async function readMetadata(assignmentId: string): Promise<MetadataFile> {
	const filePath = getMetadataPath(assignmentId);
	let raw: string;
	try {
		raw = await readFile(filePath, "utf-8");
	} catch (err) {
		if (isNodeError(err) && err.code === "ENOENT") {
			return {};
		}
		throw err;
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new MetadataError(`metadata.json for "${assignmentId}" is not an object`);
		}
		return parsed as MetadataFile;
	} catch (err) {
		if (err instanceof MetadataError) throw err;
		throw new MetadataError(
			`metadata.json for "${assignmentId}" is corrupt: ${(err as Error).message}`,
		);
	}
}

/** Atomically persist the batch metadata file (temp file + rename). */
export async function writeMetadata(assignmentId: string, records: MetadataFile): Promise<void> {
	const filePath = getMetadataPath(assignmentId);
	await mkdir(path.dirname(filePath), { recursive: true });
	const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
	await writeFile(tmpPath, JSON.stringify(records, null, 2), "utf-8");
	await rename(tmpPath, filePath);
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/** List all submission records for an assignment, sorted by studentId. */
export async function listSubmissions(assignmentId: string): Promise<SubmissionRecord[]> {
	const records = await readMetadata(assignmentId);
	return Object.values(records).sort((a, b) => a.studentId.localeCompare(b.studentId));
}

/** Get a single submission record, or null when absent. */
export async function getSubmission(
	assignmentId: string,
	studentId: string,
): Promise<SubmissionRecord | null> {
	assertSafeSegment(studentId, "studentId");
	const records = await readMetadata(assignmentId);
	return records[studentId] ?? null;
}

/**
 * Create or merge a submission record.
 *
 * `patch` is merged over the existing record (or a fresh one). Timestamps are
 * managed here: createdAt is preserved on merge, updatedAt is always refreshed.
 * A new record defaults to status "pending" unless `patch.status` is given.
 */
export async function upsertSubmission(
	assignmentId: string,
	studentId: string,
	patch: Partial<
		Omit<SubmissionRecord, "id" | "studentId" | "assignmentId" | "createdAt" | "updatedAt">
	> = {},
): Promise<SubmissionRecord> {
	assertSafeSegment(assignmentId, "assignmentId");
	assertSafeSegment(studentId, "studentId");

	const records = await readMetadata(assignmentId);
	const existing = records[studentId];
	const now = new Date().toISOString();

	const record: SubmissionRecord = {
		...existing,
		id: studentId,
		studentId,
		assignmentId,
		createdAt: existing?.createdAt ?? now,
		...patch,
		status: patch.status ?? existing?.status ?? "pending",
		updatedAt: now,
	};

	// Guard: an explicit status must be valid.
	if (!VALID_STATUSES.has(record.status)) {
		throw new MetadataError(`Invalid submission status: "${record.status}"`);
	}

	records[studentId] = record;
	await writeMetadata(assignmentId, records);
	return record;
}

/**
 * Transition a submission's status, enforcing the allowed-transition map.
 * Pass `opts.force` to bypass validation (e.g. initial record creation).
 */
export async function updateStatus(
	assignmentId: string,
	studentId: string,
	status: SubmissionStatus,
	opts: { force?: boolean } = {},
): Promise<SubmissionRecord> {
	if (!VALID_STATUSES.has(status)) {
		throw new MetadataError(`Invalid submission status: "${status}"`);
	}

	const records = await readMetadata(assignmentId);
	const existing = records[studentId];
	if (!existing) {
		throw new MetadataError(
			`Submission "${studentId}" not found in assignment "${assignmentId}"`,
		);
	}

	const allowed = STATUS_TRANSITIONS[existing.status];
	if (!opts.force && !allowed.includes(status)) {
		throw new MetadataError(
			`Invalid status transition for "${studentId}": ${existing.status} -> ${status}` +
				` (allowed: ${allowed.join(", ")})`,
		);
	}

	const now = new Date().toISOString();
	const record: SubmissionRecord = { ...existing, status, updatedAt: now };
	records[studentId] = record;
	await writeMetadata(assignmentId, records);
	return record;
}

/**
 * Persist grading state (rubric selections + dimension scores) for a
 * submission. Merges into the existing grading object; bumps timestamps.
 */
export async function saveGrading(
	assignmentId: string,
	studentId: string,
	grading: Partial<Omit<GradingState, "updatedAt">>,
): Promise<SubmissionRecord> {
	const records = await readMetadata(assignmentId);
	const existing = records[studentId];
	if (!existing) {
		throw new MetadataError(
			`Submission "${studentId}" not found in assignment "${assignmentId}"`,
		);
	}

	const now = new Date().toISOString();
	const record: SubmissionRecord = {
		...existing,
		grading: {
			rubric: { ...(existing.grading?.rubric ?? {}), ...(grading.rubric ?? {}) },
			dimensions: { ...(existing.grading?.dimensions ?? {}), ...(grading.dimensions ?? {}) },
			feedback: { ...(existing.grading?.feedback ?? {}), ...(grading.feedback ?? {}) },
			notes: grading.notes ?? existing.grading?.notes,
			autofixDispositions: {
				...(existing.grading?.autofixDispositions ?? {}),
				...(grading.autofixDispositions ?? {}),
			},
			updatedAt: now,
		},
		updatedAt: now,
	};
	records[studentId] = record;
	await writeMetadata(assignmentId, records);
	return record;
}

/** Remove a submission record from the batch metadata. Returns false when absent. */
export async function removeSubmission(assignmentId: string, studentId: string): Promise<boolean> {
	assertSafeSegment(studentId, "studentId");
	const records = await readMetadata(assignmentId);
	if (!records[studentId]) {
		return false;
	}
	delete records[studentId];
	await writeMetadata(assignmentId, records);
	return true;
}

/**
 * Reset a submission's grading progress: clears rubric/dimensions/feedback/
 * notes and the final grade, reverting the status to "executed". This is a
 * teacher-initiated admin reset — deliberately not a lifecycle transition
 * (graded -> executed is not in STATUS_TRANSITIONS).
 */
export async function resetSubmission(
	assignmentId: string,
	studentId: string,
): Promise<SubmissionRecord> {
	assertSafeSegment(studentId, "studentId");
	const records = await readMetadata(assignmentId);
	const existing = records[studentId];
	if (!existing) {
		throw new MetadataError(
			`Submission "${studentId}" not found in assignment "${assignmentId}"`,
		);
	}
	const now = new Date().toISOString();
	const record: SubmissionRecord = {
		...existing,
		status: "executed",
		teacherGrade: undefined,
		grading: { rubric: {}, dimensions: {}, updatedAt: now },
		updatedAt: now,
	};
	records[studentId] = record;
	await writeMetadata(assignmentId, records);
	return record;
}

/**
 * Soft-archive a submission: set status "archived" and remember the
 * pre-archive status on the record so a later restore can return to it.
 */
export async function archiveSubmission(
	assignmentId: string,
	studentId: string,
): Promise<SubmissionRecord> {
	const records = await readMetadata(assignmentId);
	const existing = records[studentId];
	if (!existing) {
		throw new MetadataError(
			`Submission "${studentId}" not found in assignment "${assignmentId}"`,
		);
	}
	const archivedFrom = existing.status;
	const record = await updateStatus(assignmentId, studentId, "archived");
	const fresh = await readMetadata(assignmentId);
	fresh[studentId] = { ...record, archivedFrom };
	await writeMetadata(assignmentId, fresh);
	return fresh[studentId]!;
}

/**
 * Restore an archived submission to its pre-archive status (or an explicit
 * target). Clears `archivedFrom`. Returns the updated record.
 */
export async function restoreSubmission(
	assignmentId: string,
	studentId: string,
	target?: SubmissionStatus,
): Promise<SubmissionRecord> {
	const records = await readMetadata(assignmentId);
	const existing = records[studentId];
	if (!existing) {
		throw new MetadataError(
			`Submission "${studentId}" not found in assignment "${assignmentId}"`,
		);
	}
	const status: SubmissionStatus = target ?? existing.archivedFrom ?? "pending";
	const record = await updateStatus(assignmentId, studentId, status, { force: true });
	const fresh = await readMetadata(assignmentId);
	fresh[studentId] = { ...record, archivedFrom: undefined };
	await writeMetadata(assignmentId, fresh);
	return fresh[studentId]!;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
	return err instanceof Error && "code" in err;
}
