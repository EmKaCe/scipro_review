/**
 * @file Typed client for the teacher submissions API.
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

import type { SubmissionDetail, SubmissionMeta, CellInfo } from "$lib/types/submissions.js";
import type { CategoryFeedback } from "$lib/types/evaluation.js";
import type { CriteriaFile } from "$lib/types/criteria.js";

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
	/** Error message when this file failed to persist (per-file failure). */
	error?: string;
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
	/** Automatic autofix re-runs across the whole run. */
	autofixAttempts: number;
	/** Autofix re-runs that finished without an error. */
	autofixSucceeded: number;
	results: BatchItemResult[];
}

/** One per-submission outcome row in POST /api/submissions/pre-evaluate. */
export interface PreEvaluateRow {
	studentId: string;
	ok: boolean;
	/** Set when the row failed; failures never abort the loop. */
	error: string | null;
}

/** POST /api/submissions/pre-evaluate response. */
export interface PreEvaluateBatchResponse {
	assignmentId: string;
	submitted: number;
	succeeded: number;
	failed: number;
	totalDurationSeconds: number;
	results: PreEvaluateRow[];
}

/** Completed pre-evaluation run tallies (log panel run-complete banner). */
export interface PreEvalRunSummary {
	submitted: number;
	succeeded: number;
	failed: number;
}

/** Live progress of the current batch run (GET /api/submissions/process/status). */
export interface ProcessProgress {
	/** True while a batch process run is in flight. */
	running: boolean;
	assignmentId: string | null;
	/** Epoch ms when the run started. */
	startedAt: number | null;
	/** Student id of the notebook currently being executed. */
	currentStudentId: string | null;
	/** Epoch ms when the current notebook started executing. */
	currentStartedAt: number | null;
	/** Notebooks settled (executed or error). */
	done: number;
	/** Total notebooks targeted by the run. */
	total: number;
	/** Automatic autofix re-runs attempted across the whole run. */
	autofixAttempts: number;
	/** Autofix re-runs that finished without an error. */
	autofixSucceeded: number;
}

/** Which pipeline stage produced a log line (filter key in the log panel). */
export type PipelineLogSource = "executor" | "pre-eval";

/**
 * One captured pipeline log line. Executor lines come from GET
 * /api/executor/logs (no `source` — defaults to "executor"); pre-evaluation
 * lines come from GET /api/submissions/pre-evaluate/logs and carry the
 * `source: "pre-eval"` tag plus the per-submission detail fields.
 */
export interface ExecutorLogEntry {
	id: number | string;
	ts: number;
	level: string;
	logger: string;
	message: string;
	/** Producer of the line; executor entries omit it (legacy wire shape). */
	source?: PipelineLogSource;
	/** Pre-eval only: submission the entry refers to. */
	submissionId?: string;
	/** Pre-eval only: suggested grade scores, dimension id -> points. */
	grades?: Record<string, number>;
	/** Pre-eval only: number of cell comparison markers produced. */
	markerCount?: number;
	/** Pre-eval only: number of rubric sub-point selections produced. */
	selectionCount?: number;
	/** Pre-eval only: the rubric sub-point selections (categoryKey + optionKey). */
	rubricSelections?: { categoryKey: string; optionKey: string }[];
	/** Pre-eval only: true when the row pre-evaluated successfully. */
	ok?: boolean;
}

/** GET /api/executor/logs response. */
export interface ExecutorLogsResponse {
	entries: ExecutorLogEntry[];
	truncated: boolean;
}

/** GET /api/submissions/pre-evaluate/logs response (pre-eval entries only). */
export interface PreEvalLogsResponse {
	entries: ExecutorLogEntry[];
	truncated: boolean;
}

