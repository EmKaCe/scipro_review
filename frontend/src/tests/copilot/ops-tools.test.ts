/**
 * @file Unit tests for the copilot OPS write tools (ops-tools.ts).
 *
 * Each test registers the five tools into a fresh createRegistry() (never
 * the agent singleton) and points DATA_DIR at a temp dir containing the
 * fixtures: assignments.yaml, submission metadata + notebooks, and a
 * plagiarism cache where needed. The executor client is mocked so no test
 * ever touches the real executor. process-progress state is reset per test.
 *
 * Covers: registration + permission declarations (all five approval,
 * process-all in ALWAYS_ASK_COST, archive-submission destructive), the
 * single-submission process path, the batch loop (all targets, one failing
 * row does not abort, refuses while a batch is running), the plagiarism
 * check + review-status persistence, and archiving.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createRegistry, type ToolContext } from "$lib/server/copilot/registry";
import { registerOpsTools } from "$lib/server/copilot/tools/ops-tools";
import { ALWAYS_ASK_COST, HARD_DENY } from "$lib/server/copilot/permission";
import type { ExecutionResult } from "$lib/server/executor-client";
import { getSubmission, upsertSubmission } from "$lib/server/metadata";
import {
	readPlagiarismResult,
	writePlagiarismResult,
	type PlagiarismResult,
} from "$lib/server/plagiarism/cache";
import { beginProcessRun, getProcessRun, resetProcessRun } from "$lib/server/process-progress";
import { readResults } from "$lib/server/results-store";
import type { SubmissionStatus } from "$lib/types/submissions";

// ---------------------------------------------------------------------------
// Executor-client mock (the only networked dependency of the process tools)
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
	executeNotebook: vi.fn(),
	getExecutorClient: vi.fn(),
}));

vi.mock("$lib/server/executor-client", () => ({
	getExecutorClient: mocks.getExecutorClient,
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ASSIGNMENT = "soil_contamination";
const STUDENT_A = "2026SS_01";
const STUDENT_B = "2026SS_02";
const STUDENT_C = "2026SS_03";

const ASSIGNMENTS_YAML = `assignments:
  - id: soil_contamination
    title: Soil Contamination by Factories
    enabled: true
    criteria_files: []
    dimensions:
      - code_quality_design
`;

/** A valid ExecutionResult the mock executor resolves with. */
function makeExecutionResult(notebookPath: string): ExecutionResult {
	return {
		success: true,
		notebookPath,
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

const notebookPathOf = (studentId: string) =>
	path.join("submissions", ASSIGNMENT, `${studentId}.ipynb`);

/** Seed a submission record (status pending by default) + its notebook file. */
async function seedSubmission(
	studentId: string,
	opts: { status?: SubmissionStatus; cells?: string[] } = {},
): Promise<void> {
	const cells = opts.cells ?? ["print('hi')"];
	await upsertSubmission(ASSIGNMENT, studentId, {
		status: opts.status ?? "pending",
		semester: "2026SS",
		fileName: `${studentId}.ipynb`,
		notebookPath: notebookPathOf(studentId),
	});
	await mkdir(path.join(dataDir, "submissions", ASSIGNMENT), { recursive: true });
	await writeFile(
		path.join(dataDir, notebookPathOf(studentId)),
		JSON.stringify({
			cells: cells.map((source) => ({
				cell_type: "code",
				metadata: {},
				source: source.split("\n"),
			})),
			metadata: {},
			nbformat: 4,
			nbformat_minor: 5,
		}),
		"utf-8",
	);
}

/** Write a plagiarism cache fixture with one unreviewed pair (A ↔ B). */
async function seedPlagiarismFixture(): Promise<void> {
	const result: PlagiarismResult = {
		status: "done",
		assignmentId: ASSIGNMENT,
		generatedAt: "2026-08-08T12:00:00.000Z",
		pairs: [
			{
				studentA: STUDENT_A,
				studentB: STUDENT_B,
				cellOverlap: 0.7,
				notebookOverlap: 0.55,
				matchedCells: [{ cellIndexA: 0, cellIndexB: 1, similarity: 0.9 }],
				flags: ["shared_imports"],
				details: {
					cellCountDiff: 0,
					sharedVariableNames: [],
					sharedComments: [],
					sharedImports: ["pandas"],
				},
			},
		],
		totalPairs: 1,
		comparedSubmissions: [STUDENT_A, STUDENT_B],
		semanticChecked: false,
	};
	await writePlagiarismResult(ASSIGNMENT, result);
}

let dataDir: string;
let registry: ReturnType<typeof createRegistry>;

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
	return { signal: new AbortController().signal, ...overrides };
}

beforeEach(async () => {
	dataDir = await mkdtemp(path.join(os.tmpdir(), "scipro-ops-tools-"));
	process.env.DATA_DIR = dataDir;
	await writeFile(path.join(dataDir, "assignments.yaml"), ASSIGNMENTS_YAML, "utf-8");

	registry = createRegistry();
	registerOpsTools(registry);
	resetProcessRun();

	mocks.executeNotebook.mockReset();
	mocks.getExecutorClient.mockReset();
	mocks.getExecutorClient.mockReturnValue({ executeNotebook: mocks.executeNotebook });
});

afterEach(async () => {
	delete process.env.DATA_DIR;
	await rm(dataDir, { recursive: true, force: true });
	resetProcessRun();
	vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Registration + permissions
// ---------------------------------------------------------------------------

describe("registerOpsTools", () => {
	it("registers the five OPS tools with kebab-case names", () => {
		const names = registry
			.list()
			.map((tool) => tool.name)
			.sort();
		expect(names).toEqual([
			"archive-submission",
			"process-all",
			"process-submission",
			"run-plagiarism-check",
			"update-plagiarism-review",
		]);
	});

	it("declares permission approval on all five, process-all in ALWAYS_ASK_COST, archive-submission destructive", () => {
		for (const tool of registry.list()) {
			expect(tool.permission).toBe("approval");
		}
		expect(ALWAYS_ASK_COST).toContain("process-all");
		expect(HARD_DENY).toContain("archive-submission");
		expect(registry.get("archive-submission").destructive).toBe(true);
		// Only the destructive tool carries the flag.
		for (const tool of registry.list()) {
			if (tool.name === "archive-submission") continue;
			expect(tool.destructive).toBeUndefined();
		}
	});
});

// ---------------------------------------------------------------------------
// process-submission
// ---------------------------------------------------------------------------

describe("process-submission", () => {
	it("executes one submission through the same path as the single-process route", async () => {
		await seedSubmission(STUDENT_A, { status: "pending" });
		mocks.executeNotebook.mockResolvedValue(makeExecutionResult(notebookPathOf(STUDENT_A)));

		const result = (await registry.run(
			"process-submission",
			{ submissionId: STUDENT_A },
			makeContext({ assignmentId: ASSIGNMENT }),
		)) as Record<string, unknown>;

		expect(result).toMatchObject({
			submissionId: STUDENT_A,
			assignmentId: ASSIGNMENT,
			success: true,
			status: "executed",
			totalCells: 1,
			executedCells: 1,
			errorCells: 0,
			durationSeconds: 0.5,
			autofix: { attempts: 0, succeeded: 0 },
		});
		// Same call the route makes: notebookPath + assignment title context.
		expect(mocks.executeNotebook).toHaveBeenCalledWith({
			notebookPath: notebookPathOf(STUDENT_A),
			assignmentContext: "Soil Contamination by Factories",
		});

		// Record transitioned pending -> executing -> executed; result stored.
		const record = await getSubmission(ASSIGNMENT, STUDENT_A);
		expect(record?.status).toBe("executed");
		expect(record?.error).toBeNull();
		const stored = (await readResults(ASSIGNMENT))[STUDENT_A];
		expect(stored?.success).toBe(true);
		expect(stored?.notebookPath).toBe(notebookPathOf(STUDENT_A));
	});

	it("falls back to ctx.submissionId and marks the record error + throws when execution fails", async () => {
		await seedSubmission(STUDENT_A);
		mocks.executeNotebook.mockRejectedValue(new Error("executor down"));

		await expect(
			registry.run(
				"process-submission",
				{},
				makeContext({ submissionId: STUDENT_A, assignmentId: ASSIGNMENT }),
			),
		).rejects.toThrow(/execution failed for "2026SS_01"/);

		const record = await getSubmission(ASSIGNMENT, STUDENT_A);
		expect(record?.status).toBe("error");
		expect(record?.error).toContain("executor down");
	});

	it("throws when no submissionId is available (args or context)", async () => {
		await expect(registry.run("process-submission", {}, makeContext())).rejects.toThrow(
			/process-submission requires a submissionId/,
		);
		expect(mocks.executeNotebook).not.toHaveBeenCalled();
	});

	it("refuses to start while a batch process is running", async () => {
		await seedSubmission(STUDENT_A);
		beginProcessRun(ASSIGNMENT, 2);

		await expect(
			registry.run("process-submission", { submissionId: STUDENT_A }, makeContext()),
		).rejects.toThrow(/batch process is already running/);
		expect(mocks.executeNotebook).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// process-all
// ---------------------------------------------------------------------------

describe("process-all", () => {
	it("loops every pending + error target and a failing row does not abort the loop", async () => {
		// Two pending, one error target — all runnable.
		await seedSubmission(STUDENT_A, { status: "pending" });
		await seedSubmission(STUDENT_B, { status: "pending" });
		await seedSubmission(STUDENT_C, { status: "error" });

		mocks.executeNotebook.mockImplementation(async (request: { notebookPath: string }) => {
			if (request.notebookPath.includes(STUDENT_B)) {
				throw new Error("executor boom");
			}
			return makeExecutionResult(request.notebookPath);
		});

		const summary = (await registry.run(
			"process-all",
			{},
			makeContext({ assignmentId: ASSIGNMENT }),
		)) as {
			assignmentId: string;
			submitted: number;
			succeeded: number;
			failed: number;
			totalDurationSeconds: number;
			autofixAttempts: number;
			autofixSucceeded: number;
			results: Array<{ studentId: string; success: boolean; error: string | null }>;
		};

		expect(summary.assignmentId).toBe(ASSIGNMENT);
		expect(summary.submitted).toBe(3);
		expect(summary.succeeded).toBe(2);
		expect(summary.failed).toBe(1);
		// The loop did not abort: every target reached the executor exactly once.
		expect(mocks.executeNotebook).toHaveBeenCalledTimes(3);
		// Batch rows get the per-notebook budget option like the batch route.
		expect(mocks.executeNotebook).toHaveBeenCalledWith(
			{ notebookPath: notebookPathOf(STUDENT_A) },
			undefined,
			{ requestTimeoutMs: expect.any(Number) },
		);

		const failedRow = summary.results.find((row) => row.studentId === STUDENT_B);
		expect(failedRow).toMatchObject({ success: false, error: "executor boom" });

		// Per-row statuses persisted: A + C executed, B error.
		expect((await getSubmission(ASSIGNMENT, STUDENT_A))?.status).toBe("executed");
		expect((await getSubmission(ASSIGNMENT, STUDENT_B))?.status).toBe("error");
		expect((await getSubmission(ASSIGNMENT, STUDENT_C))?.status).toBe("executed");
		expect((await getSubmission(ASSIGNMENT, STUDENT_B))?.error).toBe("executor boom");

		// Results stored for the successful rows only.
		const results = await readResults(ASSIGNMENT);
		expect(results[STUDENT_A]?.success).toBe(true);
		expect(results[STUDENT_C]?.success).toBe(true);
		expect(results[STUDENT_B]).toBeUndefined();

		// Progress run finished with final tallies.
		const progress = getProcessRun();
		expect(progress.running).toBe(false);
		expect(progress.done).toBe(3);
		expect(progress.total).toBe(3);
	});

	it("returns an empty summary without touching the executor when nothing is runnable", async () => {
		// A graded submission is not a runnable target.
		await seedSubmission(STUDENT_A, { status: "graded" });

		const summary = (await registry.run(
			"process-all",
			{},
			makeContext({ assignmentId: ASSIGNMENT }),
		)) as { submitted: number; succeeded: number; failed: number; results: unknown[] };

		expect(summary).toMatchObject({ submitted: 0, succeeded: 0, failed: 0, results: [] });
		expect(mocks.executeNotebook).not.toHaveBeenCalled();
	});

	it("refuses to start while a batch process is running", async () => {
		await seedSubmission(STUDENT_A);
		beginProcessRun(ASSIGNMENT, 2);

		await expect(
			registry.run("process-all", {}, makeContext({ assignmentId: ASSIGNMENT })),
		).rejects.toThrow(/batch process is already running/);
		expect(mocks.executeNotebook).not.toHaveBeenCalled();
	});

	it("reports executor-level failure (success:false response) as a row failure too", async () => {
		await seedSubmission(STUDENT_A);
		const failed: ExecutionResult = {
			...makeExecutionResult(notebookPathOf(STUDENT_A)),
			success: false,
			cells: [
				{
					...makeExecutionResult(notebookPathOf(STUDENT_A)).cells[0]!,
					error: "cell blew up",
				},
			],
		};
		mocks.executeNotebook.mockResolvedValue(failed);

		const summary = (await registry.run(
			"process-all",
			{},
			makeContext({ assignmentId: ASSIGNMENT }),
		)) as { succeeded: number; failed: number; results: Array<{ error: string | null }> };

		expect(summary.succeeded).toBe(0);
		expect(summary.failed).toBe(1);
		expect(summary.results[0]?.error).toBe("cell blew up");
		expect((await getSubmission(ASSIGNMENT, STUDENT_A))?.status).toBe("error");
	});
});

// ---------------------------------------------------------------------------
// run-plagiarism-check
// ---------------------------------------------------------------------------

describe("run-plagiarism-check", () => {
	it("runs the structural comparison, caches the result, and returns the service shape", async () => {
		const sharedCell = "import pandas as pd\nprint(df.head())";
		await seedSubmission(STUDENT_A, { cells: [sharedCell] });
		await seedSubmission(STUDENT_B, { cells: [sharedCell] });

		const result = (await registry.run(
			"run-plagiarism-check",
			{ assignmentId: ASSIGNMENT },
			makeContext(),
		)) as Record<string, unknown>;

		expect(result["status"]).toBe("done");
		expect(result["assignmentId"]).toBe(ASSIGNMENT);
		expect(result["flaggedCount"]).toBe(1);
		expect(result["totalPairs"]).toBe(1);
		expect(result["comparedSubmissions"]).toEqual([STUDENT_A, STUDENT_B]);
		expect(result["semanticChecked"]).toBe(false);
		const pairs = result["pairs"] as Array<Record<string, unknown>>;
		expect(pairs).toHaveLength(1);
		expect(pairs[0]).toMatchObject({ studentA: STUDENT_A, studentB: STUDENT_B });
		expect(pairs[0]!["cellOverlap"]).toBeGreaterThan(0);

		// The result was persisted to the plagiarism cache.
		const cached = await readPlagiarismResult(ASSIGNMENT);
		expect(cached?.status).toBe("done");
		expect(cached?.pairs).toHaveLength(1);
	});

	it("throws when the assignment does not exist", async () => {
		await expect(
			registry.run("run-plagiarism-check", { assignmentId: "nope" }, makeContext()),
		).rejects.toThrow(/assignment "nope" not found/);
	});
});

// ---------------------------------------------------------------------------
// update-plagiarism-review
// ---------------------------------------------------------------------------

describe("update-plagiarism-review", () => {
	it("persists the pair review status (either order accepted) and returns the pair summary", async () => {
		await seedPlagiarismFixture();

		const result = (await registry.run(
			"update-plagiarism-review",
			// Reversed order — the cache matches canonically.
			{ studentA: STUDENT_B, studentB: STUDENT_A, reviewStatus: "accepted" },
			makeContext({ assignmentId: ASSIGNMENT }),
		)) as Record<string, unknown>;

		expect(result).toMatchObject({
			assignmentId: ASSIGNMENT,
			studentA: STUDENT_A,
			studentB: STUDENT_B,
			reviewStatus: "accepted",
		});
		const pair = result["pair"] as Record<string, unknown>;
		expect(pair).toMatchObject({
			studentA: STUDENT_A,
			studentB: STUDENT_B,
			cellOverlap: 0.7,
			reviewStatus: "accepted",
		});

		// Persisted in the cache.
		const cached = await readPlagiarismResult(ASSIGNMENT);
		expect(cached?.pairs[0]?.reviewStatus).toBe("accepted");
	});

	it("throws when the pair does not exist in the cached results", async () => {
		await seedPlagiarismFixture();

		await expect(
			registry.run(
				"update-plagiarism-review",
				{ studentA: "2026SS_99", studentB: STUDENT_B, reviewStatus: "dismissed" },
				makeContext({ assignmentId: ASSIGNMENT }),
			),
		).rejects.toThrow(/pair "2026SS_99" ↔ "2026SS_02" not found/);
	});

	it("rejects invalid reviewStatus values via the schema", async () => {
		await seedPlagiarismFixture();

		await expect(
			registry.run(
				"update-plagiarism-review",
				{ studentA: STUDENT_A, studentB: STUDENT_B, reviewStatus: "maybe" },
				makeContext({ assignmentId: ASSIGNMENT }),
			),
		).rejects.toThrow(/invalid arguments/);
	});
});

// ---------------------------------------------------------------------------
// archive-submission
// ---------------------------------------------------------------------------

describe("archive-submission", () => {
	it("archives the submission and marks its plagiarism pairs ignored", async () => {
		await seedSubmission(STUDENT_A, { status: "executed" });
		await seedPlagiarismFixture();

		const result = (await registry.run(
			"archive-submission",
			{ submissionId: STUDENT_A },
			makeContext({ assignmentId: ASSIGNMENT }),
		)) as Record<string, unknown>;

		expect(result).toMatchObject({
			assignmentId: ASSIGNMENT,
			submissionId: STUDENT_A,
			archived: true,
			status: "archived",
			archivedFrom: "executed",
		});

		const record = await getSubmission(ASSIGNMENT, STUDENT_A);
		expect(record?.status).toBe("archived");
		expect(record?.archivedFrom).toBe("executed");

		// Best-effort pair marking (same as the archive route).
		const cached = await readPlagiarismResult(ASSIGNMENT);
		expect(cached?.pairs[0]?.reviewStatus).toBe("ignored");
	});

	it("throws when the submission is already archived", async () => {
		await seedSubmission(STUDENT_A, { status: "archived" });

		await expect(
			registry.run(
				"archive-submission",
				{ submissionId: STUDENT_A },
				makeContext({ assignmentId: ASSIGNMENT }),
			),
		).rejects.toThrow(/already archived/);
	});

	it("throws when no submissionId is available", async () => {
		await expect(registry.run("archive-submission", {}, makeContext())).rejects.toThrow(
			/archive-submission requires a submissionId/,
		);
	});
});
