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
 *                     (Phase 3 D6: no cell comparison until Phase 4)
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
	 * Original (pre-cleaning) source. Planned for Phase 3b.1 — optional so the
	 * client stays compatible with the current executor response.
	 */
	original_source?: string;
}

export interface ExecutorPreprocessingInfo {
	cells_modified: number;
	total_edits: number;
	edit_types: Record<string, number>;
	llm_preprocessing: "completed" | "skipped" | "error";
	llm_analysis: boolean;
	/** Per-cell edit log (`cell_index` -> edits). Planned for Phase 3b.1. */
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
	/** Data files the sandbox detected as modified by the notebook. 3b.1. */
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
	/** "different" by default, "error" when `error` is set (Phase 3 D6). */
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
	const type: "code" | "markdown" = metadata?.type === "markdown" ? "markdown" : "code";
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
		marker: cell.error ? "error" : "different",
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
	 * Execute a single notebook.
	 *
	 * @param request   Notebook + execution options.
	 * @param cellMetadata Optional original cell metadata (type + original source)
	 *                     from the uploaded notebook; used to inject `type` and
	 *                     `original_source` into translated cells.
	 */
	async executeNotebook(
		request: ExecuteRequest,
		cellMetadata?: CellMetadata[],
	): Promise<ExecutionResult> {
		const data = (await this.post(
			"/execute",
			toWireRequest(request),
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
		const body: Record<string, unknown> = {
			notebooks: request.notebooks.map(toWireRequest),
			stop_on_first_error: request.stopOnFirstError ?? false,
		};
		const data = (await this.post("/execute/batch", body)) as ExecutorBatchResponse;
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

	private post(path: string, body: unknown): Promise<unknown> {
		return this.request(
			path,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			},
			this.timeoutMs,
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