/** Live progress of the current pre-evaluation run (GET …/pre-evaluate/status). */
export interface PreEvalProgress {
	/** True while a batch pre-evaluation run is in flight. */
	running: boolean;
	assignmentId: string | null;
	/** Epoch ms when the run started. */
	startedAt: number | null;
	/** Student id of the submission most recently started (concurrency 2). */
	currentStudentId: string | null;
	/** Epoch ms when that submission's pre-evaluation started. */
	currentStartedAt: number | null;
	/** Submissions settled (pre-evaluated or failed). */
	done: number;
	/** Total submissions targeted by the run. */
	total: number;
	/** Submissions that produced a persisted pre-evaluation envelope. */
	succeeded: number;
	/** Submissions that failed (prior status kept). */
	failed: number;
}

/** Grading patch accepted by POST /api/submissions/[id]/save (all optional). */
export interface GradingPatch {
	/** Criterion key -> selected option key. */
	rubric?: Record<string, string>;
	/** Dimension id -> slider value (points deducted). */
	dimensions?: Record<string, number>;
	/** Per-category feedback: category key -> v2 CategoryFeedback. */
	feedback?: Record<string, CategoryFeedback>;
	/** Free-form teacher notes. */
	notes?: string;
	/**
	 * Teacher's per-cell decision on each verified auto-fix: cell index ->
	 * "accepted" | "ignored". The only durable autofix data.
	 */
	autofixDispositions?: Record<string, "accepted" | "ignored">;
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

/**
 * Pre-evaluation data attached to the submission detail wire shape
 * (camelCase): `preEval: { markers, gradeSuggestion, feedbackDraft,
 * notebookSummary, evaluatedAt }`. Types are declared next to the other cell
 * marker types in `$lib/types/submissions` and re-exported here so the API
 * contract is documented alongside the other wire types; the server-side
 * producer is `$lib/server/copilot/pre-evaluation.ts`.
 *
 * `markers: null` means no comparison data — clients keep their
 * pending/neutral state and never default non-error cells to "different".
 */
export type {
	PreEvalCellVerdict,
	PreEvalData,
	PreEvalGradeSuggestion,
	PreEvalMarker,
} from "$lib/types/submissions.js";

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
	/** Optional per-assignment scoring config (data/scoring/<id>.yaml). */
	scoring_file?: string;
}

/** GET /api/assignments response. */
export interface AssignmentsResponse {
	assignments: AssignmentSummary[];
}

