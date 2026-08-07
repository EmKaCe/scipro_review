/**
 * @file Typed HTTP client for the Python notebook executor (FastAPI, port 8766).
 *
 * Translates the executor's wire shapes (pydantic models in `executor/app.py`,
 * see plan Appendix B) into frontend-friendly camelCase types:
 *
 *   cell_index      -> index
 *   output_text     -> output
 *   original_source -> original_source (separate from the cleaned `source`)
 *   type            -> injected from caller-supplied cell metadata
 *                     (default "code")
 *   marker          -> "different" by default, "error" when `error` is set
 *                     (cell comparison ships with pre-evaluation)
 *
 * Environment:
 *   EXECUTOR_URL — base URL of the executor (default: http://executor:8766)
 *
 * This module runs only on the SvelteKit server (`$lib/server/`).
 */

import type { CellMarker } from "$lib/types/submissions";

// ---------------------------------------------------------------------------
// Wire types (mirror executor/app.py pydantic models — snake_case)
// ---------------------------------------------------------------------------

export interface ExecutorCellResult {
	cell_index: number;
	execution_count: number | null;
	source: string;
	output_text: string;
	error: string | null;
	traceback: string[] | null;
	/**
	 * Original (pre-cleaning) source. Optional so the
	 * client stays compatible with the current executor response.
	 */
	original_source?: string;
	/**
	 * Cell type from the original notebook ("code" | "markdown").
	 * The executor reports it since it knows the source notebook;
	 * falls back to caller-supplied metadata in translateCell.
	 */
	cell_type?: string;
}

export interface ExecutorPreprocessingInfo {
	cells_modified: number;
	total_edits: number;
	edit_types: Record<string, number>;
	llm_preprocessing: "completed" | "skipped" | "error";
	llm_analysis: boolean;
	/** Per-cell edit log (`cell_index` -> edits). */
	cell_edits?: Record<
		string,
		Array<{ edit_type: string; note: string; old_text?: string; new_text?: string }>
	>;
}

export interface ExecutorExecuteResponse {
	success: boolean;
	notebook_path: string;
	cells: ExecutorCellResult[];
	total_cells: number;
	executed_cells: number;
	error_cells: number;
	duration_seconds: number;
	preprocessing: ExecutorPreprocessingInfo;
	/** Data files the sandbox detected as modified by the notebook. */
	modified_files?: string[];
}

export interface ExecutorBatchItemResult {
	notebook_path: string;
	success: boolean;
	total_cells: number;
	executed_cells: number;
	error_cells: number;
	duration_seconds: number;
	error: string | null;
}

export interface ExecutorBatchResponse {
	results: ExecutorBatchItemResult[];
	total_notebooks: number;
	succeeded: number;
	failed: number;
	total_duration_seconds: number;
}

export interface ExecutorHealth {
	status: string;
	version: string;
	data_dir: string;
	ki_connect_available: boolean;
}

// ---------------------------------------------------------------------------
// Request types (frontend-facing, camelCase)
// ---------------------------------------------------------------------------

export interface ExecuteRequest {
	/** Relative path inside the shared data dir, e.g. "submissions/soil/2026SS_03.ipynb". */
	notebookPath: string;
	/** Per-cell execution timeout in seconds (default 30). */
	timeout?: number;
	/** Jupyter kernel to use (default "python3"). */
	kernelName?: string;
	/** Skip deterministic + LLM pre-processing (default false). */
	skipPreprocessing?: boolean;
	/** Optional assignment description for LLM analysis. */
	assignmentContext?: string | null;
}

export interface BatchExecuteRequest {
	notebooks: ExecuteRequest[];
	/** Stop processing after the first notebook that fails (default false). */
	stopOnFirstError?: boolean;
}

/** Original cell metadata the caller already has (e.g. from the uploaded .ipynb). */
export interface CellMetadata {
	type?: "code" | "markdown" | string;
	/** Original, un-cleaned source shown to the teacher. */
	source?: string;
}

// ---------------------------------------------------------------------------
// Translated types (frontend-facing, camelCase)
// ---------------------------------------------------------------------------

export interface ExecutedCell {
	/** 0-based index within the notebook (was cell_index). */
	index: number;
	/** Cell type, injected from cell metadata (default "code"). */
	type: "code" | "markdown";
	/** Cleaned + annotated source as executed (was source). */
	source: string;
	/** Original student source before cleaning — what the UI shows. */
	original_source: string;
	/** Cell output text (was output_text). */
	output: string;
	/** Error message if execution failed, else null. */
	error: string | null;
	traceback: string[] | null;
	execution_count: number | null;
	/** "different" by default, "error" when `error` is set. */
	marker: CellMarker;
}

