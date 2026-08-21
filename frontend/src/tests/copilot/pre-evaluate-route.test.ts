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
 * the 409 already-running guard, the status endpoint retaining final
 * tallies after completion, and Wave 8 cohort calibration: it runs after
 * the batch when >= MIN_OUTLIER_CONSENSUS rows succeed, is skipped (not
 * crashed) for smaller runs, and its failure never fails the batch.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestEvent } from "@sveltejs/kit";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ExecutionResult } from "$lib/server/executor-client";
import { upsertSubmission } from "$lib/server/metadata";
import { getPreEvalLogs, resetPreEvalLogs } from "$lib/server/pre-eval-logs";
import {
	beginPreEvalRun,
	endPreEvalRun,
	getPreEvalRun,
	resetPreEvalRun,
	updatePreEvalRun,
} from "$lib/server/pre-eval-progress";
import { readResults, writeResults } from "$lib/server/results-store";

import { POST as preEvaluatePOST } from "../../routes/api/submissions/pre-evaluate/+server";
import { GET as preEvaluateLogsGET } from "../../routes/api/submissions/pre-evaluate/logs/+server";
import { GET as preEvaluateStatusGET } from "../../routes/api/submissions/pre-evaluate/status/+server";

// ---------------------------------------------------------------------------
// Pre-evaluation service mock — the route must never hit KI Connect.
// ---------------------------------------------------------------------------

const preEvalService = vi.hoisted(() => ({
	preEvaluateSubmission: vi.fn(),
	runCohortCalibration: vi.fn(),
}));

