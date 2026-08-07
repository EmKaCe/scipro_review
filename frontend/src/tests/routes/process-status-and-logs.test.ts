// @vitest-environment node
/**
 * @file L5 API-contract tests for live batch progress + executor log proxy:
 *
 *   GET  /api/submissions/process/status — reads the in-memory run record
 *   POST /api/submissions/process       — writes progress while looping
 *   GET  /api/executor/logs             — proxies the executor ring buffer
 *
 * Real temp DATA_DIR + real Request/Response objects, mocked executor client.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestEvent } from "@sveltejs/kit";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
	beginProcessRun,
	endProcessRun,
	getProcessRun,
	resetProcessRun,
	updateProcessRun,
} from "$lib/server/process-progress";
import { upsertSubmission } from "$lib/server/metadata";

import { POST as batchPOST } from "../../routes/api/submissions/process/+server";
import { GET as statusGET } from "../../routes/api/submissions/process/status/+server";
import { GET as logsGET } from "../../routes/api/executor/logs/+server";

// ---------------------------------------------------------------------------
// Executor client mock
// ---------------------------------------------------------------------------

const mockClient = vi.hoisted(() => ({
	executeNotebook: vi.fn(),
	fetchLogs: vi.fn(),
}));

vi.mock("$lib/server/executor-client", async (importOriginal) => {
	const actual = await importOriginal<typeof import("$lib/server/executor-client")>();
	return {
		...actual,
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
`;

const ASSIGNMENT = "soil_contamination";
const notebookPath = (studentId: string) => `submissions/${ASSIGNMENT}/${studentId}.ipynb`;

function executionResult(
	studentId: string,
	opts: { autofix?: { attempts: number; succeeded: number } } = {},
) {
	return {
		success: true,
		notebookPath: notebookPath(studentId),
		cells: [],
		totalCells: 0,
		executedCells: 0,
		errorCells: 0,
		durationSeconds: 0.5,
		preprocessing: {
			cellsModified: 0,
			totalEdits: 0,
			editTypes: {},
			llmPreprocessing: "skipped",
			llmAnalysis: false,
		},
		modifiedFiles: [],
		autofix: opts.autofix ?? { attempts: 0, succeeded: 0 },
	};
}

let dataDir: string;

beforeEach(async () => {
	dataDir = await mkdtemp(path.join(os.tmpdir(), "scipro-progress-"));
	process.env.DATA_DIR = dataDir;
	await mkdir(path.join(dataDir, "submissions", ASSIGNMENT), { recursive: true });
	await writeFile(path.join(dataDir, "assignments.yaml"), ASSIGNMENTS_YAML);
	await writeFile(
		path.join(dataDir, "submissions", ASSIGNMENT, "2026SS_01.ipynb"),
		JSON.stringify({ cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 }),
	);
	await writeFile(
		path.join(dataDir, "submissions", ASSIGNMENT, "2026SS_02.ipynb"),
		JSON.stringify({ cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 }),
	);
	// Seed metadata so the process route sees runnable (pending) targets.
	await upsertSubmission(ASSIGNMENT, "2026SS_01", {
		semester: "2026SS",
		fileName: "2026SS_01.ipynb",
		notebookPath: notebookPath("2026SS_01"),
		status: "pending",
	});
	await upsertSubmission(ASSIGNMENT, "2026SS_02", {
		semester: "2026SS",
		fileName: "2026SS_02.ipynb",
		notebookPath: notebookPath("2026SS_02"),
		status: "pending",
	});
	mockClient.executeNotebook.mockReset();
	mockClient.fetchLogs.mockReset();
	resetProcessRun();
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

async function readJson(resp: Response): Promise<Record<string, unknown>> {
	return (await resp.json()) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// GET /api/submissions/process/status
// ---------------------------------------------------------------------------

describe("GET /api/submissions/process/status", () => {
	it("reports idle when no run is in flight", async () => {
		const body = await readJson(await statusGET(makeEvent("/api/submissions/process/status")));
		expect(body.running).toBe(false);
		expect(body.done).toBe(0);
		expect(body.total).toBe(0);
	});

	it("returns live progress written by the process route helpers", async () => {
		beginProcessRun(ASSIGNMENT, 5);
		updateProcessRun({ currentStudentId: "2026SS_02", currentStartedAt: 123456 });
		updateProcessRun({ done: 2, autofixAttempts: 3, autofixSucceeded: 1 });

		const body = await readJson(await statusGET(makeEvent("/api/submissions/process/status")));

		expect(body.running).toBe(true);
		expect(body.assignmentId).toBe(ASSIGNMENT);
		expect(body.total).toBe(5);
		expect(body.done).toBe(2);
		expect(body.currentStudentId).toBe("2026SS_02");
		expect(body.currentStartedAt).toBe(123456);
		expect(body.autofixAttempts).toBe(3);
		expect(body.autofixSucceeded).toBe(1);

		endProcessRun();
		const finished = await readJson(
			await statusGET(makeEvent("/api/submissions/process/status")),
		);
		expect(finished.running).toBe(false);
		// Final tallies survive the run end (UI shows the summary chip).
		expect(finished.done).toBe(2);
		expect(finished.total).toBe(5);
	});
});

// ---------------------------------------------------------------------------
// POST /api/submissions/process — progress + autofix tallies
// ---------------------------------------------------------------------------

describe("POST /api/submissions/process", () => {
	it("writes per-notebook progress and reports autofix totals", async () => {
		mockClient.executeNotebook
			.mockResolvedValueOnce(
				executionResult("2026SS_01", { autofix: { attempts: 2, succeeded: 1 } }),
			)
			.mockResolvedValueOnce(executionResult("2026SS_02"));

		const resp = await batchPOST(
			makeEvent("/api/submissions/process", {
				request: new Request("http://localhost/api/submissions/process", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ assignmentId: ASSIGNMENT }),
				}),
			}),
		);
		const body = await readJson(resp);

		expect(body.submitted).toBe(2);
		expect(body.succeeded).toBe(2);
		expect(body.autofixAttempts).toBe(2);
		expect(body.autofixSucceeded).toBe(1);

		// Run ended: not running, final tallies retained.
		const final = getProcessRun();
		expect(final.running).toBe(false);
		expect(final.total).toBe(2);
		expect(final.done).toBe(2);
		expect(final.autofixAttempts).toBe(2);
		expect(final.autofixSucceeded).toBe(1);
		expect(final.currentStudentId).toBeNull();
	});

	it("records an error row and keeps progress counting", async () => {
		mockClient.executeNotebook
			.mockResolvedValueOnce(executionResult("2026SS_01"))
			.mockRejectedValueOnce(new Error("executor boom"));

		const resp = await batchPOST(
			makeEvent("/api/submissions/process", {
				request: new Request("http://localhost/api/submissions/process", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ assignmentId: ASSIGNMENT }),
				}),
			}),
		);
		const body = await readJson(resp);

		expect(body.succeeded).toBe(1);
		expect(body.failed).toBe(1);
		expect(getProcessRun().done).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// GET /api/executor/logs — proxy
// ---------------------------------------------------------------------------

describe("GET /api/executor/logs", () => {
	it("proxies the executor ring buffer entries", async () => {
		mockClient.fetchLogs.mockResolvedValue({
			entries: [
				{ id: 1, ts: 1000, level: "info", logger: "runner", message: "Executing: x.ipynb" },
				{ id: 2, ts: 1001, level: "warning", logger: "auto_fix", message: "still failing" },
			],
			truncated: false,
		});

		const body = await readJson(await logsGET(makeEvent("/api/executor/logs?limit=50")));

		expect(mockClient.fetchLogs).toHaveBeenCalledWith(50);
		expect(body.entries).toHaveLength(2);
		expect((body.entries as Array<Record<string, unknown>>)[1].logger).toBe("auto_fix");
	});

	it("defaults and clamps the limit", async () => {
		mockClient.fetchLogs.mockResolvedValue({ entries: [], truncated: false });

		await logsGET(makeEvent("/api/executor/logs"));
		expect(mockClient.fetchLogs).toHaveBeenCalledWith(200);

		await logsGET(makeEvent("/api/executor/logs?limit=99999"));
		expect(mockClient.fetchLogs).toHaveBeenCalledWith(1000);

		await logsGET(makeEvent("/api/executor/logs?limit=abc"));
		expect(mockClient.fetchLogs).toHaveBeenCalledWith(200);
	});
});