export interface PreprocessingSummary {
	cellsModified: number;
	totalEdits: number;
	editTypes: Record<string, number>;
	llmPreprocessing: "completed" | "skipped" | "error";
	llmAnalysis: boolean;
	cellEdits?: ExecutorPreprocessingInfo["cell_edits"];
}

export interface ExecutionResult {
	success: boolean;
	notebookPath: string;
	cells: ExecutedCell[];
	totalCells: number;
	executedCells: number;
	errorCells: number;
	durationSeconds: number;
	preprocessing: PreprocessingSummary;
	modifiedFiles: string[];
}

export interface BatchItemResult {
	notebookPath: string;
	success: boolean;
	totalCells: number;
	executedCells: number;
	errorCells: number;
	durationSeconds: number;
	error: string | null;
}

export interface BatchExecutionResult {
	results: BatchItemResult[];
	totalNotebooks: number;
	succeeded: number;
	failed: number;
	totalDurationSeconds: number;
}

// ---------------------------------------------------------------------------
// Autofix (KI Connect fix suggestions for failed cells)
// ---------------------------------------------------------------------------

export interface AutofixRequest {
	/** The failing cell's source code (as executed). */
	cellSource: string;
	/** Error message from the failed execution. */
	cellError: string;
	/** Index of the failing cell in the notebook (informational). */
	cellIndex?: number;
	/** Optional traceback lines — appended to the error for the LLM. */
	traceback?: string[] | null;
	/** Assignment id — used by the executor to discover input-data files. */
	assignmentId?: string | null;
}

/** Fix suggestion for a failed cell (mirrors the executor's AutoFixResponse). */
export interface AutofixSuggestion {
	/** True when KI Connect was unavailable or returned nothing usable. */
	skipped: boolean;
	/** Corrected cell source proposed by the LLM. */
	suggestion: string | null;
	/** Brief explanation of what was wrong and how the fix works. */
	explanation: string | null;
	/** Model confidence in the fix (0–1). */
	confidence: number | null;
	/** Categorization of the fix (import_fix, syntax_fix, …). */
	fixType: string | null;
	/** Suggestion when it parses as valid Python — safe to re-run. */
	patchedSource: string | null;
	/** Result of the deterministic ast.parse sanity check. */
	syntaxValid: boolean | null;
}

/** Convert a frontend AutofixRequest into the executor wire body. */
export function toWireAutofixRequest(request: AutofixRequest): Record<string, unknown> {
	return {
		cell_source: request.cellSource,
		cell_error: request.cellError,
		cell_index: request.cellIndex ?? null,
		traceback: request.traceback ?? null,
		assignment_id: request.assignmentId ?? null,
	};
}

/** Translate the executor's AutoFixResponse into the frontend shape. */
export function translateAutofixSuggestion(wire: Record<string, unknown>): AutofixSuggestion {
	return {
		skipped: wire.skipped === true,
		suggestion: typeof wire.suggestion === "string" ? wire.suggestion : null,
		explanation: typeof wire.explanation === "string" ? wire.explanation : null,
		confidence: typeof wire.confidence === "number" ? wire.confidence : null,
		fixType: typeof wire.fix_type === "string" ? wire.fix_type : null,
		patchedSource: typeof wire.patched_source === "string" ? wire.patched_source : null,
		syntaxValid: typeof wire.syntax_valid === "boolean" ? wire.syntax_valid : null,
	};
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Base error for all executor client failures. */
export class ExecutorError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "ExecutorError";
	}
}

/** The executor responded with a non-2xx status. */
export class ExecutorHttpError extends ExecutorError {
	readonly status: number;
	/** Raw response body (truncated for safety). */
	readonly body: string;

	constructor(status: number, body: string, url: string) {
		const detail = body.length > 500 ? `${body.slice(0, 500)}…` : body;
		super(`Executor returned ${status} for ${url}${detail ? `: ${detail}` : ""}`);
		this.name = "ExecutorHttpError";
		this.status = status;
		this.body = body;
	}
}

