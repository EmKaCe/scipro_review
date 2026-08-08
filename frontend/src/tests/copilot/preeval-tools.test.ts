/**
 * @file Unit tests for the copilot pre-evaluation tools (preeval-tools.ts).
 *
 * Registers the two pre-evaluation tools into a fresh createRegistry() with a
 * stubbed KI Connect client (vi.mock of $lib/server/ki-connect) and a real
 * temp DATA_DIR fixture: assignments.yaml + materials key + metadata.json +
 * results.json. Covers permission declarations (pre-evaluate auto,
 * pre-evaluate-all approval + ALWAYS_ASK_COST), the persistence round trip
 * (preEval block in results.json), argument/context fallbacks, and the
 * pre-evaluate-all loop surviving per-row failures.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createRegistry, type ToolContext } from "$lib/server/copilot/registry";
import { registerPreevalTools } from "$lib/server/copilot/tools/preeval-tools";
import { ALWAYS_ASK_COST } from "$lib/server/copilot/permission";
import type { ExecutionResult } from "$lib/server/executor-client";
import { upsertSubmission } from "$lib/server/metadata";
import { readResults, writeResults } from "$lib/server/results-store";

// ---------------------------------------------------------------------------
// KI Connect mock
// ---------------------------------------------------------------------------

const kiConnectMock = vi.hoisted(() => ({
	chatCompletion: vi.fn(),
}));

vi.mock("$lib/server/ki-connect", () => ({
	getKiConnectClient: () => ({ chatCompletion: kiConnectMock.chatCompletion }),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ASSIGNMENT = "soil_contamination";
const STUDENT_A = "2026SS_01";
const STUDENT_B = "2026SS_02";
const STUDENT_C = "2026SS_03"; // deliberately has NO stored execution result

const ASSIGNMENTS_YAML = `assignments:
  - id: soil_contamination
    title: Soil Contamination by Factories
    enabled: true
    criteria_files: []
    dimensions:
      - code_quality_design
`;

const KEY_NOTEBOOK = JSON.stringify({
	cells: [{ cell_type: "code", source: ["print('key')\n"] }],
	metadata: {},
	nbformat: 4,
	nbformat_minor: 5,
});

const ENVELOPE = {
	markers: [{ cell_index: 0, marker: "different", reason: "Different but valid approach" }],
	gradeSuggestion: {
		dimensions: { code_quality_design: 4 },
		justification: "Solid work overall.",
	},
	feedbackDraft: "**Nice job** — keep it up.",
	notebookSummary: "The notebook computes a soil quality index.",
};

function makeExecutionResult(): ExecutionResult {
	return {
		success: true,
		notebookPath: `submissions/${ASSIGNMENT}/${STUDENT_A}.ipynb`,
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
	dataDir = await mkdtemp(path.join(os.tmpdir(), "scipro-preeval-tools-"));
	process.env.DATA_DIR = dataDir;

	await writeFile(path.join(dataDir, "assignments.yaml"), ASSIGNMENTS_YAML);
	await mkdir(path.join(dataDir, "materials", ASSIGNMENT), { recursive: true });
	await writeFile(path.join(dataDir, "materials", ASSIGNMENT, "key.ipynb"), KEY_NOTEBOOK);

	// Three submissions; only A and B have stored execution results.
	for (const student of [STUDENT_A, STUDENT_B, STUDENT_C]) {
		await upsertSubmission(ASSIGNMENT, student, {
			status: "executed",
			semester: "2026SS",
			fileName: `${student}.ipynb`,
			notebookPath: `submissions/${ASSIGNMENT}/${student}.ipynb`,
		});
	}
	await writeResults(ASSIGNMENT, {
		[STUDENT_A]: makeExecutionResult(),
		[STUDENT_B]: makeExecutionResult(),
	});

	kiConnectMock.chatCompletion.mockReset();
	kiConnectMock.chatCompletion.mockResolvedValue(ENVELOPE);
});

afterEach(async () => {
	delete process.env.DATA_DIR;
	await rm(dataDir, { recursive: true, force: true });
});

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
	return { signal: new AbortController().signal, ...overrides };
}

function registeredTools() {
	const registry = createRegistry();
	registerPreevalTools(registry);
	return registry;
}

// ---------------------------------------------------------------------------
// Registration + permissions
// ---------------------------------------------------------------------------

describe("registerPreevalTools", () => {
	it("registers pre-evaluate (auto) and pre-evaluate-all (approval + cost guard)", () => {
		const registry = registeredTools();
		const names = registry.list().map((t) => t.name);
		expect(names).toEqual(expect.arrayContaining(["pre-evaluate", "pre-evaluate-all"]));

		expect(registry.get("pre-evaluate").permission).toBe("auto");
		expect(registry.get("pre-evaluate-all").permission).toBe("approval");
		expect(ALWAYS_ASK_COST).toContain("pre-evaluate-all");
	});
});

// ---------------------------------------------------------------------------
// pre-evaluate
// ---------------------------------------------------------------------------

describe("pre-evaluate", () => {
	it("runs the service, persists preEval into results.json, and returns the envelope", async () => {
		const registry = registeredTools();
		const result = await registry.run(
			"pre-evaluate",
			{},
			makeContext({ submissionId: STUDENT_A, assignmentId: ASSIGNMENT }),
		);

		expect(result).toEqual(ENVELOPE);

		const stored = (await readResults(ASSIGNMENT))[STUDENT_A]!;
		expect(stored.preEval).toBeDefined();
		expect(stored.preEval!.evaluatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(stored.preEval!.markers).toEqual(ENVELOPE.markers);
		expect(stored.preEval!.gradeSuggestion).toEqual(ENVELOPE.gradeSuggestion);
		expect(stored.preEval!.feedbackDraft).toBe(ENVELOPE.feedbackDraft);
		expect(stored.preEval!.notebookSummary).toBe(ENVELOPE.notebookSummary);

		// Exactly one KI Connect call.
		expect(kiConnectMock.chatCompletion).toHaveBeenCalledTimes(1);
	});

	it("resolves submissionId from args and assignmentId via the enabled-assignment fallback", async () => {
		const registry = registeredTools();
		const result = await registry.run(
			"pre-evaluate",
			{ submissionId: STUDENT_B },
			makeContext(),
		);

		expect(result).toEqual(ENVELOPE);
		const stored = (await readResults(ASSIGNMENT))[STUDENT_B]!;
		expect(stored.preEval).toBeDefined();
	});

	it("throws when no submissionId is available (args or context)", async () => {
		const registry = registeredTools();
		await expect(registry.run("pre-evaluate", {}, makeContext())).rejects.toThrow(
			/pre-evaluate requires a submissionId/,
		);
		expect(kiConnectMock.chatCompletion).not.toHaveBeenCalled();
	});

	it("throws when no assignment is configured and none is given", async () => {
		await rm(path.join(dataDir, "assignments.yaml"));
		const registry = registeredTools();
		await expect(
			registry.run("pre-evaluate", { submissionId: STUDENT_A }, makeContext()),
		).rejects.toThrow(/no assignmentId given and no assignment is configured/);
	});
});

// ---------------------------------------------------------------------------
// pre-evaluate-all
// ---------------------------------------------------------------------------

describe("pre-evaluate-all", () => {
	it("loops every submission, survives a failing row, persists the rest, and summarizes", async () => {
		const registry = registeredTools();
		const summary = (await registry.run(
			"pre-evaluate-all",
			{},
			makeContext({ assignmentId: ASSIGNMENT }),
		)) as {
			assignmentId: string;
			total: number;
			succeeded: number;
			failed: number;
			results: Array<{ studentId: string; ok: boolean; error?: string }>;
		};

		expect(summary.assignmentId).toBe(ASSIGNMENT);
		expect(summary.total).toBe(3);
		expect(summary.succeeded).toBe(2);
		expect(summary.failed).toBe(1);

		const failedRow = summary.results.find((row) => row.studentId === STUDENT_C);
		expect(failedRow?.ok).toBe(false);
		expect(failedRow?.error).toContain("No stored execution result");

		// The loop did not abort: exactly one call per successful row.
		expect(kiConnectMock.chatCompletion).toHaveBeenCalledTimes(2);

		const results = await readResults(ASSIGNMENT);
		expect(results[STUDENT_A]!.preEval).toBeDefined();
		expect(results[STUDENT_B]!.preEval).toBeDefined();
		expect(results[STUDENT_C]).toBeUndefined();
	});

	it("surfaces a failing KI Connect call per row without aborting the loop", async () => {
		kiConnectMock.chatCompletion.mockRejectedValue(new Error("upstream timeout"));
		const registry = registeredTools();
		const summary = (await registry.run(
			"pre-evaluate-all",
			{ assignmentId: ASSIGNMENT },
			makeContext(),
		)) as { succeeded: number; failed: number; results: Array<{ ok: boolean }> };

		expect(summary.succeeded).toBe(0);
		expect(summary.failed).toBe(3);
		expect(summary.results.every((row) => row.ok === false)).toBe(true);
		// A and B reach the LLM and fail there; C never reaches it (no stored
		// execution result) — the loop survives both kinds of row failure.
		expect(kiConnectMock.chatCompletion).toHaveBeenCalledTimes(2);

		const results = await readResults(ASSIGNMENT);
		expect(results[STUDENT_A]!.preEval).toBeUndefined();
	});

	it("throws when no assignment is configured and none is given", async () => {
		await rm(path.join(dataDir, "assignments.yaml"));
		const registry = registeredTools();
		await expect(registry.run("pre-evaluate-all", {}, makeContext())).rejects.toThrow(
			/no assignmentId given and no assignment is configured/,
		);
	});
});
