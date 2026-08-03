/**
 * @file L5 API-contract tests for executor-client.ts (mocked fetch).
 *
 * Covers: request body shape to /execute and /execute/batch, wire-shape
 * translation (cell_index -> index, output_text -> output), marker defaults
 * ("different" / "error"), original_source preservation, type injection,
 * typed errors on non-2xx, timeout aborts, and EXECUTOR_URL resolution.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

import {
	ExecutorClient,
	ExecutorError,
	ExecutorHttpError,
	ExecutorTimeoutError,
	type ExecutorCellResult,
	type ExecutorExecuteResponse,
} from "$lib/server/executor-client";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WIRE_CELLS: ExecutorCellResult[] = [
	{
		cell_index: 0,
		execution_count: 1,
		source: "import numpy as np",
		output_text: "",
		error: null,
		traceback: null,
	},
	{
		cell_index: 1,
		execution_count: null,
		source: "x = np.array([1])",
		output_text: "---\nNameError Traceback (most recent call last)",
		error: "NameError: name 'np' is not defined",
		traceback: ["Traceback (most recent call last):", "NameError: name 'np' is not defined"],
	},
];

function wireExecuteResponse(cells: ExecutorCellResult[] = WIRE_CELLS): ExecutorExecuteResponse {
	return {
		success: cells.some((c) => c.error === null),
		notebook_path: "submissions/soil/2026SS_03.ipynb",
		cells,
		total_cells: cells.length,
		executed_cells: cells.length,
		error_cells: cells.filter((c) => c.error !== null).length,
		duration_seconds: 1.25,
		preprocessing: {
			cells_modified: 1,
			total_edits: 2,
			edit_types: { colab_import_removed: 2 },
			llm_preprocessing: "skipped",
			llm_analysis: false,
		},
	};
}

/** Minimal Response stand-in (jsdom has no fetch/Response). */
function jsonResponse(data: unknown, status = 200): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => data,
		text: async () => (typeof data === "string" ? data : JSON.stringify(data)),
	} as unknown as Response;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let fetchMock: Mock;