/** The request was aborted after the configured timeout. */
export class ExecutorTimeoutError extends ExecutorError {
	constructor(url: string, timeoutMs: number) {
		super(`Executor request timed out after ${timeoutMs}ms: ${url}`);
		this.name = "ExecutorTimeoutError";
	}
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = "http://executor:8766";
const DEFAULT_TIMEOUT_MS = 30_000;
/**
 * Per-notebook budget for batch execution requests. A batch of N notebooks
 * runs sequentially on the executor (each spins up a kernel), so the HTTP
 * request needs a timeout proportional to the batch size — the shared
 * single-request default would abort a large batch mid-run and lose every
 * result. 60s per notebook is ~5x the measured wall time per notebook.
 */
const BATCH_NOTEBOOK_TIMEOUT_MS = 60_000;

function getEnv(key: string, fallback: string): string {
	if (typeof process !== "undefined" && process.env && process.env[key]) {
		return process.env[key]!;
	}
	return fallback;
}

export interface ExecutorClientOptions {
	/** Base URL of the executor (default: EXECUTOR_URL env or http://executor:8766). */
	baseUrl?: string;
	/** Request timeout in milliseconds (default 30s). */
	timeoutMs?: number;
}

/** Translate one wire cell into the frontend shape. */
export function translateCell(cell: ExecutorCellResult, metadata?: CellMetadata): ExecutedCell {
	// Prefer the executor-reported type (it read the original notebook);
	// fall back to caller-supplied metadata, then "code".
	const type: "code" | "markdown" =
		cell.cell_type === "markdown" || metadata?.type === "markdown" ? "markdown" : "code";
	const originalSource = cell.original_source ?? metadata?.source ?? cell.source;
	return {
		index: cell.cell_index,
		type,
		source: cell.source,
		original_source: originalSource,
		output: cell.output_text,
		error: cell.error,
		traceback: cell.traceback,
		execution_count: cell.execution_count,
		// Markers (same/different/questionable) come from Phase 4
		// pre-evaluation — the executor does not compute them. Until then the
		// only honest marker is "error" (execution status) or "pending" (no
		// comparison data yet).
		marker: cell.error ? "error" : "pending",
	};
}

/** Convert a frontend ExecuteRequest into the executor wire body. */
export function toWireRequest(request: ExecuteRequest): Record<string, unknown> {
	return {
		notebook_path: request.notebookPath,
		timeout: request.timeout ?? 30,
		kernel_name: request.kernelName ?? "python3",
		skip_preprocessing: request.skipPreprocessing ?? false,
		assignment_context: request.assignmentContext ?? null,
	};
}

export class ExecutorClient {
	private baseUrl: string;
	private timeoutMs: number;