/** Materials state as exposed by GET /api/assignments/[id]/materials. */
export interface MaterialsStatus {
	assignmentId: string;
	hasPdf: boolean;
	hasKey: boolean;
	hasInputData: boolean;
	files: Array<{
		name: string;
		kind: "material-file" | "material-data";
		relativePath: string;
	}>;
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

/** Teacher review state of a plagiarism pair (P3-1, per-pair). */
export type PairReviewStatus = "unreviewed" | "accepted" | "dismissed" | "ignored";

/** Resolve a pair's review status, defaulting absent values to "unreviewed". */
export function pairReviewStatus(pair: PlagiarismPair): PairReviewStatus {
	return pair.reviewStatus ?? "unreviewed";
}

/** Severity classification for a pair (mirrors the server's thresholds). */
export type PairSeverity = "high" | "medium" | "low" | "none";

/** Classify a pair: high ≥ 60% cell overlap, flagged = medium, ≥ 15% = low. */
export function pairSeverity(pair: PlagiarismPair): PairSeverity {
	if (pair.cellOverlap >= 0.6) return "high";
	if (pair.cellOverlap >= 0.35 || pair.notebookOverlap >= 0.5) return "medium";
	if (pair.cellOverlap >= 0.15) return "low";
	return "none";
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
	/** Teacher review state (absent = "unreviewed"). */
	reviewStatus?: PairReviewStatus;
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
export async function fetchSubmissions(
	assignmentId?: string,
	includeArchived = false,
): Promise<{
	assignmentId: string;
	submissions: SubmissionMeta[];
}> {
	const base = withAssignment("/api/submissions", assignmentId);
	const url = includeArchived
		? `${base}${base.includes("?") ? "&" : "?"}includeArchived=1`
		: base;
	return requestJson<{ assignmentId: string; submissions: SubmissionMeta[] }>(url);
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

/**
 * POST /api/submissions/pre-evaluate — batch pre-evaluate the executed/error
 * rows of the assignment (one KI Connect call per row). Throws ApiError with
 * status 409 when another pre-evaluation run is already in flight.
 */
export async function preEvaluateSubmissions(
	assignmentId: string,
): Promise<PreEvaluateBatchResponse> {
	return requestJson<PreEvaluateBatchResponse>(
		`/api/submissions/pre-evaluate?assignment=${encodeURIComponent(assignmentId)}`,
		{ method: "POST" },
	);
}

/** GET /api/submissions/process/status — live progress of the current batch. */
export async function fetchProcessStatus(): Promise<ProcessProgress> {
	return requestJson<ProcessProgress>("/api/submissions/process/status");
}

/** GET /api/executor/logs — recent executor pipeline log lines. */
export async function fetchExecutorLogs(limit = 200): Promise<ExecutorLogsResponse> {
	return requestJson<ExecutorLogsResponse>(`/api/executor/logs?limit=${limit}`);
}

/** GET /api/submissions/pre-evaluate/logs — recent pre-evaluation log lines. */
export async function fetchPreEvalLogs(limit = 200): Promise<PreEvalLogsResponse> {
	return requestJson<PreEvalLogsResponse>(`/api/submissions/pre-evaluate/logs?limit=${limit}`);
}

/** GET /api/submissions/pre-evaluate/status — live batch pre-evaluation progress. */
export async function fetchPreEvalStatus(): Promise<PreEvalProgress> {
	return requestJson<PreEvalProgress>("/api/submissions/pre-evaluate/status");
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

/**
 * POST /api/submissions/[id]/import — apply a teacher-YAML grading document
 * (as exported with kind=teacher) and return the updated record.
 */
export async function importTeacherYaml(
	id: string,
	yamlText: string,
	assignmentId?: string,
): Promise<SubmissionMeta> {
	return requestJson<SubmissionMeta>(
		withAssignment(`/api/submissions/${encodeURIComponent(id)}/import`, assignmentId),
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ yaml: yamlText }),
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

/** DELETE /api/submissions/[id] — permanently remove a submission. */
export async function deleteSubmission(
	id: string,
	assignmentId?: string,
): Promise<{ deleted: string; assignmentId: string }> {
	return requestJson<{ deleted: string; assignmentId: string }>(
		withAssignment(`/api/submissions/${encodeURIComponent(id)}`, assignmentId),
		{ method: "DELETE" },
	);
}

/** POST /api/submissions/[id]/archive — archive or restore a submission. */
export async function archiveSubmission(
	id: string,
	assignmentId: string,
	action: "archive" | "restore" = "archive",
): Promise<SubmissionMeta> {
	return requestJson<SubmissionMeta>(
		withAssignment(`/api/submissions/${encodeURIComponent(id)}/archive`, assignmentId),
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action }),
		},
	);
}

/** POST /api/submissions/[id]/reset — clear grading state, revert to "executed". */
export async function resetSubmission(id: string, assignmentId?: string): Promise<SubmissionMeta> {
	return requestJson<SubmissionMeta>(
		withAssignment(`/api/submissions/${encodeURIComponent(id)}/reset`, assignmentId),
		{ method: "POST" },
	);
}

/**
 * GET /api/submissions/[id]/export — download the grading YAML document.
 *
 * @param kind "student" (default; v2 evaluation schema, importable in the
 *   student webapp, filename `<id>.yaml`) or "teacher" (full record +
 *   plagiarism audit, filename `<id>-teacher.yaml`).
 */
export async function exportSubmission(
	id: string,
	assignmentId?: string,
	kind: "student" | "teacher" = "student",
): Promise<SubmissionExport> {
	const url = withAssignment(`/api/submissions/${encodeURIComponent(id)}/export`, assignmentId);
	const content = await requestText(`${url}${url.includes("?") ? "&" : "?"}kind=${kind}`);
	// The route names the attachment <studentId>.yaml / <studentId>-teacher.yaml;
	// the caller only knows the id, so mirror that convention here.
	return {
		fileName: kind === "teacher" ? `${id}-teacher.yaml` : `${id}.yaml`,
		content,
	};
}

// ---------------------------------------------------------------------------
// Teacher backup (whole data directory)
// ---------------------------------------------------------------------------

/** GET /api/backup — download the teacher backup zip. */
export async function downloadBackup(): Promise<{ fileName: string; content: ArrayBuffer }> {
	const response = await requestRaw("/api/backup");
	const disposition = response.headers.get("content-disposition") ?? "";
	const match = /filename="([^"]+)"/.exec(disposition);
	return {
		fileName: match?.[1] ?? "sci-pro-teacher-backup.zip",
		content: await response.arrayBuffer(),
	};
}

