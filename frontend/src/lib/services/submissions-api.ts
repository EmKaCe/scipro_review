/**
 * @file Typed client for the teacher submissions API (Phase 3f.1).
 *
 * Thin wrapper around fetch() for every /api endpoint the frontend talks to.
 * Methods return the API JSON shapes as-is — translation into UI models
 * happens in the consuming store/components. Non-2xx responses and network
 * failures are mapped to {@link ApiError} (status + message), extracting the
 * `{ message }` body SvelteKit's `error()` helper produces.
 *
 * @see frontend/src/routes/api/submissions — route implementations
 * @see frontend/src/lib/types/submissions.ts — frontend data shapes
 */

import type { SubmissionDetail, SubmissionMeta } from "$lib/types/submissions.js";

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/**
 * A failed API call: either a non-2xx HTTP response (status 400-599, message
 * from the error body) or a network-level failure (status 0).
 */
export class ApiError extends Error {
	/** HTTP status code; 0 for network failures (server unreachable). */
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = "ApiError";
		this.status = status;
	}
}

// ---------------------------------------------------------------------------
// Wire types (API JSON shapes)
// ---------------------------------------------------------------------------

/** Per-file classification produced by the upload endpoint. */
export type UploadKind = "submission" | "material-data" | "material-file";

/** One persisted file entry in the upload response. */
export interface SubmissionUploadResult {
	fileName: string;
	kind: UploadKind;
	replaced: boolean;
	bytes: number;
	/** Present for submission-kind files. */
	studentId?: string;
	/** Present for submission-kind files. */
	semester?: string;
	/** Present for submission-kind files. */
	notebookPath?: string;
	/** Present for material-kind files. */
	relativePath?: string;
}

/** POST /api/submissions/upload response. */
export interface UploadResponse {
	assignmentId: string;
	results: SubmissionUploadResult[];
}

/** One per-submission entry in the batch process response. */
export interface BatchItemResult {
	studentId: string;
	success: boolean;
	error: string | null;
}

/** POST /api/submissions/process response. */
export interface BatchProcessResponse {
	assignmentId: string;
	submitted: number;
	succeeded: number;
	failed: number;
	totalDurationSeconds: number;
	results: BatchItemResult[];
}

/** Grading patch accepted by POST /api/submissions/[id]/save (all optional). */
export interface GradingPatch {
	/** Criterion key -> selected option key. */
	rubric?: Record<string, string>;
	/** Dimension id -> slider value (points deducted). */
	dimensions?: Record<string, number>;
	/** Free-form teacher notes. */
	notes?: string;
}

/** Executor cell in wire form (snake_case) as returned by process endpoints. */
export interface ExecutorWireCell {
	cell_index: number;
	execution_count: number | null;
	source: string;
	output_text: string;
	error: string | null;
	traceback: string[] | null;
}

/** Preprocessing summary attached to execution results. */
export interface PreprocessingSummary {
	cellsModified: number;
	totalEdits: number;
	editTypes: Record<string, number>;
	llmPreprocessing: "completed" | "skipped" | "error";
	llmAnalysis: boolean;
	/** Per-cell edit lists (present when the executor reports them). */
	cellEdits?: Record<
		number,
		Array<{ editType: string; note: string; oldText?: string; newText?: string }>
	>;
}

/** POST /api/submissions/[id]/process response: execution result + updated record. */
export interface SubmissionExecution {
	success: boolean;
	notebookPath: string;
	/** Wire-shaped cells; the detail endpoint translates them to CellInfo[]. */
	cells: ExecutorWireCell[];
	totalCells: number;
	executedCells: number;
	errorCells: number;
	durationSeconds: number;
	preprocessing: PreprocessingSummary;
	modifiedFiles: string[];
	/** Updated submission record after the run. */
	record: SubmissionMeta;
}

/** GET /api/submissions/[id]/export response, parsed for the frontend. */
export interface SubmissionExport {
	/** Content-Disposition filename, e.g. "2026SS_03.yaml". */
	fileName: string;
	/** YAML grading document body. */
	content: string;
}

/** Assignment summary as exposed by GET /api/assignments. */
export interface AssignmentSummary {
	id: string;
	title: string;
	enabled: boolean;
	criteria_files: string[];
}

/** GET /api/assignments response. */
export interface AssignmentsResponse {
	assignments: AssignmentSummary[];
}

/**
 * One matched cell pair (similarity >= threshold) in a plagiarism result.
 */
