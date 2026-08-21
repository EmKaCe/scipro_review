/**
 * @file L5 API-contract tests for POST /api/submissions/[id]/autofix/verify.
 *
 * Real temp DATA_DIR (assignments.yaml + metadata + results.json on disk),
 * real Request/Response objects, executor-client mocked. Covers: happy
 * path (the notebook context is built from the STORED execution result,
 * never the original file; request translation + response passthrough),
 * wire-shaped stored cells, 400 validation (cellIndex/patchedSource/range/
 * markdown target), 404 mapping (unknown assignment / submission), and
 * executor transport failures.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestEvent } from "@sveltejs/kit";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { upsertSubmission } from "$lib/server/metadata";
import { setResult, type StoredExecutionResult } from "$lib/server/results-store";

import { POST as verifyPOST } from "../../routes/api/submissions/[id]/autofix/verify/+server";

// ---------------------------------------------------------------------------
// Executor client mock (the route proxies to it)
// ---------------------------------------------------------------------------

const mockExecutor = vi.hoisted(() => ({
	verifyAutofix: vi.fn(),
}));

vi.mock("$lib/server/executor-client", async (importOriginal) => {
	const actual = await importOriginal<typeof import("$lib/server/executor-client")>();
	return {
		...actual,
		getExecutorClient: () => mockExecutor,
	};
});

// ---------------------------------------------------------------------------
// Fixtures & helpers
// ---------------------------------------------------------------------------

const ASSIGNMENTS_YAML = `assignments:
  - id: soil_contamination
    title: Soil Contamination by Factories
    enabled: true
    criteria_files: []
    dimensions: []
`;

const ASSIGNMENT = "soil_contamination";
const STUDENT = "2026SS_38";

/** Stored execution result (frontend shape) — the notebook context source. */
const STORED_RESULT: StoredExecutionResult = {
	success: true,
	notebookPath: `submissions/${ASSIGNMENT}/${STUDENT}.ipynb`,
	cells: [
		{
			index: 0,
			type: "code",
			source: "x = 5",
			original_source: "x = 5",
			output: "",
			error: null,
			traceback: null,
			execution_count: 1,
			marker: "different",
		},
		{
			index: 1,
			type: "code",
			source: "print(x",
			original_source: "print(x",
			output: "",
			error: "SyntaxError: invalid syntax",
			traceback: ["SyntaxError: invalid syntax"],
			execution_count: null,
			marker: "error",
		},
	],
	totalCells: 2,
	executedCells: 1,
	errorCells: 1,
	durationSeconds: 1.2,
	fixedCells: null,
	modifiedFiles: [],
	preprocessing: {
		cellsModified: 0,
		totalEdits: 0,
		editTypes: {},
		llmPreprocessing: "skipped",
		llmAnalysis: false,
	},
	autofix: { attempts: 0, succeeded: 0 },
};

const VERIFY_RESULT = {
	fixed: true,
	patchedSource: "print(x)",
	reRunOutput: "5\n",
	reRunError: null,
	fixedCells: [],
	totalCells: 2,
	executedCells: 2,
	errorCells: 0,
};

