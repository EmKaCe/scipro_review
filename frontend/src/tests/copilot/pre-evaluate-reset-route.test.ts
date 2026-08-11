// @vitest-environment node
/**
 * @file L5 API-contract tests for POST /api/submissions/pre-evaluate/reset
 * (Wave 7, Task C): clears pre-evaluation results so the teacher can
 * re-run the batch without hacking metadata.
 *
 * Real temp DATA_DIR + real Request/Response objects; no external services
 * involved (the route is pure local I/O). Covers reset-all (rows carrying
 * pre-evaluation state: status "pre-evaluated" or a stored preEval
 * envelope), explicit submissionIds filtering, 404 unknown assignment,
 * 400 validation, the 409 run-in-flight guard, and the no-op empty case.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RequestEvent } from "@sveltejs/kit";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ExecutionResult } from "$lib/server/executor-client";
import { getSubmission, listSubmissions, upsertSubmission } from "$lib/server/metadata";
import { beginPreEvalRun, endPreEvalRun, resetPreEvalRun } from "$lib/server/pre-eval-progress";
import type { StoredPreEvaluation } from "$lib/server/results-store";
import { readResults, writeResults } from "$lib/server/results-store";

import { POST as resetPOST } from "../../routes/api/submissions/pre-evaluate/reset/+server";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ASSIGNMENT = "soil_contamination";
const STUDENT_A = "2026SS_01"; // pre-evaluated (has preEval envelope)
const STUDENT_B = "2026SS_02"; // graded (still carries a preEval envelope)
const STUDENT_C = "2026SS_03"; // pending — untouched by the reset
const UNKNOWN_ID = "2026SS_99"; // not in the batch

const ASSIGNMENTS_YAML = `assignments:
  - id: soil_contamination
    title: Soil Contamination by Factories
    enabled: true
    criteria_files: []
    dimensions:
      - code_quality_design
`;

const PRE_EVAL: StoredPreEvaluation = {
	markers: [{ cell_index: 0, marker: "different", reason: "Different but valid approach" }],
	gradeSuggestion: {
		dimensions: { code_quality_design: 4 },
		justification: "Solid work overall.",
	},
	feedbackDraft: "**Nice job** — keep it up.",
	notebookSummary: "The notebook computes a soil quality index.",
	evaluatedAt: "2026-08-10T12:00:00.000Z",
};

function makeExecutionResult(studentId: string): ExecutionResult {
	return {
		success: true,
		notebookPath: `submissions/${ASSIGNMENT}/${studentId}.ipynb`,
		cells: [
			{
				index: 0,
				type: "code",
				source: "print('hi')",
				original_source: "print('hi')",
				output: "hi\n",
				error: null,
				traceback: null,
				execution_count: 1,
				marker: "pending",
			},
		],
		totalCells: 1,
		executedCells: 1,
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
		fixedCells: null,
		autofix: { attempts: 0, succeeded: 0 },
	};
}

let dataDir: string;

beforeEach(async () => {
	dataDir = await mkdtemp(path.join(os.tmpdir(), "scipro-preeval-reset-"));
	process.env.DATA_DIR = dataDir;

	await writeFile(path.join(dataDir, "assignments.yaml"), ASSIGNMENTS_YAML);
	await mkdir(path.join(dataDir, "submissions", ASSIGNMENT), { recursive: true });

	// A is pre-evaluated; B is graded but still carries a preEval envelope
	// (grading data must survive the reset); C stays pending.
	await upsertSubmission(ASSIGNMENT, STUDENT_A, {
		status: "pre-evaluated",
		semester: "2026SS",
		fileName: `${STUDENT_A}.ipynb`,
		notebookPath: `submissions/${ASSIGNMENT}/${STUDENT_A}.ipynb`,
	});
	await upsertSubmission(ASSIGNMENT, STUDENT_B, {
		status: "graded",
		semester: "2026SS",
		fileName: `${STUDENT_B}.ipynb`,
		notebookPath: `submissions/${ASSIGNMENT}/${STUDENT_B}.ipynb`,
		teacherGrade: 2.5,
		grading: {
			rubric: { clarity: "good" },
			dimensions: { code_quality_design: 2 },
			updatedAt: "2026-08-10T11:00:00.000Z",
		},
	});
	await upsertSubmission(ASSIGNMENT, STUDENT_C, {
		status: "pending",
		semester: "2026SS",
		fileName: `${STUDENT_C}.ipynb`,
		notebookPath: `submissions/${ASSIGNMENT}/${STUDENT_C}.ipynb`,
	});

	// Stored execution results: A + B carry preEval envelopes, C has none.
	await writeResults(ASSIGNMENT, {
		[STUDENT_A]: { ...makeExecutionResult(STUDENT_A), preEval: { ...PRE_EVAL } },
		[STUDENT_B]: { ...makeExecutionResult(STUDENT_B), preEval: { ...PRE_EVAL } },
		[STUDENT_C]: makeExecutionResult(STUDENT_C),
	});

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

function postEvent(
	payload: { assignmentId?: unknown; submissionIds?: unknown },
	url = "/api/submissions/pre-evaluate/reset",
): RequestEvent {
	const absolute = url.startsWith("http") ? url : `http://localhost${url}`;
	return makeEvent(url, {
		request: new Request(absolute, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(payload),
		}),
	});
}

// ---------------------------------------------------------------------------
// POST /api/submissions/pre-evaluate/reset
// ---------------------------------------------------------------------------

describe("POST /api/submissions/pre-evaluate/reset", () => {
	it("resets every row carrying pre-evaluation state and returns the count", async () => {
		const resp = await resetPOST(postEvent({ assignmentId: ASSIGNMENT }));
		const body = await readJson(resp);

		expect(body.assignmentId).toBe(ASSIGNMENT);
		// A (pre-evaluated) + B (graded with preEval) are reset; C is not.
		expect(body.reset).toBe(2);

		// Statuses: A and B are back in the pre-evaluate route's target set.
		const records = await listSubmissions(ASSIGNMENT);
		const byId = Object.fromEntries(records.map((r) => [r.id, r]));
		expect(byId[STUDENT_A]!.status).toBe("executed");
		expect(byId[STUDENT_B]!.status).toBe("executed");
		expect(byId[STUDENT_C]!.status).toBe("pending");

		// preEval envelopes are gone from results.json; the rest of the
		// stored execution result survives untouched.
		const results = await readResults(ASSIGNMENT);
		expect(results[STUDENT_A]!.preEval).toBeUndefined();
		expect(results[STUDENT_B]!.preEval).toBeUndefined();
		expect(results[STUDENT_A]!.cells).toHaveLength(1);
		expect(results[STUDENT_C]!.preEval).toBeUndefined(); // never had one

		// Grading data survives the reset (only status + envelope change).
		const graded = await getSubmission(ASSIGNMENT, STUDENT_B);
		expect(graded!.teacherGrade).toBe(2.5);
		expect(graded!.grading?.rubric).toEqual({ clarity: "good" });
	});

	it("resets only the listed submission ids when submissionIds is provided", async () => {
		const resp = await resetPOST(
			postEvent({ assignmentId: ASSIGNMENT, submissionIds: [STUDENT_B] }),
		);
		const body = await readJson(resp);
		expect(body.reset).toBe(1);

		const records = await listSubmissions(ASSIGNMENT);
		const byId = Object.fromEntries(records.map((r) => [r.id, r]));
		expect(byId[STUDENT_B]!.status).toBe("executed");
		// A keeps its pre-evaluation (not in the list).
		expect(byId[STUDENT_A]!.status).toBe("pre-evaluated");

		const results = await readResults(ASSIGNMENT);
		expect(results[STUDENT_B]!.preEval).toBeUndefined();
		expect(results[STUDENT_A]!.preEval).toBeDefined();
	});

	it("skips unknown submission ids — the count reflects what was actually reset", async () => {
		const resp = await resetPOST(
			postEvent({ assignmentId: ASSIGNMENT, submissionIds: [STUDENT_A, UNKNOWN_ID] }),
		);
		expect((await readJson(resp)).reset).toBe(1);

		const records = await listSubmissions(ASSIGNMENT);
		expect(records.find((r) => r.id === STUDENT_A)!.status).toBe("executed");
	});

	it("is a no-op (reset: 0) when nothing carries pre-evaluation state", async () => {
		await resetPOST(postEvent({ assignmentId: ASSIGNMENT }));
		// First reset clears the batch; a second run has nothing left.
		const resp = await resetPOST(postEvent({ assignmentId: ASSIGNMENT }));
		const body = await readJson(resp);
		expect(body.reset).toBe(0);

		const records = await listSubmissions(ASSIGNMENT);
		for (const record of records) {
			expect(record.status).not.toBe("pre-evaluated");
		}
	});

	it("rejects unknown assignments with 404", async () => {
		await expect(resetPOST(postEvent({ assignmentId: "nope" }))).rejects.toMatchObject({
			status: 404,
		});
	});

	it("rejects a missing assignmentId with 400", async () => {
		await expect(resetPOST(postEvent({}))).rejects.toMatchObject({ status: 400 });
		await expect(resetPOST(postEvent({ assignmentId: "" }))).rejects.toMatchObject({
			status: 400,
		});
	});

	it("rejects a malformed submissionIds with 400", async () => {
		await expect(
			resetPOST(postEvent({ assignmentId: ASSIGNMENT, submissionIds: "2026SS_01" })),
		).rejects.toMatchObject({ status: 400 });
		await expect(
			resetPOST(postEvent({ assignmentId: ASSIGNMENT, submissionIds: [42] })),
		).rejects.toMatchObject({ status: 400 });
	});

	it("refuses with 409 while a pre-evaluation run is in flight", async () => {
		beginPreEvalRun(ASSIGNMENT, 2);

		await expect(resetPOST(postEvent({ assignmentId: ASSIGNMENT }))).rejects.toMatchObject({
			status: 409,
		});

		// Once the run ends, the reset is accepted again.
		endPreEvalRun();
		const resp = await resetPOST(postEvent({ assignmentId: ASSIGNMENT }));
		expect((await readJson(resp)).reset).toBe(2);
	});

	it("rejects an invalid JSON body with 400", async () => {
		const absolute = "http://localhost/api/submissions/pre-evaluate/reset";
		const event = makeEvent(absolute, {
			request: new Request(absolute, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "not json",
			}),
		});
		await expect(resetPOST(event)).rejects.toMatchObject({ status: 400 });
	});
});