	constructor(opts: ExecutorClientOptions = {}) {
		this.baseUrl = (opts.baseUrl ?? getEnv("EXECUTOR_URL", DEFAULT_BASE_URL)).replace(
			/\/+$/,
			"",
		);
		this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	/**
	 * Resolve request timeouts from data/settings.yaml (which the Settings UI
	 * edits), falling back to the constructor/env default when the file is
	 * unreadable. Read per call so a settings save takes effect immediately —
	 * the file is tiny and the repo convention is to re-read config per call.
	 */
	private async resolveTimeouts(): Promise<{
		requestMs: number;
		cellS: number;
		notebookMs: number;
	}> {
		try {
			const { loadSettings } = await import("./settings");
			const s = await loadSettings();
			return {
				requestMs: s.executor.requestTimeoutMs,
				cellS: s.executor.cellTimeoutS,
				notebookMs: s.executor.notebookTimeoutMs,
			};
		} catch {
			return { requestMs: this.timeoutMs, cellS: 30, notebookMs: BATCH_NOTEBOOK_TIMEOUT_MS };
		}
	}

	/**
	 * Execute a single notebook.
	 *
	 * @param request   Notebook + execution options.
	 * @param cellMetadata Optional original cell metadata (type + original source)
	 *                     from the uploaded notebook; used to inject `type` and
	 *                     `original_source` into translated cells.
	 * @param opts.requestTimeoutMs Override the HTTP request timeout (e.g. the
	 *                     per-notebook batch budget). Falls back to settings.
	 */
	async executeNotebook(
		request: ExecuteRequest,
		cellMetadata?: CellMetadata[],
		opts: { requestTimeoutMs?: number } = {},
	): Promise<ExecutionResult> {
		const { requestMs, cellS } = await this.resolveTimeouts();
		const wire = toWireRequest(request);
		// Per-cell execution timeout comes from settings when the caller did
		// not pin it (default 30s is too tight for slower machines).
		wire.timeout = request.timeout ?? cellS;
		const data = (await this.post(
			"/execute",
			wire,
			opts.requestTimeoutMs ?? requestMs,
		)) as ExecutorExecuteResponse;
		const cells = data.cells.map((cell, i) =>
			translateCell(cell, cellMetadata?.[cell.cell_index] ?? cellMetadata?.[i]),
		);
		return {
			success: data.success,
			notebookPath: data.notebook_path,
			cells,
			totalCells: data.total_cells,
			executedCells: data.executed_cells,
			errorCells: data.error_cells,
			durationSeconds: data.duration_seconds,
			preprocessing: {
				cellsModified: data.preprocessing.cells_modified,
				totalEdits: data.preprocessing.total_edits,
				editTypes: data.preprocessing.edit_types,
				llmPreprocessing: data.preprocessing.llm_preprocessing,
				llmAnalysis: data.preprocessing.llm_analysis,
				cellEdits: data.preprocessing.cell_edits,
			},
			modifiedFiles: data.modified_files ?? [],
		};
	}

	/** Execute multiple notebooks sequentially. */
	async executeBatch(request: BatchExecuteRequest): Promise<BatchExecutionResult> {
		const { requestMs, cellS, notebookMs } = await this.resolveTimeouts();
		const wireNotebooks = request.notebooks.map((n) => {
			const wire = toWireRequest(n);
			wire.timeout = n.timeout ?? cellS;
			return wire;
		});
		const body: Record<string, unknown> = {
			notebooks: wireNotebooks,
			stop_on_first_error: request.stopOnFirstError ?? false,
		};
		// Sequential batch execution takes ~13s per notebook; the shared
		// single-request timeout would abort large batches mid-run and lose
		// every result. Scale the request timeout with the batch size.
		const batchTimeoutMs = Math.max(requestMs, request.notebooks.length * notebookMs);
		const data = (await this.post(
			"/execute/batch",
			body,
			batchTimeoutMs,
		)) as ExecutorBatchResponse;
		return {
			results: data.results.map((r) => ({
				notebookPath: r.notebook_path,
				success: r.success,
				totalCells: r.total_cells,
				executedCells: r.executed_cells,
				errorCells: r.error_cells,
				durationSeconds: r.duration_seconds,
				error: r.error,
			})),
			totalNotebooks: data.total_notebooks,
			succeeded: data.succeeded,
			failed: data.failed,
			totalDurationSeconds: data.total_duration_seconds,
		};
	}

	/** Executor health check. */
	async health(): Promise<ExecutorHealth> {
		return (await this.get("/health")) as ExecutorHealth;
	}

	/**
	 * Ask KI Connect for a fix suggestion for a failed cell.
	 *
	 * The executor sanity-checks the suggestion with ast.parse; a
	 * syntactically invalid fix is returned flagged (syntaxValid false,
	 * no patchedSource) instead of being applied. When KI Connect is
	 * unavailable the executor responds with `skipped: true`.
	 */
	async suggestAutofix(request: AutofixRequest): Promise<AutofixSuggestion> {
		const wire = (await this.post("/auto-fix", toWireAutofixRequest(request))) as Record<
			string,
			unknown
		>;
		return translateAutofixSuggestion(wire);
	}

	// ------------------------------------------------------------------
	// Internal HTTP
	// ------------------------------------------------------------------

	private async request(path: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
		const url = `${this.baseUrl}${path}`;
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

		let resp: Response;
		try {
			resp = await fetch(url, { ...init, signal: controller.signal });
		} catch (err) {
			if (err instanceof Error && err.name === "AbortError") {
				throw new ExecutorTimeoutError(url, timeoutMs);
			}
			throw new ExecutorError(`Executor request failed: ${url}`, { cause: err });
		} finally {
			clearTimeout(timeoutId);
		}

		if (!resp.ok) {
			const body = await resp.text().catch(() => "");
			throw new ExecutorHttpError(resp.status, body, url);
		}
		return resp.json().catch(() => {
			throw new ExecutorError(`Executor returned invalid JSON: ${url}`);
		});
	}

	private post(path: string, body: unknown, timeoutMs?: number): Promise<unknown> {
		return this.request(
			path,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			},
			timeoutMs ?? this.timeoutMs,
		);
	}

	private get(path: string): Promise<unknown> {
		return this.request(path, { method: "GET" }, this.timeoutMs);
	}
}

/** Singleton instance (reuse across the server process). */
let _defaultInstance: ExecutorClient | null = null;

/** Get or create the default singleton ExecutorClient. */
export function getExecutorClient(): ExecutorClient {
	if (!_defaultInstance) {
		_defaultInstance = new ExecutorClient();
	}
	return _defaultInstance;
}