export interface PlagiarismMatchedCell {
	cellIndexA: number;
	cellIndexB: number;
	/** Jaccard similarity of the two cells' n-gram sets, 0..1. */
	similarity: number;
}

/** Structural overlap details for one flagged pair. */
export interface PlagiarismPairDetails {
	/** |cellCountA - cellCountB|. */
	cellCountDiff: number;
	sharedVariableNames: string[];
	sharedComments: string[];
	sharedImports: string[];
}

/**
 * One compared pair of submissions. `cellOverlap` / `notebookOverlap` are
 * the structural scores; `semanticScore` / `semanticVerdict` are filled in
 * by the KI Connect pass (absent when not run).
 */
export interface PlagiarismPair {
	/** Canonical ordering: studentA < studentB. */
	studentA: string;
	studentB: string;
	/** 0..1 — fraction of the smaller notebook's cells with a match. */
	cellOverlap: number;
	/** 0..1 — Jaccard of whole-notebook token n-gram sets. */
	notebookOverlap: number;
	/** Matched cell pairs, sorted by similarity desc. */
	matchedCells: PlagiarismMatchedCell[];
	/** e.g. ["shared_imports", "shared_variables", "shared_comments"]. */
	flags: string[];
	details: PlagiarismPairDetails;
	/** 0..1 — semantic score from the KI Connect pass (optional). */
	semanticScore?: number;
	/** Verdict text from the KI Connect pass (optional). */
	semanticVerdict?: string;
}

/** Cached plagiarism comparison for one assignment. */
export interface PlagiarismResult {
	status: "pending" | "checking" | "done" | "error";
	assignmentId: string;
	/** ISO timestamp of the check run. */
	generatedAt: string;
	/** Flagged pairs, sorted by cellOverlap descending. */
	pairs: PlagiarismPair[];
	/** Total number of unique pairs compared (flagged + below threshold). */
	totalPairs: number;
	/** studentIds included in the comparison, sorted. */
	comparedSubmissions: string[];
	/** True when the semantic (LLM) pass ran and produced scores. */
	semanticChecked?: boolean;
	/** Error detail when status is "error". */
	error?: string;
}

/** Optional knobs for POST /api/plagiarism/check. */
export interface PlagiarismCheckOptions {
	/** Also run the KI Connect semantic pass on flagged pairs. */
	semantic?: boolean;
	/** Token n-gram size for the structural pass, 2–5 (default 3). */
	ngramSize?: number;
}

// ---------------------------------------------------------------------------
// Request plumbing
// ---------------------------------------------------------------------------

/** Append the ?assignment= query param the routes use to resolve the batch. */
function withAssignment(path: string, assignmentId?: string): string {
	if (assignmentId === undefined || assignmentId === "") {
		return path;
	}
	const sep = path.includes("?") ? "&" : "?";
	return `${path}${sep}assignment=${encodeURIComponent(assignmentId)}`;
}

/** GET/POST a JSON endpoint; throws ApiError on failure or non-2xx. */
async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
	const response = await requestRaw(path, init);
	return (await response.json()) as T;
}

/** GET an endpoint returning a plain-text body (e.g. the YAML export). */
async function requestText(path: string, init?: RequestInit): Promise<string> {
	const response = await requestRaw(path, init);
	return response.text();
}

async function requestRaw(path: string, init?: RequestInit): Promise<Response> {
	let response: Response;
	try {
		response = await fetch(path, init);
	} catch (err) {
		throw new ApiError(0, err instanceof Error ? err.message : String(err));
	}
	if (!response.ok) {
		throw new ApiError(response.status, await errorMessage(response));
	}
	return response;
}

/** Extract the `{ message }` body SvelteKit errors produce; fallback text otherwise. */
async function errorMessage(response: Response): Promise<string> {
	try {
		const body = (await response.json()) as { message?: unknown };
		if (typeof body.message === "string" && body.message.length > 0) {
			return body.message;
		}
	} catch {
		// Non-JSON error body — fall through to the generic message.
	}
	return `Request failed with status ${response.status}`;
}

// ---------------------------------------------------------------------------
// Submissions
// ---------------------------------------------------------------------------

/** GET /api/submissions — list submissions for the (optional) assignment. */
export async function fetchSubmissions(assignmentId?: string): Promise<{
	assignmentId: string;
	submissions: SubmissionMeta[];
}> {
	return requestJson<{ assignmentId: string; submissions: SubmissionMeta[] }>(
		withAssignment("/api/submissions", assignmentId),
	);
}

