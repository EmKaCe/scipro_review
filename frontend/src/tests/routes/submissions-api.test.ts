/**
 * @file L5 API-contract tests for the /api/submissions routes.
 *
 * Real temp DATA_DIR (assignments.yaml + metadata.json + results.json on
 * disk), real Request/Response objects, and a mocked executor client.
 * Covers: list/detail shapes, upload classification + persistence, batch
 * and single execution status transitions, grading save/finalize, export.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestEvent } from "@sveltejs/kit";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { listSubmissions, upsertSubmission } from "$lib/server/metadata";
import { readResults, writeResults, type ResultsFile } from "$lib/server/results-store";
import type { ExecutionResult } from "$lib/server/executor-client";

import { GET as listGET } from "../../routes/api/submissions/+server";
import { GET as detailGET } from "../../routes/api/submissions/[id]/+server";
import { POST as uploadPOST } from "../../routes/api/submissions/upload/+server";
import { POST as batchPOST } from "../../routes/api/submissions/process/+server";
import { POST as singleProcessPOST } from "../../routes/api/submissions/[id]/process/+server";
import { POST as savePOST } from "../../routes/api/submissions/[id]/save/+server";
import { POST as gradePOST } from "../../routes/api/submissions/[id]/grade/+server";
import { GET as exportGET } from "../../routes/api/submissions/[id]/export/+server";

// ---------------------------------------------------------------------------
// Executor client mock
// ---------------------------------------------------------------------------

const mockClient = vi.hoisted(() => ({
	executeBatch: vi.fn(),
	executeNotebook: vi.fn(),
	health: vi.fn(),
}));

vi.mock("$lib/server/executor-client", async (importOriginal) => {
	const actual = await importOriginal<typeof import("$lib/server/executor-client")>();
	return {
		...actual, // keep translateCell + error classes real
		getExecutorClient: () => mockClient,
	};
});

// ---------------------------------------------------------------------------
// Fixtures & helpers
// ---------------------------------------------------------------------------

const ASSIGNMENTS_YAML = `assignments:
  - id: soil_contamination
    title: Soil Contamination by Factories
    enabled: true
    criteria_files:
      - data/criteria/general.yaml
    dimensions:
      - code_quality_design
  - id: molecular_dynamics
    title: Molecular Dynamics
    enabled: false
    criteria_files: []
    dimensions: []
`;

const NOTEBOOK_JSON = JSON.stringify({ cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 });

const ASSIGNMENT = "soil_contamination";

const notebookPath = (studentId: string) => `submissions/${ASSIGNMENT}/${studentId}.ipynb`;

function fullExecutionResult(studentId: string): ExecutionResult {
	return {
		success: true,
		notebookPath: notebookPath(studentId),
		cells: [
			{
				index: 0,
				type: "code",
				source: "import numpy as np",
				original_source: "import numpy as np",
				output: "",
				error: null,
				traceback: null,
				execution_count: 1,
				marker: "different",
			},
			{
				index: 1,
				type: "code",
				source: "x = np.array([1, 2])",
				original_source: "x = np.array([1, 2])",
				output: "array([1, 2])",
				error: null,
				traceback: null,
				execution_count: 2,
				marker: "different",
			},
		],
		totalCells: 2,
		executedCells: 2,
		errorCells: 0,
		durationSeconds: 0.75,
		preprocessing: {
			cellsModified: 0,
			totalEdits: 0,
			editTypes: {},
			llmPreprocessing: "skipped",
			llmAnalysis: false,
		},
		modifiedFiles: [],
	};
}

let dataDir: string;

beforeEach(async () => {
	dataDir = await mkdtemp(path.join(os.tmpdir(), "scipro-routes-"));
	process.env.DATA_DIR = dataDir;
	await mkdir(path.join(dataDir, "submissions", ASSIGNMENT), { recursive: true });
	await writeFile(path.join(dataDir, "assignments.yaml"), ASSIGNMENTS_YAML);
	mockClient.executeBatch.mockReset();
	mockClient.executeNotebook.mockReset();
});

afterEach(async () => {
	delete process.env.DATA_DIR;
	await rm(dataDir, { recursive: true, force: true });
});

/** Minimal RequestEvent stub (routes only touch url/params/request). */
function makeEvent(
	url: string,
	opts: { params?: Record<string, string>; request?: Request } = {},
): RequestEvent {
	const absolute = url.startsWith("http") ? url : `http://localhost${url}`;
	return {
		url: new URL(absolute),
		params: opts.params ?? {},
		request: opts.request ?? new Request(absolute, { method: "GET" }),
	} as unknown as RequestEvent;
}