beforeEach(() => {
	fetchMock = vi.fn();
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

const client = () => new ExecutorClient({ baseUrl: "http://executor.test" });

// ---------------------------------------------------------------------------
// /execute — request contract
// ---------------------------------------------------------------------------

describe("executeNotebook — request shape", () => {
	it("POSTs the full default wire body to /execute", async () => {
		fetchMock.mockResolvedValue(jsonResponse(wireExecuteResponse()));

		await client().executeNotebook({ notebookPath: "submissions/soil/2026SS_03.ipynb" });

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("http://executor.test/execute");
		expect(init.method).toBe("POST");
		expect(init.headers).toEqual({ "Content-Type": "application/json" });
		expect(JSON.parse(init.body as string)).toEqual({
			notebook_path: "submissions/soil/2026SS_03.ipynb",
			timeout: 30,
			kernel_name: "python3",
			skip_preprocessing: false,
			assignment_context: null,
		});
	});

	it("honors request overrides in the wire body", async () => {
		fetchMock.mockResolvedValue(jsonResponse(wireExecuteResponse()));

		await client().executeNotebook({
			notebookPath: "submissions/soil/2026SS_07.ipynb",
			timeout: 60,
			kernelName: "python3.11",
			skipPreprocessing: true,
			assignmentContext: "Soil contamination analysis",
		});

		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(JSON.parse(init.body as string)).toEqual({
			notebook_path: "submissions/soil/2026SS_07.ipynb",
			timeout: 60,
			kernel_name: "python3.11",
			skip_preprocessing: true,
			assignment_context: "Soil contamination analysis",
		});
	});
});

// ---------------------------------------------------------------------------
// /execute — cell translation
// ---------------------------------------------------------------------------

describe("executeNotebook — cell translation", () => {
	it("maps cell_index -> index and output_text -> output", async () => {
		fetchMock.mockResolvedValue(jsonResponse(wireExecuteResponse()));

		const result = await client().executeNotebook({
			notebookPath: "submissions/soil/2026SS_03.ipynb",
		});

		expect(result.cells).toHaveLength(2);
		expect(result.cells[0]!.index).toBe(0);
		expect(result.cells[1]!.index).toBe(1);
		expect(result.cells[0]!.output).toBe("");
		expect(result.cells[1]!.output).toBe(WIRE_CELLS[1]!.output_text);
		expect(result.notebookPath).toBe("submissions/soil/2026SS_03.ipynb");
		expect(result.durationSeconds).toBe(1.25);
		expect(result.errorCells).toBe(1);
	});

	it("defaults marker to 'different' and switches to 'error' when error is set", async () => {
		fetchMock.mockResolvedValue(jsonResponse(wireExecuteResponse()));

		const result = await client().executeNotebook({
			notebookPath: "submissions/soil/2026SS_03.ipynb",
		});

		expect(result.cells[0]!.marker).toBe("different");
		expect(result.cells[1]!.marker).toBe("error");
	});

	it("preserves original_source from caller-supplied cell metadata, falling back to source", async () => {
		fetchMock.mockResolvedValue(
			jsonResponse(
				wireExecuteResponse([
					{
						cell_index: 0,
						execution_count: 1,
						source: "import numpy as np  # SciPro: cleaned",
						output_text: "",
						error: null,
						traceback: null,
					},
				]),
			),
		);

		const result = await client().executeNotebook(
			{ notebookPath: "submissions/soil/2026SS_03.ipynb" },
			[{ type: "code", source: "import numpy as np" }],
		);

		expect(result.cells[0]!.source).toBe("import numpy as np  # SciPro: cleaned");
		expect(result.cells[0]!.original_source).toBe("import numpy as np");

		// Without metadata the original source falls back to the wire source.
		fetchMock.mockResolvedValue(jsonResponse(wireExecuteResponse()));
		const fallback = await client().executeNotebook({
			notebookPath: "submissions/soil/2026SS_03.ipynb",
		});
		expect(fallback.cells[0]!.original_source).toBe(WIRE_CELLS[0]!.source);
	});

	it("injects type from cell metadata, defaulting to 'code'", async () => {
		fetchMock.mockResolvedValue(
			jsonResponse(
				wireExecuteResponse([
					{
						cell_index: 0,
						execution_count: null,
						source: "# Title",
						output_text: "",
						error: null,
						traceback: null,
					},
					{
						cell_index: 1,
						execution_count: null,
						source: "x = 1",
						output_text: "",
						error: null,
						traceback: null,
					},
				]),
			),
		);

		const result = await client().executeNotebook(
			{ notebookPath: "submissions/soil/2026SS_03.ipynb" },
			[{ type: "markdown" }],
		);

		expect(result.cells[0]!.type).toBe("markdown");
		expect(result.cells[1]!.type).toBe("code");
	});

	it("translates preprocessing and modified_files", async () => {
		const wire = wireExecuteResponse();
		wire.modified_files = ["input_data/soil_contamination.csv"];
		fetchMock.mockResolvedValue(jsonResponse(wire));

		const result = await client().executeNotebook({
			notebookPath: "submissions/soil/2026SS_03.ipynb",
		});

		expect(result.preprocessing).toEqual({
			cellsModified: 1,
			totalEdits: 2,
			editTypes: { colab_import_removed: 2 },
			llmPreprocessing: "skipped",
			llmAnalysis: false,
			cellEdits: undefined,
		});
		expect(result.modifiedFiles).toEqual(["input_data/soil_contamination.csv"]);
	});
});

// ---------------------------------------------------------------------------
// /execute/batch — request + translation
// ---------------------------------------------------------------------------

describe("executeBatch", () => {
	it("POSTs wire-shaped notebook list with stop_on_first_error", async () => {
		fetchMock.mockResolvedValue(
			jsonResponse({
				results: [
					{
						notebook_path: "submissions/soil/2026SS_03.ipynb",
						success: true,
						total_cells: 3,
						executed_cells: 3,
						error_cells: 0,
						duration_seconds: 1.1,
						error: null,
					},
				],
				total_notebooks: 1,
				succeeded: 1,
				failed: 0,
				total_duration_seconds: 1.1,
			}),
		);

		const result = await client().executeBatch({
			notebooks: [{ notebookPath: "submissions/soil/2026SS_03.ipynb", timeout: 45 }],
			stopOnFirstError: true,
		});

		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("http://executor.test/execute/batch");
		expect(JSON.parse(init.body as string)).toEqual({
			notebooks: [
				{
					notebook_path: "submissions/soil/2026SS_03.ipynb",
					timeout: 45,
					kernel_name: "python3",
					skip_preprocessing: false,
					assignment_context: null,
				},
			],
			stop_on_first_error: true,
		});

		expect(result.totalNotebooks).toBe(1);
		expect(result.succeeded).toBe(1);
		expect(result.failed).toBe(0);
		expect(result.totalDurationSeconds).toBe(1.1);
		expect(result.results[0]!.notebookPath).toBe("submissions/soil/2026SS_03.ipynb");
		expect(result.results[0]!.success).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// /health
// ---------------------------------------------------------------------------

describe("health", () => {
	it("GETs /health and returns the typed payload", async () => {
		fetchMock.mockResolvedValue(
			jsonResponse({
				status: "ok",
				version: "0.2.0",
				data_dir: "/app/data",
				ki_connect_available: false,
			}),
		);

		const health = await client().health();

		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("http://executor.test/health");
		expect(init.method).toBe("GET");
		expect(health).toEqual({
			status: "ok",
			version: "0.2.0",
			data_dir: "/app/data",
			ki_connect_available: false,
		});
	});
});

// ---------------------------------------------------------------------------
// /autofix — request contract + translation (Phase 3c.1)
// ---------------------------------------------------------------------------

describe("suggestAutofix", () => {
	const WIRE_SUGGESTION = {
		skipped: false,
		suggestion: "df['cluster'] = kmeans.fit_predict(scaled)",
		explanation: "Replace scaled_data with scaled (Cell 3 variable name).",
		confidence: 0.92,
		fix_type: "name_fix",
		patched_source: "df['cluster'] = kmeans.fit_predict(scaled)\n",
		syntax_valid: true,
	};

	it("POSTs the snake_case wire body to /auto-fix", async () => {
		fetchMock.mockResolvedValue(jsonResponse(WIRE_SUGGESTION));

		await client().suggestAutofix({
			cellSource: "df['cluster'] = kmeans.fit_predict(scaled_data)",
			cellError: "NameError: name 'scaled_data' is not defined",
			cellIndex: 3,
			traceback: [
				"Traceback (most recent call last):",
				"NameError: name 'scaled_data' is not defined",
			],
			assignmentId: "soil_contamination",
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("http://executor.test/auto-fix");
		expect(init.method).toBe("POST");
		expect(JSON.parse(init.body as string)).toEqual({
			cell_source: "df['cluster'] = kmeans.fit_predict(scaled_data)",
			cell_error: "NameError: name 'scaled_data' is not defined",
			cell_index: 3,
			traceback: [
				"Traceback (most recent call last):",
				"NameError: name 'scaled_data' is not defined",
			],
			assignment_id: "soil_contamination",
		});
	});

	it("translates the wire response into the frontend shape", async () => {
		fetchMock.mockResolvedValue(jsonResponse(WIRE_SUGGESTION));

		const result = await client().suggestAutofix({
			cellSource: "x",
			cellError: "boom",
		});

		expect(result).toEqual({
			skipped: false,
			suggestion: "df['cluster'] = kmeans.fit_predict(scaled)",
			explanation: "Replace scaled_data with scaled (Cell 3 variable name).",
			confidence: 0.92,
			fixType: "name_fix",
			patchedSource: "df['cluster'] = kmeans.fit_predict(scaled)\n",
			syntaxValid: true,
		});
	});

	it("maps a skipped/empty response (KI Connect unavailable)", async () => {
		fetchMock.mockResolvedValue(
			jsonResponse({
				skipped: true,
				suggestion: null,
				explanation: null,
				confidence: null,
				fix_type: null,
				patched_source: null,
				syntax_valid: null,
			}),
		);

		const result = await client().suggestAutofix({ cellSource: "x", cellError: "boom" });

		expect(result).toEqual({
			skipped: true,
			suggestion: null,
			explanation: null,
			confidence: null,
			fixType: null,
			patchedSource: null,
			syntaxValid: null,
		});
	});

	it("omits undefined optionals instead of nulls", async () => {
		fetchMock.mockResolvedValue(jsonResponse(WIRE_SUGGESTION));

		await client().suggestAutofix({ cellSource: "x", cellError: "boom" });

		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(JSON.parse(init.body as string)).toEqual({
			cell_source: "x",
			cell_error: "boom",
			cell_index: null,
			traceback: null,
			assignment_id: null,
		});
	});
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

describe("error handling", () => {
	it("throws ExecutorHttpError with status and body on non-2xx", async () => {
		fetchMock.mockResolvedValue(jsonResponse({ detail: "Notebook not found" }, 404));

		const promise = client().executeNotebook({
			notebookPath: "submissions/soil/missing.ipynb",
		});

		await expect(promise).rejects.toBeInstanceOf(ExecutorHttpError);
		await expect(promise).rejects.toMatchObject({ status: 404 });
		await expect(promise).rejects.toThrow(/404/);
		await expect(promise).rejects.toThrow(/Notebook not found/);
	});

	it("throws ExecutorTimeoutError on abort and wraps network failures in ExecutorError", async () => {
		// Timeout path: fetch that only settles when the signal aborts.
		vi.stubGlobal(
			"fetch",
			vi.fn(
				(_url: string, init?: RequestInit) =>
					new Promise<Response>((_resolve, reject) => {
						init?.signal?.addEventListener("abort", () => {
							const err = new Error("The operation was aborted");
							err.name = "AbortError";
							reject(err);
						});
					}),
			),
		);
		const slowClient = new ExecutorClient({ baseUrl: "http://executor.test", timeoutMs: 20 });
		await expect(slowClient.health()).rejects.toBeInstanceOf(ExecutorTimeoutError);

		// Network failure path.
		vi.stubGlobal("fetch", fetchMock);
		fetchMock.mockRejectedValue(new TypeError("fetch failed"));
		await expect(client().health()).rejects.toBeInstanceOf(ExecutorError);
	});
});

// ---------------------------------------------------------------------------
// Base URL resolution
// ---------------------------------------------------------------------------

describe("base URL resolution", () => {
	it("uses EXECUTOR_URL env, falls back to the default, and strips trailing slashes", async () => {
		fetchMock.mockResolvedValue(
			jsonResponse({
				status: "ok",
				version: "0.2.0",
				data_dir: "/app/data",
				ki_connect_available: false,
			}),
		);
		const previous = process.env.EXECUTOR_URL;

		try {
			process.env.EXECUTOR_URL = "http://executor-env:9999";
			await new ExecutorClient().health();
			expect(fetchMock).toHaveBeenLastCalledWith(
				"http://executor-env:9999/health",
				expect.objectContaining({ method: "GET" }),
			);

			delete process.env.EXECUTOR_URL;
			await new ExecutorClient().health();
			expect(fetchMock).toHaveBeenLastCalledWith(
				"http://executor:8766/health",
				expect.objectContaining({ method: "GET" }),
			);

			await new ExecutorClient({ baseUrl: "http://executor.test:8766///" }).health();
			expect(fetchMock).toHaveBeenLastCalledWith(
				"http://executor.test:8766/health",
				expect.objectContaining({ method: "GET" }),
			);
		} finally {
			if (previous === undefined) {
				delete process.env.EXECUTOR_URL;
			} else {
				process.env.EXECUTOR_URL = previous;
			}
		}
	});
});