/** GET /api/submissions/[id] — full detail for one submission. */
export async function fetchSubmission(
	id: string,
	assignmentId?: string,
): Promise<SubmissionDetail> {
	return requestJson<SubmissionDetail>(
		withAssignment(`/api/submissions/${encodeURIComponent(id)}`, assignmentId),
	);
}

/** POST /api/submissions/upload — multipart upload with optional kind overrides. */
export async function uploadSubmissions(
	files: File[],
	assignmentId: string,
	kinds?: Record<string, UploadKind>,
): Promise<UploadResponse> {
	const form = new FormData();
	for (const file of files) {
		form.append("files", file);
	}
	form.append("assignmentId", assignmentId);
	if (kinds !== undefined) {
		form.append("kinds", JSON.stringify(kinds));
	}
	return requestJson<UploadResponse>("/api/submissions/upload", {
		method: "POST",
		body: form,
	});
}

/** POST /api/submissions/process — batch-execute (pending) submissions. */
export async function processSubmissions(
	ids?: string[],
	assignmentId?: string,
): Promise<BatchProcessResponse> {
	const body: Record<string, unknown> = {};
	if (assignmentId !== undefined) {
		body.assignmentId = assignmentId;
	}
	if (ids !== undefined && ids.length > 0) {
		body.ids = ids;
	}
	return requestJson<BatchProcessResponse>("/api/submissions/process", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

/** POST /api/submissions/[id]/process — execute a single submission. */
export async function processSubmission(
	id: string,
	assignmentId?: string,
): Promise<SubmissionExecution> {
	return requestJson<SubmissionExecution>(
		withAssignment(`/api/submissions/${encodeURIComponent(id)}/process`, assignmentId),
		{ method: "POST" },
	);
}

/** POST /api/submissions/[id]/save — persist grading state (rubric/dimensions/notes). */
export async function saveGrading(
	id: string,
	grading: GradingPatch,
	assignmentId?: string,
): Promise<SubmissionMeta> {
	return requestJson<SubmissionMeta>(
		withAssignment(`/api/submissions/${encodeURIComponent(id)}/save`, assignmentId),
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(grading),
		},
	);
}

/** POST /api/submissions/[id]/grade — finalize the teacher grade. */
export async function gradeSubmission(
	id: string,
	teacherGrade: number,
	assignmentId?: string,
): Promise<SubmissionMeta> {
	return requestJson<SubmissionMeta>(
		withAssignment(`/api/submissions/${encodeURIComponent(id)}/grade`, assignmentId),
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ teacherGrade }),
		},
	);
}

/** GET /api/submissions/[id]/export — download the grading YAML document. */
export async function exportSubmission(
	id: string,
	assignmentId?: string,
): Promise<SubmissionExport> {
	const url = withAssignment(`/api/submissions/${encodeURIComponent(id)}/export`, assignmentId);
	const content = await requestText(url);
	// The route names the attachment <studentId>.yaml; the caller only knows
	// the id, so reuse it for the frontend-facing file name.
	return { fileName: `${id}.yaml`, content };
}

// ---------------------------------------------------------------------------
// Assignments
// ---------------------------------------------------------------------------

/** GET /api/assignments — list enabled assignments. */
export async function fetchAssignments(): Promise<AssignmentsResponse> {
	return requestJson<AssignmentsResponse>("/api/assignments");
}

// ---------------------------------------------------------------------------
// Plagiarism
// ---------------------------------------------------------------------------

/** POST /api/plagiarism/check — run a batch plagiarism comparison. */
export async function checkPlagiarism(
	assignmentId?: string,
	options?: PlagiarismCheckOptions,
): Promise<PlagiarismResult> {
	const body: Record<string, unknown> = {};
	if (assignmentId !== undefined) {
		body.assignmentId = assignmentId;
	}
	if (options?.semantic !== undefined) {
		body.semantic = options.semantic;
	}
	if (options?.ngramSize !== undefined) {
		body.ngramSize = options.ngramSize;
	}
	return requestJson<PlagiarismResult>("/api/plagiarism/check", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

/** GET /api/plagiarism/results — fetch the cached comparison (404 when none). */
export async function fetchPlagiarismResults(assignmentId?: string): Promise<PlagiarismResult> {
	const query =
		assignmentId === undefined || assignmentId === ""
			? ""
			: `?assignmentId=${encodeURIComponent(assignmentId)}`;
	return requestJson<PlagiarismResult>(`/api/plagiarism/results${query}`);
}