vi.mock("$lib/server/copilot/pre-evaluation", () => ({
	preEvaluateSubmission: preEvalService.preEvaluateSubmission,
	runCohortCalibration: preEvalService.runCohortCalibration,
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
	// Default: a clean calibration outcome (no adjustments). Individual
	// tests override this to exercise the adjustment-persist path.
	preEvalService.runCohortCalibration.mockReset();
	preEvalService.runCohortCalibration.mockResolvedValue({
		assignmentId: ASSIGNMENT,
		adjustments: [],
		calibratedCount: 0,
	});
	resetPreEvalRun();
	resetPreEvalLogs();
});

afterEach(async () => {
	delete process.env.DATA_DIR;
	await rm(dataDir, { recursive: true, force: true });
	resetPreEvalLogs();
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

		// One pipeline-log line per settled row, tagged "pre-eval" with the
		// envelope's grade scores, marker count, and rubric selection count.
		const log = getPreEvalLogs();
		expect(log.truncated).toBe(false);
		expect(log.entries).toHaveLength(2);
		expect(log.entries.map((e) => e.submissionId).sort()).toEqual([STUDENT_A, STUDENT_B]);
		for (const entry of log.entries) {
			expect(entry.source).toBe("pre-eval");
			expect(entry.ok).toBe(true);
			expect(entry.level).toBe("info");
			expect(entry.grades).toEqual(ENVELOPE.gradeSuggestion.dimensions);
			expect(entry.markerCount).toBe(ENVELOPE.markers!.length);
			expect(entry.selectionCount).toBe(0);
		}
		// Run tallies: both rows succeeded.
		const progress = getPreEvalRun();
		expect(progress.succeeded).toBe(2);
		expect(progress.failed).toBe(0);
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
		// Tallies split: one success, one failure — and the failed row gets
		// an error-tagged log line with no grade data.
		expect(getPreEvalRun().succeeded).toBe(1);
		expect(getPreEvalRun().failed).toBe(1);
		const log = getPreEvalLogs();
		expect(log.entries).toHaveLength(2);
		const failedEntry = log.entries.find((e) => e.submissionId === STUDENT_B)!;
		expect(failedEntry.ok).toBe(false);
		expect(failedEntry.level).toBe("error");
		expect(failedEntry.grades).toEqual({});
		expect(failedEntry.markerCount).toBe(0);
		expect(failedEntry.selectionCount).toBe(0);
		expect(failedEntry.message).toContain("upstream timeout");
	});

	it("runs cohort calibration after the batch when >= MIN_OUTLIER_CONSENSUS rows succeed", async () => {
		// Four runnable rows (A, B, C, D) all succeed — the threshold is 4.
		await upsertSubmission(ASSIGNMENT, STUDENT_C, {
			status: "executed",
			semester: "2026SS",
			fileName: `${STUDENT_C}.ipynb`,
			notebookPath: `submissions/${ASSIGNMENT}/${STUDENT_C}.ipynb`,
		});
		await upsertSubmission(ASSIGNMENT, "2026SS_04", {
			status: "executed",
			semester: "2026SS",
			fileName: "2026SS_04.ipynb",
			notebookPath: `submissions/${ASSIGNMENT}/2026SS_04.ipynb`,
		});
		const stored = await readResults(ASSIGNMENT);
		stored[STUDENT_C] = makeExecutionResult(STUDENT_C);
		stored["2026SS_04"] = makeExecutionResult("2026SS_04");
		await writeResults(ASSIGNMENT, stored);

		const adjustment = {
			submissionId: STUDENT_A,
			dimension: "code_quality_design",
			oldScore: 4,
			newScore: 3.5,
			reason: "score 4 deviates from the homogeneous cluster value 3.5 — corrected to the cluster median 3.5",
		};
		preEvalService.runCohortCalibration.mockResolvedValue({
			assignmentId: ASSIGNMENT,
			adjustments: [adjustment],
			calibratedCount: 1,
		});

		const resp = await preEvaluatePOST(postEvent());
		const body = await readJson(resp);

		// The batch summary is unchanged — calibration runs after it settles.
		expect(body.succeeded).toBe(4);
		expect(body.calibration).toEqual({
			ok: true,
			skipped: false,
			error: null,
			adjustments: [adjustment],
			calibratedCount: 1,
		});

		// Calibration runs AFTER every row was pre-evaluated and persisted.
		expect(preEvalService.runCohortCalibration).toHaveBeenCalledTimes(1);
		expect(preEvalService.runCohortCalibration).toHaveBeenCalledWith(ASSIGNMENT);
		const callOrder = preEvalService.preEvaluateSubmission.mock.invocationCallOrder;
		const calibrationOrder = preEvalService.runCohortCalibration.mock.invocationCallOrder;
		expect(calibrationOrder[0]).toBeGreaterThan(Math.max(...callOrder));
	});

	it("skips cohort calibration for a batch under MIN_OUTLIER_CONSENSUS (2 rows)", async () => {
		const resp = await preEvaluatePOST(postEvent());
		const body = await readJson(resp);

		expect(body.succeeded).toBe(2);
		expect(body.calibration).toEqual({
			ok: false,
			skipped: true,
			error: null,
			adjustments: [],
			calibratedCount: 0,
		});
		// The calibration service was never reached (and never mocked into
		// a no-op) — no LLM calls, no cohort math on a 2-submission run.
		expect(preEvalService.runCohortCalibration).not.toHaveBeenCalled();
	});

	it("reports calibration failure as ok:false without failing the batch", async () => {
		// Calibration only runs on a >= MIN_OUTLIER_CONSENSUS cohort — seed
		// the same 4-row batch as the success test so the rejection fires.
		await upsertSubmission(ASSIGNMENT, STUDENT_C, {
			status: "executed",
			semester: "2026SS",
			fileName: `${STUDENT_C}.ipynb`,
			notebookPath: `submissions/${ASSIGNMENT}/${STUDENT_C}.ipynb`,
		});
		await upsertSubmission(ASSIGNMENT, "2026SS_04", {
			status: "executed",
			semester: "2026SS",
			fileName: "2026SS_04.ipynb",
			notebookPath: `submissions/${ASSIGNMENT}/2026SS_04.ipynb`,
		});
		const stored = await readResults(ASSIGNMENT);
		stored[STUDENT_C] = makeExecutionResult(STUDENT_C);
		stored["2026SS_04"] = makeExecutionResult("2026SS_04");
		await writeResults(ASSIGNMENT, stored);

		preEvalService.runCohortCalibration.mockRejectedValue(new Error("boom"));

		const resp = await preEvaluatePOST(postEvent());
		const body = await readJson(resp);

		// The batch itself still succeeded — calibration is advisory.
		expect(body.succeeded).toBe(4);
		expect(body.calibration).toEqual({
			ok: false,
			skipped: false,
			error: "boom",
			adjustments: [],
			calibratedCount: 0,
		});
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

	it("beginPreEvalRun is an atomic check-and-set — a second claim throws", () => {
		beginPreEvalRun(ASSIGNMENT, 2);
		// Synchronous check+set with no await between them: a request that
		// raced past the route's fast-path guard cannot double-start a run.
		expect(() => beginPreEvalRun(ASSIGNMENT, 2)).toThrow(/already in progress/);
		// The first claim is untouched.
		expect(getPreEvalRun().running).toBe(true);
		expect(getPreEvalRun().total).toBe(2);
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
		updatePreEvalRun({ done: 1, succeeded: 1, failed: 0 });

		const running = await readJson(
			await preEvaluateStatusGET(makeEvent("/api/submissions/pre-evaluate/status")),
		);
		expect(running.running).toBe(true);
		expect(running.assignmentId).toBe(ASSIGNMENT);
		expect(running.total).toBe(4);
		expect(running.done).toBe(1);
		expect(running.succeeded).toBe(1);
		expect(running.failed).toBe(0);
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
		expect(finished.succeeded).toBe(1);
		expect(finished.failed).toBe(0);
		expect(finished.currentStudentId).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// GET /api/submissions/pre-evaluate/logs
// ---------------------------------------------------------------------------

describe("GET /api/submissions/pre-evaluate/logs", () => {
	it("reports an empty buffer when no rows were processed", async () => {
		const body = await readJson(
			await preEvaluateLogsGET(makeEvent("/api/submissions/pre-evaluate/logs")),
		);
		expect(body.entries).toEqual([]);
		expect(body.truncated).toBe(false);
	});

	it("returns appended pre-eval entries oldest → newest with the limit clamp", async () => {
		// A run emits two rows; the endpoint surfaces both.
		await preEvaluatePOST(postEvent());

		const body = await readJson(
			await preEvaluateLogsGET(makeEvent("/api/submissions/pre-evaluate/logs?limit=1")),
		);
		expect(body.truncated).toBe(true);
		const single = (body.entries as Array<Record<string, unknown>>)[0]!;
		expect(single.source).toBe("pre-eval");
		// Append order is nondeterministic under concurrency — either row.
		expect([STUDENT_A, STUDENT_B]).toContain(single.submissionId);

		const all = await readJson(
			await preEvaluateLogsGET(makeEvent("/api/submissions/pre-evaluate/logs?limit=abc")),
		);
		// Unparsable limit falls back to the default (both entries).
		expect((all.entries as unknown[]).length).toBe(2);
		expect(all.truncated).toBe(false);
	});
});