/** POST /api/backup — restore a teacher backup zip into the data directory. */
export async function restoreBackup(file: File): Promise<{ restored: number }> {
	const form = new FormData();
	form.append("file", file);
	const response = await requestRaw("/api/backup", { method: "POST", body: form });
	return (await response.json()) as { restored: number };
}

// ---------------------------------------------------------------------------
// Assignments
// ---------------------------------------------------------------------------

/** GET /api/assignments — list enabled assignments. */
export async function fetchAssignments(): Promise<AssignmentsResponse> {
	return requestJson<AssignmentsResponse>("/api/assignments");
}

/** Payload accepted by POST /api/assignments (create). */
export interface AssignmentCreateInput {
	id: string;
	title: string;
	enabled?: boolean;
	criteria_files?: string[];
	dimensions?: string[];
}

/** POST /api/assignments — create an assignment (appends to the registry). */
export async function createAssignment(input: AssignmentCreateInput): Promise<AssignmentSummary> {
	return requestJson<AssignmentSummary>("/api/assignments", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
}

/** PUT /api/assignments/[id] — partially update an assignment. */
export async function updateAssignment(
	id: string,
	input: Partial<Omit<AssignmentCreateInput, "id">>,
): Promise<AssignmentSummary> {
	return requestJson<AssignmentSummary>(`/api/assignments/${encodeURIComponent(id)}`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
}

/** DELETE /api/assignments/[id] — remove an assignment (409 when it has submissions). */
export async function deleteAssignment(id: string): Promise<void> {
	await requestRaw(`/api/assignments/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/**
 * POST /api/assignments/[id]/criteria — upload a validated criteria YAML
 * file. Multipart field `file` (one `.yaml` document); on success the file
 * is persisted to data/criteria/ and appended to the assignment's
 * `criteria_files` list.
 */
export async function uploadCriteria(
	assignmentId: string,
	file: File,
): Promise<{ fileName: string; criteria_files: string[] }> {
	const form = new FormData();
	form.append("file", file);
	return requestJson<{ fileName: string; criteria_files: string[] }>(
		`/api/assignments/${encodeURIComponent(assignmentId)}/criteria`,
		{
			method: "POST",
			body: form,
		},
	);
}

/** GET /api/assignments/[id]/materials — current materials state for an assignment. */
export async function fetchMaterials(assignmentId: string): Promise<MaterialsStatus> {
	return requestJson<MaterialsStatus>(
		`/api/assignments/${encodeURIComponent(assignmentId)}/materials`,
	);
}

/** One persisted material file in the materials upload response. */
export interface MaterialUploadResult {
	name: string;
	kind: "material-file" | "material-data";
	replaced: boolean;
	bytes: number;
	/** Error message when this file failed to persist (per-file failure). */
	error?: string;
}

/**
 * POST /api/assignments/[id]/materials — upload assignment materials
 * (assignment PDF, key notebook, input-data files). Multipart field `file`
 * per file; the server classifies each via file-service (pdf / key.ipynb →
 * materials root, data extensions → input_data/) and returns the updated
 * material status plus per-file results. Files matching the student
 * submission naming pattern are rejected by the endpoint.
 */
export async function uploadMaterials(
	assignmentId: string,
	files: File[],
): Promise<{ status: MaterialsStatus; results: MaterialUploadResult[] }> {
	const form = new FormData();
	for (const file of files) {
		form.append("file", file);
	}
	const body = await requestJson<{
		status: MaterialsStatus;
		uploaded: MaterialUploadResult[];
	}>(`/api/assignments/${encodeURIComponent(assignmentId)}/materials`, {
		method: "POST",
		body: form,
	});
	return { status: body.status, results: body.uploaded };
}

/** DELETE /api/assignments/[id]/materials — delete one material file or clear all. */
export async function deleteMaterial(
	assignmentId: string,
	name?: string,
): Promise<{ status: MaterialsStatus; removed: string[] }> {
	const url = `/api/assignments/${encodeURIComponent(assignmentId)}/materials${
		name ? `?name=${encodeURIComponent(name)}` : ""
	}`;
	return requestJson<{ status: MaterialsStatus; removed: string[] }>(url, {
		method: "DELETE",
	});
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

/**
 * PATCH /api/plagiarism/results — set the review status of one pair
 * (P3-1, per-pair resolution). Returns the updated full result.
 */
export async function setPairReviewStatus(
	studentA: string,
	studentB: string,
	reviewStatus: PairReviewStatus,
	assignmentId?: string,
): Promise<PlagiarismResult> {
	const body: Record<string, unknown> = {
		studentA,
		studentB,
		reviewStatus,
	};
	if (assignmentId !== undefined) {
		body.assignmentId = assignmentId;
	}
	return requestJson<PlagiarismResult>("/api/plagiarism/results", {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

// ---------------------------------------------------------------------------
// Autofix
// ---------------------------------------------------------------------------

/** Fix suggestion for a failed cell (wire shape of POST /api/submissions/[id]/autofix). */
export interface AutofixSuggestion {
	skipped: boolean;
	suggestion: string | null;
	explanation: string | null;
	confidence: number | null;
	fixType: string | null;
	patchedSource: string | null;
	syntaxValid: boolean | null;
}

/** POST /api/submissions/[id]/autofix — ask KI Connect for a cell fix. */
export async function suggestAutofix(
	id: string,
	cell: { cellIndex: number; cellSource: string; cellError: string; traceback?: string[] },
	assignmentId?: string,
): Promise<AutofixSuggestion> {
	const body: Record<string, unknown> = {
		cellIndex: cell.cellIndex,
		cellSource: cell.cellSource,
		cellError: cell.cellError,
	};
	if (cell.traceback !== undefined && cell.traceback.length > 0) {
		body.traceback = cell.traceback;
	}
	return requestJson<AutofixSuggestion>(
		withAssignment(`/api/submissions/${encodeURIComponent(id)}/autofix`, assignmentId),
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		},
	);
}

/**
 * Verified result of a manual fix (wire shape of
 * POST /api/submissions/[id]/autofix/verify). `fixed` is True only when
 * the whole-notebook re-run came back clean — a single-cell re-run loses
 * kernel state built by earlier cells, so the manual flow verifies in
 * full context, never in isolation.
 */
export interface AutofixVerifyResult {
	fixed: boolean;
	patchedSource: string;
	/** The patched cell's output after the whole-notebook re-run. */
	reRunOutput: string;
	/** The patched cell's error after the re-run — null when it ran clean. */
	reRunError: string | null;
	/** The verified fixed execution when the re-run was clean, else null. */
	fixedCells: CellInfo[] | null;
	totalCells: number;
	executedCells: number;
	errorCells: number;
}

/** POST /api/submissions/[id]/autofix/verify — verify a fix in full context. */
export async function verifyAutofix(
	id: string,
	cell: { cellIndex: number; patchedSource: string },
	assignmentId?: string,
): Promise<AutofixVerifyResult> {
	return requestJson<AutofixVerifyResult>(
		withAssignment(`/api/submissions/${encodeURIComponent(id)}/autofix/verify`, assignmentId),
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				cellIndex: cell.cellIndex,
				patchedSource: cell.patchedSource,
			}),
		},
	);
}

// ---------------------------------------------------------------------------
// Criteria editor
// ---------------------------------------------------------------------------

/** GET /api/assignments/[id]/criteria — load the assignment's own criteria. */
export async function getCriteria(
	assignmentId: string,
): Promise<{ fileName: string | null; content: CriteriaFile | null }> {
	return requestJson<{ fileName: string | null; content: CriteriaFile | null }>(
		`/api/assignments/${encodeURIComponent(assignmentId)}/criteria`,
	);
}

/** PUT /api/assignments/[id]/criteria — replace the assignment's own criteria. */
export async function saveCriteria(
	assignmentId: string,
	categories: Record<string, unknown>,
): Promise<{ fileName: string; content: CriteriaFile }> {
	return requestJson<{ fileName: string; content: CriteriaFile }>(
		`/api/assignments/${encodeURIComponent(assignmentId)}/criteria`,
		{
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ categories }),
		},
	);
}

/**
 * POST /api/assignments/[id]/criteria/draft — ask the LLM to draft the
 * assignment's criteria (rubric) categories from its own rubric + metadata,
 * following the quantifiable criteria-authoring rules. The draft is NOT
 * persisted: the teacher reviews it in the criteria editor and saves
 * explicitly via the compile-gate PUT. `draft` is null when the server could
 * not produce one (e.g. the assignment has no own rubric to ground on).
 */
export async function draftCriteria(assignmentId: string): Promise<{ draft: CriteriaFile | null }> {
	return requestJson<{ draft: CriteriaFile | null }>(
		`/api/assignments/${encodeURIComponent(assignmentId)}/criteria/draft`,
		{ method: "POST" },
	);
}

// ---------------------------------------------------------------------------
// Scoring config editor
// ---------------------------------------------------------------------------

/**
 * Raw scoring document shape (the YAML under `scoring:`) as edited by the
 * scoring editor — the same shape `compileScoringConfig` consumes.
 */
export interface ScoringConfigDocument {
	reference_anchors?: Record<string, number>;
	evidence_patterns?: Record<
		string,
		{
			pattern: string | string[];
			semantics: "test" | "test_all" | "capture_value" | "distinct_count";
			haystack: "output" | "code" | "markdown" | "output+code" | "markdown+code";
			capture_group?: number;
		}
	>;
	disallowed_libraries?: string[];
	/** Optional Pass 3 import allow-list (top-level module names); absent → default. */
	allowed_libraries?: string[];
	prompt_anchor_text?: {
		dimension_guidance?: Record<string, string>;
	};
}

/** GET /api/assignments/[id]/scoring — load the assignment's scoring config. */
export async function getScoringConfig(
	assignmentId: string,
): Promise<{ fileName: string | null; content: ScoringConfigDocument | null }> {
	return requestJson<{ fileName: string | null; content: ScoringConfigDocument | null }>(
		`/api/assignments/${encodeURIComponent(assignmentId)}/scoring`,
	);
}

/** PUT /api/assignments/[id]/scoring — replace the assignment's scoring config. */
export async function saveScoringConfig(
	assignmentId: string,
	scoring: Record<string, unknown>,
): Promise<{ fileName: string; content: ScoringConfigDocument }> {
	return requestJson<{ fileName: string; content: ScoringConfigDocument }>(
		`/api/assignments/${encodeURIComponent(assignmentId)}/scoring`,
		{
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ scoring }),
		},
	);
}

/**
 * POST /api/assignments/[id]/scoring/draft — ask the LLM to draft a scoring
 * config from the assignment's rubric. The draft is NOT persisted: the
 * teacher reviews it in the editor and saves explicitly via the compile-gate
 * PUT. `draft` is null when the server could not produce one.
 */
export async function draftScoringConfig(
	assignmentId: string,
): Promise<{ draft: ScoringConfigDocument | null }> {
	return requestJson<{ draft: ScoringConfigDocument | null }>(
		`/api/assignments/${encodeURIComponent(assignmentId)}/scoring/draft`,
		{ method: "POST" },
	);
}
