// @vitest-environment node
/**
 * @file L5 API-contract tests for the batch pre-evaluation wiring (Phase 4c):
 *
 *   POST /api/submissions/pre-evaluate        — batch loop + per-row summary
 *   GET  /api/submissions/pre-evaluate/status — live run progress
 *
 * Real temp DATA_DIR + real Request/Response objects; the pre-evaluation
 * service is vi.mocked (no KI Connect calls). Covers the happy path
 * (preEval persisted per submission + summary), per-row failure isolation,
 * the 409 already-running guard, and the status endpoint retaining final
 * tallies after completion.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestEvent } from "@sveltejs/kit";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ExecutionResult } from "$lib/server/executor-client";
import { upsertSubmission } from "$lib/server/metadata";
import {
	beginPreEvalRun,
	endPreEvalRun,
	getPreEvalRun,
	resetPreEvalRun,
	updatePreEvalRun,
} from "$lib/server/pre-eval-progress";
import { readResults, writeResults } from "$lib/server/results-store";

import { POST as preEvaluatePOST } from "../../routes/api/submissions/pre-evaluate/+server";
import { GET as preEvaluateStatusGET } from "../../routes/api/submissions/pre-evaluate/status/+server";

// ---------------------------------------------------------------------------
// Pre-evaluation service mock — the route must never hit KI Connect.
// ---------------------------------------------------------------------------

const preEvalService = vi.hoisted(() => ({
	preEvaluateSubmission: vi.fn(),
}));

vi.mock("$lib/server/copilot/pre-evaluation", () => ({
	preEvaluateSubmission: preEvalService.preEvaluateSubmission,
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ASSIGNMENT = "soil_contamination";
const STUDENT_A = "2026SS_01"; // executed
const STUDENT_B = "2026SS_02"; // error (has stored cells, like a failed run)
const STUDENT_C = "2026SS_03"; // pending — never executed, skipped by the route

const ASSIGNMENTS_YAML = `assignments:
  - id: soil_contamination
    title: Soil Contamination by Factories
    enabled: true
    criteria_files: []
    dimensions:
      - code_quality_design
`;

const ENVELOPE = {
	markers: [{ cell_index: 0, marker: "different", reason: "Different but valid approach" }],
	gradeSuggestion: {
		dimensions: { code_quality_design: 4 },
		justification: "Solid work overall.",
	},
	feedbackDraft: "**Nice job** — keep it up.",
	notebookSummary: "The notebook computes a soil quality index.",
};

function makeExecutionResult(studentId: string, opts: { success?: boolean } = {}): ExecutionResult {
	const success = opts.success ?? true;
	return {
		success,
		notebookPath: `submissions/${ASSIGNMENT}/${studentId}.ipynb`,
		cells: [
			{
				index: 0,
				type: "code",
				source: "print('hi')",
				original_source: "print('hi')",
				output: "hi\n",
				error: success ? null : "NameError: name 'x' is not defined",
				traceback: null,
				execution_count: 1,
				marker: "pending",
			},
		],
		totalCells: 1,
		executedCells: 1,
		errorCells: success ? 0 : 1,
		durationSeconds: 0.5,
		preprocessing: {
			cellsModified: 0,
			totalEdits: 0,
			editTypes: {},
			llmPreprocessing: "skipped",
			llmAnalysis: false,
		},
		modifiedFiles: [],
		fixedCells: null,
		autofix: { attempts: 0, succeeded: 0 },
		...(success ? {} : { error: "NameError: name 'x' is not defined" }),
	};
}

let dataDir: string;

beforeEach(async () => {
	dataDir = await mkdtemp(path.join(os.tmpdir(), "scipro-preeval-route-"));
	process.env.DATA_DIR = dataDir;

	await writeFile(path.join(dataDir, "assignments.yaml"), ASSIGNMENTS_YAML);
	await mkdir(path.join(dataDir, "submissions", ASSIGNMENT), { recursive: true });

	// A + B are the batch targets (executed / error); C stays pending.
	await upsertSubmission(ASSIGNMENT, STUDENT_A, {
		status: "executed",
		semester: "2026SS",
		fileName: `${STUDENT_A}.ipynb`,
		notebookPath: `submissions/${ASSIGNMENT}/${STUDENT_A}.ipynb`,
	});
	await upsertSubmission(ASSIGNMENT, STUDENT_B, {
		status: "error",
		semester: "2026SS",
		fileName: `${STUDENT_B}.ipynb`,
		notebookPath: `submissions/${ASSIGNMENT}/${STUDENT_B}.ipynb`,
		error: "NameError: name 'x' is not defined",
	});
	await upsertSubmission(ASSIGNMENT, STUDENT_C, {
		status: "pending",
		semester: "2026SS",
		fileName: `${STUDENT_C}.ipynb`,
		notebookPath: `submissions/${ASSIGNMENT}/${STUDENT_C}.ipynb`,
	});

	// Stored execution results the pre-evaluation service would read.
	await writeResults(ASSIGNMENT, {
		[STUDENT_A]: makeExecutionResult(STUDENT_A),
		[STUDENT_B]: makeExecutionResult(STUDENT_B, { success: false }),
	});

	preEvalService.preEvaluateSubmission.mockReset();
	preEvalService.preEvaluateSubmission.mockResolvedValue(ENVELOPE);
	resetPreEvalRun();
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

function postEvent(url = `/api/submissions/pre-evaluate?assignment=${ASSIGNMENT}`): RequestEvent {
	const absolute = url.startsWith("http") ? url : `http://localhost${url}`;
	return makeEvent(url, {
		request: new Request(absolute, { method: "POST" }),
	});
}

// ---------------------------------------------------------------------------
// POST /api/submissions/pre-evaluate
// ---------------------------------------------------------------------------

describe("POST /api/submissions/pre-evaluate", () => {
	it("pre-evaluates every executed/error row, persists preEval, and summarizes", async () => {
		const resp = await preEvaluatePOST(postEvent());
		const body = await readJson(resp);

		expect(body.assignmentId).toBe(ASSIGNMENT);
		expect(body.submitted).toBe(2);
		expect(body.succeeded).toBe(2);
		expect(body.failed).toBe(0);
		expect(body.results).toEqual([
			{ studentId: STUDENT_A, ok: true, error: null },
			{ studentId: STUDENT_B, ok: true, error: null },
		]);

		// One service call per target — the pending row is skipped.
		expect(preEvalService.preEvaluateSubmission).toHaveBeenCalledTimes(2);
		expect(preEvalService.preEvaluateSubmission).toHaveBeenCalledWith({
			submissionId: STUDENT_A,
			assignmentId: ASSIGNMENT,
		});

		// The envelope is persisted per submission with an evaluatedAt stamp.
		const results = await readResults(ASSIGNMENT);
		for (const student of [STUDENT_A, STUDENT_B]) {
			expect(results[student]!.preEval).toBeDefined();
			expect(results[student]!.preEval!.markers).toEqual(ENVELOPE.markers);
			expect(results[student]!.preEval!.gradeSuggestion).toEqual(ENVELOPE.gradeSuggestion);
			expect(results[student]!.preEval!.feedbackDraft).toBe(ENVELOPE.feedbackDraft);
			expect(results[student]!.preEval!.notebookSummary).toBe(ENVELOPE.notebookSummary);
			expect(results[student]!.preEval!.evaluatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		}
		// The pending row was never touched.
		expect(results[STUDENT_C]).toBeUndefined();
	});

	it("marks successful rows pre-evaluated (lifecycle step) and clears the run", async () => {
		await preEvaluatePOST(postEvent());

		const metadata = (await import("$lib/server/metadata")).listSubmissions;
		const records = await metadata(ASSIGNMENT);
		const byId = Object.fromEntries(records.map((r) => [r.id, r]));
		expect(byId[STUDENT_A]!.status).toBe("pre-evaluated");
		expect(byId[STUDENT_B]!.status).toBe("pre-evaluated");
		expect(byId[STUDENT_C]!.status).toBe("pending");

		// Run ended: not running, final tallies retained (status endpoint).
		const final = getPreEvalRun();
		expect(final.running).toBe(false);
		expect(final.total).toBe(2);
		expect(final.done).toBe(2);
		expect(final.currentStudentId).toBeNull();
	});

	it("does not abort the loop when one row fails — reports it and persists the rest", async () => {
		preEvalService.preEvaluateSubmission.mockImplementation(
			async (input: { submissionId: string }) => {
				if (input.submissionId === STUDENT_B) {
					throw new Error("upstream timeout");
				}
				return ENVELOPE;
			},
		);

		const resp = await preEvaluatePOST(postEvent());
		const body = await readJson(resp);

		expect(body.submitted).toBe(2);
		expect(body.succeeded).toBe(1);
		expect(body.failed).toBe(1);

		const failedRow = (body.results as Array<Record<string, unknown>>).find(
			(row) => row.studentId === STUDENT_B,
		);
		expect(failedRow?.ok).toBe(false);
		expect(failedRow?.error).toContain("upstream timeout");

		// The loop survived: the other row was still persisted and marked.
		const results = await readResults(ASSIGNMENT);
		expect(results[STUDENT_A]!.preEval).toBeDefined();
		expect(results[STUDENT_B]!.preEval).toBeUndefined();
		const records = await (await import("$lib/server/metadata")).listSubmissions(ASSIGNMENT);
		expect(records.find((r) => r.id === STUDENT_A)!.status).toBe("pre-evaluated");
		// The failed row keeps its prior status so the teacher can retry.
		expect(records.find((r) => r.id === STUDENT_B)!.status).toBe("error");

		// Both rows settled in the run tally.
		expect(getPreEvalRun().done).toBe(2);
	});

	it("refuses with 409 while a pre-evaluation run is already in flight", async () => {
		beginPreEvalRun(ASSIGNMENT, 2);

		await expect(preEvaluatePOST(postEvent())).rejects.toMatchObject({ status: 409 });
		expect(preEvalService.preEvaluateSubmission).not.toHaveBeenCalled();

		// Once the run ends, the route accepts again.
		endPreEvalRun();
		const resp = await preEvaluatePOST(postEvent());
		expect((await readJson(resp)).succeeded).toBe(2);
	});

	it("rejects unknown assignments with 404", async () => {
		await expect(
			preEvaluatePOST(postEvent("/api/submissions/pre-evaluate?assignment=nope")),
		).rejects.toMatchObject({ status: 404 });
	});

	it("returns an empty summary when nothing is runnable", async () => {
		// Move both stored-result rows out of the executed/error target set.
		await (
			await import("$lib/server/metadata")
		).upsertSubmission(ASSIGNMENT, STUDENT_A, {
			status: "graded",
		});
		await (
			await import("$lib/server/metadata")
		).upsertSubmission(ASSIGNMENT, STUDENT_B, {
			status: "graded",
		});
		const resp = await preEvaluatePOST(postEvent());
		const body = await readJson(resp);
		expect(body.submitted).toBe(0);
		expect(body.succeeded).toBe(0);
		expect(body.results).toEqual([]);
		expect(preEvalService.preEvaluateSubmission).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// GET /api/submissions/pre-evaluate/status
// ---------------------------------------------------------------------------

describe("GET /api/submissions/pre-evaluate/status", () => {
	it("reports idle when no run is in flight", async () => {
		const body = await readJson(
			await preEvaluateStatusGET(makeEvent("/api/submissions/pre-evaluate/status")),
		);
		expect(body.running).toBe(false);
		expect(body.done).toBe(0);
		expect(body.total).toBe(0);
	});

	it("returns live progress while running and retains final tallies after", async () => {
		beginPreEvalRun(ASSIGNMENT, 4);
		updatePreEvalRun({ currentStudentId: STUDENT_B, currentStartedAt: 123456 });
		updatePreEvalRun({ done: 1 });

		const running = await readJson(
			await preEvaluateStatusGET(makeEvent("/api/submissions/pre-evaluate/status")),
		);
		expect(running.running).toBe(true);
		expect(running.assignmentId).toBe(ASSIGNMENT);
		expect(running.total).toBe(4);
		expect(running.done).toBe(1);
		expect(running.currentStudentId).toBe(STUDENT_B);
		expect(running.currentStartedAt).toBe(123456);

		endPreEvalRun();
		const finished = await readJson(
			await preEvaluateStatusGET(makeEvent("/api/submissions/pre-evaluate/status")),
		);
		expect(finished.running).toBe(false);
		// Final tallies survive the run end (dashboard shows the summary).
		expect(finished.done).toBe(1);
		expect(finished.total).toBe(4);
		expect(finished.currentStudentId).toBeNull();
	});
});