function jsonRequest(
	body: unknown,
	url = `http://localhost/api/submissions/${STUDENT}/autofix/verify`,
): Request {
	return new Request(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

function asEvent(request: Request): RequestEvent {
	// Nested route: /api/submissions/<id>/autofix/verify → id at -3.
	const segments = request.url.split("/");
	const id = segments.at(-3) ?? STUDENT;
	return { request, url: new URL(request.url), params: { id } } as unknown as RequestEvent;
}

const VALID_BODY = { cellIndex: 1, patchedSource: "print(x)" };

let dataDir: string;

beforeEach(async () => {
	dataDir = await mkdtemp(path.join(os.tmpdir(), "scipro-autofix-verify-"));
	process.env.DATA_DIR = dataDir;
	await writeFile(path.join(dataDir, "assignments.yaml"), ASSIGNMENTS_YAML, "utf-8");
	await upsertSubmission(ASSIGNMENT, STUDENT, {
		notebookPath: `submissions/${ASSIGNMENT}/${STUDENT}.ipynb`,
	});
	await setResult(ASSIGNMENT, STUDENT, STORED_RESULT);

	mockExecutor.verifyAutofix.mockReset();
	mockExecutor.verifyAutofix.mockResolvedValue(VERIFY_RESULT);
});

afterEach(async () => {
	delete process.env.DATA_DIR;
	await rm(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// POST /api/submissions/[id]/autofix/verify
// ---------------------------------------------------------------------------

describe("POST /api/submissions/[id]/autofix/verify", () => {
	it("builds the notebook context from the STORED execution and verifies", async () => {
		const response = await verifyPOST(asEvent(jsonRequest(VALID_BODY)));

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(VERIFY_RESULT);
		expect(mockExecutor.verifyAutofix).toHaveBeenCalledTimes(1);
		expect(mockExecutor.verifyAutofix).toHaveBeenCalledWith(
			{
				cells: [
					{ source: "x = 5", cellType: "code" },
					{ source: "print(x", cellType: "code" },
				],
				targetCellIndex: 1,
				patchedSource: "print(x)",
				assignmentId: ASSIGNMENT,
				timeout: 30,
			},
			// The whole-notebook re-run gets the per-notebook HTTP budget
			// (settings default), not the tighter single-request default.
			120_000,
		);
	});

	it("handles wire-shaped stored cells (snake_case cell_type)", async () => {
		await setResult(ASSIGNMENT, STUDENT, {
			...STORED_RESULT,
			cells: [
				{
					cell_index: 0,
					execution_count: 1,
					source: "x = 5",
					original_source: "x = 5",
					output_text: "",
					error: null,
					traceback: null,
					cell_type: "code",
				},
				{
					cell_index: 1,
					execution_count: null,
					source: "print(x",
					original_source: "print(x",
					output_text: "",
					error: "SyntaxError: invalid syntax",
					traceback: null,
					cell_type: "code",
				},
			],
		} as unknown as StoredExecutionResult);

		const response = await verifyPOST(asEvent(jsonRequest(VALID_BODY)));

		expect(response.status).toBe(200);
		expect(mockExecutor.verifyAutofix).toHaveBeenCalledWith(
			expect.objectContaining({
				cells: [
					{ source: "x = 5", cellType: "code" },
					{ source: "print(x", cellType: "code" },
				],
				targetCellIndex: 1,
			}),
			expect.any(Number),
		);
	});

	it("returns 400 for missing/invalid cellIndex or patchedSource", async () => {
		await expect(
			verifyPOST(asEvent(jsonRequest({ patchedSource: "print(x)" }))),
		).rejects.toMatchObject({
			status: 400,
		});
		await expect(
			verifyPOST(asEvent(jsonRequest({ cellIndex: 1.5, patchedSource: "print(x)" }))),
		).rejects.toMatchObject({ status: 400 });
		await expect(
			verifyPOST(asEvent(jsonRequest({ cellIndex: 1, patchedSource: "" }))),
		).rejects.toMatchObject({ status: 400 });
		await expect(verifyPOST(asEvent(jsonRequest("not json")))).rejects.toMatchObject({
			status: 400,
		});
	});

	it("returns 400 for an out-of-range or markdown target cell", async () => {
		await expect(
			verifyPOST(asEvent(jsonRequest({ cellIndex: 5, patchedSource: "print(x)" }))),
		).rejects.toMatchObject({
			status: 400,
			body: expect.objectContaining({ message: expect.stringContaining("out of range") }),
		});

		await setResult(ASSIGNMENT, STUDENT, {
			...STORED_RESULT,
			cells: [
				{
					index: 0,
					type: "markdown",
					source: "# Title",
					original_source: "# Title",
					output: "",
					error: null,
					traceback: null,
					execution_count: null,
					marker: "different",
				},
			],
		});
		await expect(
			verifyPOST(asEvent(jsonRequest({ cellIndex: 0, patchedSource: "print(x)" }))),
		).rejects.toMatchObject({
			status: 400,
			body: expect.objectContaining({ message: expect.stringContaining("not a code cell") }),
		});
	});

	it("returns 404 for an unknown assignment or submission", async () => {
		await expect(
			verifyPOST(
				asEvent(
					jsonRequest(
						VALID_BODY,
						`http://localhost/api/submissions/${STUDENT}/autofix/verify?assignment=nope`,
					),
				),
			),
		).rejects.toMatchObject({ status: 404 });

		await expect(
			verifyPOST(
				asEvent(
					jsonRequest(
						VALID_BODY,
						"http://localhost/api/submissions/2026SS_99/autofix/verify",
					),
				),
			),
		).rejects.toMatchObject({ status: 404 });
	});

	it("propagates executor transport failures", async () => {
		mockExecutor.verifyAutofix.mockRejectedValue(
			new Error("Executor request failed: http://executor:8766/execute/autofix-run"),
		);

		await expect(verifyPOST(asEvent(jsonRequest(VALID_BODY)))).rejects.toThrow(
			"Executor request failed",
		);
	});
});