function jsonRequest(url: string, body: unknown): Request {
	const absolute = url.startsWith("http") ? url : `http://localhost${url}`;
	return new Request(absolute, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

async function readJson(resp: Response): Promise<Record<string, any>> {
	return (await resp.json()) as Record<string, any>;
}

/**
 * Build a RequestEvent whose request.formData() returns the given FormData.
 * A real undici Request can't round-trip jsdom FormData/File in the vitest
 * jsdom environment (cross-realm brand mismatch), so we stub the method —
 * same pattern as the assignments-api suite.
 */
function uploadEvent(url: string, form: FormData): RequestEvent {
	return {
		url: new URL(`http://localhost${url}`),
		params: {},
		request: { formData: async () => form },
	} as unknown as RequestEvent;
}

/** FormData stand-in with get/getAll/entries — jsdom's FormData is unreliable cross-realm. */
function formDataWith(fields: Array<[string, string]>, files: File[] = []): FormData {
	const entries: Array<[string, string | File]> = [
		...fields,
		...files.map((f) => ["files", f] as [string, File]),
	];
	return {
		get: (key: string) => {
			const hit = entries.find(([k]) => k === key);
			return hit ? (hit[1] as string) : null;
		},
		getAll: (key: string) => entries.filter(([k]) => k === key).map(([, v]) => v),
		entries: () => entries[Symbol.iterator](),
	} as unknown as FormData;
}

/** Minimal File stand-in — jsdom's File has no arrayBuffer(). */
function fakeFile(name: string, content = "{}", type = "application/octet-stream"): File {
	return {
		name,
		type,
		arrayBuffer: async () => new TextEncoder().encode(content).buffer,
	} as unknown as File;
}

/** Assert a handler rejects with a SvelteKit HttpError (status + body.message). */
async function expectApiError(
	promise: Promise<unknown>,
	status: number,
	messagePart?: string,
): Promise<void> {
	try {
		await promise;
	} catch (err) {
		const e = err as { status?: number; body?: { message?: string } };
		expect(e.status).toBe(status);
		if (messagePart !== undefined) {
			expect(e.body?.message).toContain(messagePart);
		}
		return;
	}
	expect.unreachable(`expected handler to fail with ${status}`);
}

async function seedSubmission(
	studentId: string,
	status: "pending" | "executing" | "executed" | "error" | "graded" = "pending",
	extra: Record<string, unknown> = {},
) {
	return upsertSubmission(ASSIGNMENT, studentId, {
		semester: "2026SS",
		fileName: `${studentId}.ipynb`,
		notebookPath: notebookPath(studentId),
		status,
		...extra,
	});
}

// ---------------------------------------------------------------------------
// GET /api/submissions
// ---------------------------------------------------------------------------

describe("GET /api/submissions", () => {
	it("lists records for the default (first enabled) assignment, enriched with cellSummary", async () => {
		await seedSubmission("2026SS_01", "executed", { cellSummary: "4 cells" });
		await seedSubmission("2026SS_02", "executed");
		await writeResults(ASSIGNMENT, {
			"2026SS_02": {
				success: true,
				notebookPath: notebookPath("2026SS_02"),
				cells: [],
				totalCells: 12,
				executedCells: 12,
				errorCells: 2,
				durationSeconds: 1,
				preprocessing: {
					cellsModified: 0,
					totalEdits: 0,
					editTypes: {},
					llmPreprocessing: "skipped",
					llmAnalysis: false,
				},
				modifiedFiles: [],
			},
		} as ResultsFile);

		const body = await readJson(await listGET(makeEvent("/api/submissions")));

		expect(body.assignmentId).toBe(ASSIGNMENT);
		const [first, second] = body.submissions as Array<Record<string, unknown>>;
		expect(first.studentId).toBe("2026SS_01");
		expect(first.cellSummary).toBe("4 cells");
		expect(second.studentId).toBe("2026SS_02");
		expect(second.cellSummary).toBe("12 cells, 2 errors");
	});

	it("honors ?assignment= and 404s unknown assignments", async () => {
		await seedSubmission("2026SS_01", "pending");

		const explicit = await readJson(
			await listGET(makeEvent(`/api/submissions?assignment=${ASSIGNMENT}`)),
		);
		expect(explicit.submissions).toHaveLength(1);

		await expectApiError(
			listGET(makeEvent("/api/submissions?assignment=does_not_exist")),
			404,
			'Assignment "does_not_exist" not found',
		);
	});
});

// ---------------------------------------------------------------------------
// GET /api/submissions/[id]
// ---------------------------------------------------------------------------

describe("GET /api/submissions/[id]", () => {
	it("translates stored wire-shaped cells into the frontend shape", async () => {
		await seedSubmission("2026SS_03", "executed");
		await writeResults(ASSIGNMENT, {
			"2026SS_03": {
				success: true,
				notebookPath: notebookPath("2026SS_03"),
				cells: [
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
						source: "1/0",
						output_text: "",
						error: "ZeroDivisionError: division by zero",
						traceback: ["Traceback..."],
					},
				],
				totalCells: 2,
				executedCells: 2,
				errorCells: 1,
				durationSeconds: 0.5,
				preprocessing: {
					cellsModified: 0,
					totalEdits: 0,
					editTypes: {},
					llmPreprocessing: "skipped",
					llmAnalysis: false,
				},
				modifiedFiles: [],
			},
		} as unknown as ResultsFile);

		const body = await readJson(
			await detailGET(
				makeEvent(`/api/submissions/2026SS_03?assignment=${ASSIGNMENT}`, {
					params: { id: "2026SS_03" },
				}),
			),
		);

		expect(body.studentId).toBe("2026SS_03");
		const cells = body.cells as Array<Record<string, unknown>>;
		expect(cells).toHaveLength(2);
		expect(cells[0]).toMatchObject({
			index: 0,
			type: "code",
			source: "import numpy as np",
			output: "",
			marker: "different",
		});
		expect(cells[1]).toMatchObject({
			index: 1,
			marker: "error",
			error: "ZeroDivisionError: division by zero",
		});
	});

	it("returns cells: [] without results and 404s unknown submissions", async () => {
		await seedSubmission("2026SS_03", "executed");

		const body = await readJson(
			await detailGET(
				makeEvent(`/api/submissions/2026SS_03?assignment=${ASSIGNMENT}`, {
					params: { id: "2026SS_03" },
				}),
			),
		);
		expect(body.cells).toEqual([]);

		await expectApiError(
			detailGET(
				makeEvent(`/api/submissions/2026SS_99?assignment=${ASSIGNMENT}`, {
					params: { id: "2026SS_99" },
				}),
			),
			404,
			'Submission "2026SS_99" not found',
		);
	});
});

// ---------------------------------------------------------------------------
// POST /api/submissions/upload
// ---------------------------------------------------------------------------

describe("POST /api/submissions/upload", () => {
	it("classifies and persists a student notebook, upserting a pending record", async () => {
		const form = formDataWith(
			[["assignmentId", ASSIGNMENT]],
			[fakeFile("2026SS_03.ipynb", NOTEBOOK_JSON, "application/json")],
		);

		const body = await readJson(await uploadPOST(uploadEvent("/api/submissions/upload", form)));

		expect(body.results).toHaveLength(1);
		expect(body.results[0]).toMatchObject({
			fileName: "2026SS_03.ipynb",
			kind: "submission",
			studentId: "2026SS_03",
			semester: "2026SS",
			replaced: false,
			notebookPath: notebookPath("2026SS_03"),
		});

		const stored = await readFile(
			path.join(dataDir, "submissions", ASSIGNMENT, "2026SS_03.ipynb"),
			"utf-8",
		);
		expect(stored).toBe(NOTEBOOK_JSON);

		const [record] = await listSubmissions(ASSIGNMENT);
		expect(record.status).toBe("pending");
		expect(record.notebookPath).toBe(notebookPath("2026SS_03"));
	});

	it("re-upload replaces the file, resets status to pending and clears stale results", async () => {
		await seedSubmission("2026SS_03", "executed", {
			grading: { rubric: { a: "b" }, dimensions: {}, updatedAt: new Date().toISOString() },
		});
		await writeResults(ASSIGNMENT, {
			"2026SS_03": {
				success: true,
				notebookPath: notebookPath("2026SS_03"),
				cells: [],
				totalCells: 2,
				executedCells: 2,
				errorCells: 0,
				durationSeconds: 1,
				preprocessing: {
					cellsModified: 0,
					totalEdits: 0,
					editTypes: {},
					llmPreprocessing: "skipped",
					llmAnalysis: false,
				},
				modifiedFiles: [],
			},
		} as ResultsFile);

		const form = formDataWith(
			[["assignmentId", ASSIGNMENT]],
			[fakeFile("2026SS_03.ipynb", NOTEBOOK_JSON)],
		);
		// First upload already persisted the file (dedup by studentId) — write it
		// to disk so persistUpload can report `replaced: true`.
		await writeFile(
			path.join(dataDir, "submissions", ASSIGNMENT, "2026SS_03.ipynb"),
			NOTEBOOK_JSON,
		);

		const body = await readJson(await uploadPOST(uploadEvent("/api/submissions/upload", form)));

		expect(body.results[0].replaced).toBe(true);

		const [record] = await listSubmissions(ASSIGNMENT);
		expect(record.status).toBe("pending");
		expect(record.grading?.rubric).toEqual({ a: "b" }); // grading preserved
		expect(await readResults(ASSIGNMENT)).toEqual({}); // stale results cleared
	});

	it("classifies data files as material-data and applies kind overrides", async () => {
		const form = formDataWith(
			[
				["assignmentId", ASSIGNMENT],
				["kinds", JSON.stringify({ "notes.pdf": "material-data" })],
			],
			[
				fakeFile("soil_samples.csv", "a,b\n1,2", "text/csv"),
				fakeFile("notes.pdf", "pdf", "application/pdf"),
			],
		);

		const body = await readJson(await uploadPOST(uploadEvent("/api/submissions/upload", form)));

		expect(body.results[0]).toMatchObject({
			kind: "material-data",
			relativePath: `materials/${ASSIGNMENT}/input_data/soil_samples.csv`,
		});
		expect(body.results[1]).toMatchObject({
			kind: "material-data",
			relativePath: `materials/${ASSIGNMENT}/input_data/notes.pdf`,
		});
		expect(await listSubmissions(ASSIGNMENT)).toEqual([]); // no metadata records

		const csv = await readFile(
			path.join(dataDir, "materials", ASSIGNMENT, "input_data", "soil_samples.csv"),
			"utf-8",
		);
		expect(csv).toBe("a,b\n1,2");
	});

	it("rejects forced submission overrides and malformed requests", async () => {
		// Non-student notebook forced to submission -> 400.
		const form = formDataWith(
			[
				["assignmentId", ASSIGNMENT],
				["kinds", JSON.stringify({ "foo.ipynb": "submission" })],
			],
			[fakeFile("foo.ipynb", "{}")],
		);
		await expectApiError(
			uploadPOST(uploadEvent("/api/submissions/upload", form)),
			400,
			"file name must match",
		);

		// Missing assignmentId -> 400.
		const noAssignment = formDataWith([], [fakeFile("2026SS_03.ipynb", "{}")]);
		await expectApiError(
			uploadPOST(uploadEvent("/api/submissions/upload", noAssignment)),
			400,
			"assignmentId",
		);

		// No files -> 400.
		const noFiles = formDataWith([["assignmentId", ASSIGNMENT]]);
		await expectApiError(
			uploadPOST(uploadEvent("/api/submissions/upload", noFiles)),
			400,
			"No files",
		);

		// Unknown assignment -> 404.
		const unknown = formDataWith(
			[["assignmentId", "nope"]],
			[fakeFile("2026SS_03.ipynb", "{}")],
		);
		await expectApiError(
			uploadPOST(uploadEvent("/api/submissions/upload", unknown)),
			404,
			'Assignment "nope" not found',
		);
	});
});

// ---------------------------------------------------------------------------
// POST /api/submissions/process (batch)
// ---------------------------------------------------------------------------

describe("POST /api/submissions/process", () => {
	it("batch-executes pending submissions and transitions each status", async () => {
		await seedSubmission("2026SS_01", "pending");
		await seedSubmission("2026SS_02", "pending");
		await seedSubmission("2026SS_03", "executed"); // not pending -> untouched

		mockClient.executeBatch.mockResolvedValue({
			results: [
				{
					notebookPath: notebookPath("2026SS_01"),
					success: true,
					totalCells: 4,
					executedCells: 4,
					errorCells: 0,
					durationSeconds: 1.2,
					error: null,
				},
				{
					notebookPath: notebookPath("2026SS_02"),
					success: false,
					totalCells: 3,
					executedCells: 2,
					errorCells: 1,
					durationSeconds: 0.8,
					error: "NameError: name 'x' is not defined",
				},
			],
			totalNotebooks: 2,
			succeeded: 1,
			failed: 1,
			totalDurationSeconds: 2.0,
		});

		const body = await readJson(
			await batchPOST(
				makeEvent("/api/submissions/process", {
					request: jsonRequest("/api/submissions/process", {}),
				}),
			),
		);

		expect(mockClient.executeBatch).toHaveBeenCalledWith({
			notebooks: [
				{ notebookPath: notebookPath("2026SS_01") },
				{ notebookPath: notebookPath("2026SS_02") },
			],
		});
		expect(body).toMatchObject({
			assignmentId: ASSIGNMENT,
			submitted: 2,
			succeeded: 1,
			failed: 1,
		});

		const records = await listSubmissions(ASSIGNMENT);
		const byId = new Map(records.map((r) => [r.id, r]));
		expect(byId.get("2026SS_01")?.status).toBe("executed");
		expect(byId.get("2026SS_01")?.cellSummary).toBe("4 cells");
		expect(byId.get("2026SS_02")?.status).toBe("error");
		expect(byId.get("2026SS_02")?.error).toBe("NameError: name 'x' is not defined");
		expect(byId.get("2026SS_03")?.status).toBe("executed"); // untouched

		const results = await readResults(ASSIGNMENT);
		expect(results["2026SS_01"]).toMatchObject({ success: true, cells: [], totalCells: 4 });
		expect(results["2026SS_02"]).toMatchObject({
			success: false,
			error: "NameError: name 'x' is not defined",
		});
	});

	it("marks all targets error and 500s when the executor call itself fails", async () => {
		await seedSubmission("2026SS_01", "pending");
		mockClient.executeBatch.mockRejectedValue(new Error("ECONNREFUSED executor:8766"));

		await expectApiError(
			batchPOST(
				makeEvent("/api/submissions/process", {
					request: jsonRequest("/api/submissions/process", {}),
				}),
			),
			500,
			"ECONNREFUSED",
		);

		const [record] = await listSubmissions(ASSIGNMENT);
		expect(record.status).toBe("error");
		expect(record.error).toContain("ECONNREFUSED");
	});

	it("respects the ids subset and 404s unknown ids", async () => {
		await seedSubmission("2026SS_01", "pending");
		await seedSubmission("2026SS_02", "pending");
		mockClient.executeBatch.mockResolvedValue({
			results: [],
			total_notebooks: 0,
			succeeded: 0,
			failed: 0,
			total_duration_seconds: 0,
		});

		const body = await readJson(
			await batchPOST(
				makeEvent("/api/submissions/process", {
					request: jsonRequest("/api/submissions/process", { ids: ["2026SS_02"] }),
				}),
			),
		);
		expect(body.submitted).toBe(1);
		expect(mockClient.executeBatch.mock.calls[0]?.[0]?.notebooks).toEqual([
			{ notebookPath: notebookPath("2026SS_02") },
		]);

		await expectApiError(
			batchPOST(
				makeEvent("/api/submissions/process", {
					request: jsonRequest("/api/submissions/process", { ids: ["2026SS_99"] }),
				}),
			),
			404,
			"2026SS_99",
		);
	});
});

// ---------------------------------------------------------------------------
// POST /api/submissions/[id]/process (single)
// ---------------------------------------------------------------------------

describe("POST /api/submissions/[id]/process", () => {
	it("executes a single submission and stores the full cell list", async () => {
		await seedSubmission("2026SS_03", "pending");
		mockClient.executeNotebook.mockResolvedValue(fullExecutionResult("2026SS_03"));

		const url = `/api/submissions/2026SS_03/process?assignment=${ASSIGNMENT}`;
		const body = await readJson(
			await singleProcessPOST(
				makeEvent(url, {
					params: { id: "2026SS_03" },
					request: jsonRequest(url, {}),
				}),
			),
		);

		expect(mockClient.executeNotebook).toHaveBeenCalledWith({
			notebookPath: notebookPath("2026SS_03"),
			assignmentContext: "Soil Contamination by Factories",
		});
		expect(body.cells).toHaveLength(2);
		expect(body.record).toMatchObject({ status: "executed", cellSummary: "2 cells" });

		const results = await readResults(ASSIGNMENT);
		expect(results["2026SS_03"]?.cells).toHaveLength(2);
	});

	it("marks the record error and 500s on executor failure; 409 while executing", async () => {
		await seedSubmission("2026SS_03", "pending");
		mockClient.executeNotebook.mockRejectedValue(new Error("kernel died"));

		const url = `/api/submissions/2026SS_03/process?assignment=${ASSIGNMENT}`;
		await expectApiError(
			singleProcessPOST(
				makeEvent(url, {
					params: { id: "2026SS_03" },
					request: jsonRequest(url, {}),
				}),
			),
			500,
			"kernel died",
		);
		const [record] = await listSubmissions(ASSIGNMENT);
		expect(record.status).toBe("error");
		expect(record.error).toContain("kernel died");

		await seedSubmission("2026SS_04", "executing");
		const url2 = `/api/submissions/2026SS_04/process?assignment=${ASSIGNMENT}`;
		await expectApiError(
			singleProcessPOST(
				makeEvent(url2, {
					params: { id: "2026SS_04" },
					request: jsonRequest(url2, {}),
				}),
			),
			409,
			"already executing",
		);
	});
});

// ---------------------------------------------------------------------------
// POST /api/submissions/[id]/save
// ---------------------------------------------------------------------------

describe("POST /api/submissions/[id]/save", () => {
	it("merges grading state without touching the status", async () => {
		await seedSubmission("2026SS_03", "executed");

		const first = await readJson(
			await savePOST(
				makeEvent(`/api/submissions/2026SS_03/save?assignment=${ASSIGNMENT}`, {
					params: { id: "2026SS_03" },
					request: jsonRequest(
						`/api/submissions/2026SS_03/save?assignment=${ASSIGNMENT}`,
						{
							rubric: { data_quality: "complete" },
							dimensions: { code_quality_design: 1.5 },
							notes: "first pass",
						},
					),
				}),
			),
		);
		expect(first.status).toBe("executed");
		expect(first.grading).toMatchObject({
			rubric: { data_quality: "complete" },
			dimensions: { code_quality_design: 1.5 },
			notes: "first pass",
		});

		const second = await readJson(
			await savePOST(
				makeEvent(`/api/submissions/2026SS_03/save?assignment=${ASSIGNMENT}`, {
					params: { id: "2026SS_03" },
					request: jsonRequest(
						`/api/submissions/2026SS_03/save?assignment=${ASSIGNMENT}`,
						{
							notes: "second pass",
						},
					),
				}),
			),
		);
		expect(second.grading?.rubric).toEqual({ data_quality: "complete" }); // merged, not replaced
		expect(second.grading?.notes).toBe("second pass");
		expect(second.status).toBe("executed");
	});

	it("400s malformed grading payloads and 404s unknown submissions", async () => {
		await seedSubmission("2026SS_03", "executed");

		await expectApiError(
			savePOST(
				makeEvent(`/api/submissions/2026SS_03/save?assignment=${ASSIGNMENT}`, {
					params: { id: "2026SS_03" },
					request: jsonRequest(
						`/api/submissions/2026SS_03/save?assignment=${ASSIGNMENT}`,
						{
							dimensions: { code_quality_design: "high" },
						},
					),
				}),
			),
			400,
			"dimensions",
		);
		await expectApiError(
			savePOST(
				makeEvent(`/api/submissions/2026SS_99/save?assignment=${ASSIGNMENT}`, {
					params: { id: "2026SS_99" },
					request: jsonRequest(
						`/api/submissions/2026SS_99/save?assignment=${ASSIGNMENT}`,
						{ notes: "x" },
					),
				}),
			),
			404,
			"2026SS_99",
		);
	});
});

// ---------------------------------------------------------------------------
// POST /api/submissions/[id]/grade
// ---------------------------------------------------------------------------

describe("POST /api/submissions/[id]/grade", () => {
	it("finalizes an executed record with teacherGrade", async () => {
		await seedSubmission("2026SS_03", "executed");

		const body = await readJson(
			await gradePOST(
				makeEvent(`/api/submissions/2026SS_03/grade?assignment=${ASSIGNMENT}`, {
					params: { id: "2026SS_03" },
					request: jsonRequest(
						`/api/submissions/2026SS_03/grade?assignment=${ASSIGNMENT}`,
						{
							teacherGrade: 8.5,
						},
					),
				}),
			),
		);
		expect(body.status).toBe("graded");
		expect(body.teacherGrade).toBe(8.5);

		const [record] = await listSubmissions(ASSIGNMENT);
		expect(record.status).toBe("graded");
		expect(record.teacherGrade).toBe(8.5);
	});

	it("rejects invalid transitions and missing teacherGrade", async () => {
		await seedSubmission("2026SS_03", "pending"); // pending -> graded is illegal

		await expectApiError(
			gradePOST(
				makeEvent(`/api/submissions/2026SS_03/grade?assignment=${ASSIGNMENT}`, {
					params: { id: "2026SS_03" },
					request: jsonRequest(
						`/api/submissions/2026SS_03/grade?assignment=${ASSIGNMENT}`,
						{
							teacherGrade: 5,
						},
					),
				}),
			),
			409,
			"Invalid status transition",
		);

		await expectApiError(
			gradePOST(
				makeEvent(`/api/submissions/2026SS_03/grade?assignment=${ASSIGNMENT}`, {
					params: { id: "2026SS_03" },
					request: jsonRequest(
						`/api/submissions/2026SS_03/grade?assignment=${ASSIGNMENT}`,
						{},
					),
				}),
			),
			400,
			"teacherGrade",
		);
	});
});

// ---------------------------------------------------------------------------
// GET /api/submissions/[id]/export
// ---------------------------------------------------------------------------

describe("GET /api/submissions/[id]/export", () => {
	it("returns the grading YAML as an attachment", async () => {
		await seedSubmission("2026SS_03", "graded", {
			teacherGrade: 12,
			grading: {
				rubric: { data_quality: "complete" },
				dimensions: { code_quality_design: 1.5 },
				notes: "Good work",
				updatedAt: new Date().toISOString(),
			},
		});

		const resp = await exportGET(
			makeEvent(`/api/submissions/2026SS_03/export?assignment=${ASSIGNMENT}`, {
				params: { id: "2026SS_03" },
			}),
		);

		expect(resp.status).toBe(200);
		expect(resp.headers.get("content-disposition")).toBe(
			'attachment; filename="2026SS_03.yaml"',
		);
		expect(resp.headers.get("content-type")).toContain("application/yaml");
		const yaml = await resp.text();
		expect(yaml).toContain("student_id: 2026SS_03");
		expect(yaml).toContain("assignment: soil_contamination");
		// Default kind = student copy: v2 evaluation schema, no teacher fields
		expect(yaml).toContain("reviewer: SciPro Review");
		expect(yaml).toContain("feedback: {}");
		expect(yaml).not.toContain("teacher_grade");
		expect(yaml).not.toContain("file_name");
		expect(yaml).toContain("notes: |-");
	});

	it("returns the teacher YAML (kind=teacher) with the full record", async () => {
		await seedSubmission("2026SS_03", "graded", {
			teacherGrade: 12,
			grading: {
				rubric: { data_quality: "complete" },
				dimensions: { code_quality_design: 1.5 },
				notes: "Good work",
				updatedAt: new Date().toISOString(),
			},
		});

		const resp = await exportGET(
			makeEvent(`/api/submissions/2026SS_03/export?assignment=${ASSIGNMENT}&kind=teacher`, {
				params: { id: "2026SS_03" },
			}),
		);

		expect(resp.status).toBe(200);
		expect(resp.headers.get("content-disposition")).toBe(
			'attachment; filename="2026SS_03-teacher.yaml"',
		);
		const yaml = await resp.text();
		expect(yaml).toContain("teacher_grade: 12");
		expect(yaml).toContain("  data_quality: complete");
		expect(yaml).toContain("  code_quality_design: 1.5");
	});

	it("404s unknown submissions", async () => {
		await expectApiError(
			exportGET(
				makeEvent(`/api/submissions/2026SS_99/export?assignment=${ASSIGNMENT}`, {
					params: { id: "2026SS_99" },
				}),
			),
			404,
			"2026SS_99",
		);
	});
});
