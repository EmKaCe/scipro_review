/**
 * @file Unit tests for the copilot analysis tools (analysis-tools.ts).
 *
 * Registers the three analysis tools into a fresh createRegistry() with a
 * stubbed KI Connect client (vi.mock of $lib/server/ki-connect) and a real
 * temp DATA_DIR fixture: submissions/<assignment>/metadata.json +
 * results.json (built through the real store modules) and a key.ipynb under
 * materials/<assignment>/. Covers prompt composition (bounded source,
 * question, error text, key cells), missing-cell errors, and KI Connect
 * failure surfacing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createRegistry, type ToolContext } from "$lib/server/copilot/registry";
import { registerAnalysisTools } from "$lib/server/copilot/tools/analysis-tools";
import type { ExecutionResult } from "$lib/server/executor-client";
import { upsertSubmission } from "$lib/server/metadata";
import { writeResults } from "$lib/server/results-store";

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
const STUDENT = "2026SS_38";

const KEY_NOTEBOOK = JSON.stringify({
	cells: [
		{ cell_type: "markdown", source: ["# Task: Soil quality index\n"] },
		{
			cell_type: "code",
			source: ["def soil_quality_index(pollution):\n", "    return 100 - pollution\n"],
		},
	],
	metadata: {},
	nbformat: 4,
	nbformat_minor: 5,
});

function makeExecutionResult(): ExecutionResult {
	return {
		success: true,
		notebookPath: `submissions/${ASSIGNMENT}/${STUDENT}.ipynb`,
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
				marker: "pending",
			},
			{
				index: 1,
				type: "code",
				source: 'df = pd.read_csv("soil.csv")',
				original_source: 'df = pd.read_csv("soil.csv")',
				output: "",
				error: "FileNotFoundError: [Errno 2] No such file or directory: 'soil.csv'",
				traceback: ["FileNotFoundError: [Errno 2] No such file or directory: 'soil.csv'"],
				execution_count: 2,
				marker: "error",
			},
			{
				index: 2,
				type: "code",
				source: 'print("mean pollution:", df.pollution.mean())',
				original_source: 'print("mean pollution:", df.pollution.mean())',
				output: "",
				error: null,
				traceback: null,
				execution_count: null,
				marker: "pending",
			},
		],
		totalCells: 3,
		executedCells: 3,
		errorCells: 1,
		durationSeconds: 1.2,
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
	dataDir = await mkdtemp(path.join(os.tmpdir(), "scipro-analysis-tools-"));
	process.env.DATA_DIR = dataDir;

	// Submission registry + executed results (built through the real stores).
	await mkdir(path.join(dataDir, "submissions", ASSIGNMENT), { recursive: true });
	await upsertSubmission(ASSIGNMENT, STUDENT, {
		status: "executed",
		semester: "2026SS",
		fileName: `${STUDENT}.ipynb`,
		notebookPath: `submissions/${ASSIGNMENT}/${STUDENT}.ipynb`,
	});
	await writeResults(ASSIGNMENT, { [STUDENT]: makeExecutionResult() });

	// Reference key notebook under the assignment's materials directory.
	await mkdir(path.join(dataDir, "materials", ASSIGNMENT), { recursive: true });
	await writeFile(path.join(dataDir, "materials", ASSIGNMENT, "key.ipynb"), KEY_NOTEBOOK);

	kiConnectMock.chatCompletion.mockReset();
	// Envelope carries both fields so each tool reads its own.
	kiConnectMock.chatCompletion.mockResolvedValue({
		explanation: "default explanation",
		comparison: "default comparison",
	});
});

afterEach(async () => {
	delete process.env.DATA_DIR;
	await rm(dataDir, { recursive: true, force: true });
});

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
	return { submissionId: STUDENT, signal: new AbortController().signal, ...overrides };
}

function registeredTools() {
	const registry = createRegistry();
	registerAnalysisTools(registry);
	return registry;
}

/** The user prompt (second argument) of the last chatCompletion call. */
function lastUserPrompt(): string {
	const calls = kiConnectMock.chatCompletion.mock.calls;
	return String(calls[calls.length - 1]![1]);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe("registerAnalysisTools", () => {
	it("registers the three analysis tools with permission auto", () => {
		const registry = registeredTools();
		expect(registry.list()).toHaveLength(3);
		const names = registry.list().map((t) => t.name);
		expect(names).toEqual(
			expect.arrayContaining(["analyze-code", "explain-error", "compare-to-key"]),
		);
		for (const name of names) {
			expect(registry.get(name).permission).toBe("auto");
		}
	});
});

// ---------------------------------------------------------------------------
// analyze-code
// ---------------------------------------------------------------------------

describe("analyze-code", () => {
	it("passes the bounded cell source and the question, and returns the explanation", async () => {
		const registry = registeredTools();
		const explanation = await registry.run(
			"analyze-code",
			{ cellIndex: 0, question: "Why is this import here?" },
			makeContext(),
		);
		expect(explanation).toBe("default explanation");

		const prompt = lastUserPrompt();
		expect(prompt).toContain("import numpy as np");
		expect(prompt).toContain("Why is this import here?");
		expect(prompt).toContain("Submission: 2026SS_38");
		// JSON-object response format requested from KI Connect.
		expect(kiConnectMock.chatCompletion.mock.calls[0]![3]).toEqual({ type: "json_object" });
	});

	it("bounds long cell sources in the prompt", async () => {
		const longSource = "x = 1\n" + "# " + "y".repeat(6000) + "\nTAIL_MARKER_UNIQUE";
		await writeResults(ASSIGNMENT, {
			[STUDENT]: {
				...makeExecutionResult(),
				cells: [
					{
						...makeExecutionResult().cells[0]!,
						source: longSource,
						original_source: longSource,
					},
				],
			},
		});
		const registry = registeredTools();
		await registry.run("analyze-code", { cellIndex: 0 }, makeContext());

		const prompt = lastUserPrompt();
		expect(prompt).toContain("[truncated]");
		expect(prompt).not.toContain("TAIL_MARKER_UNIQUE");
		expect(prompt.length).toBeLessThan(longSource.length);
	});

	it("throws a clear error when the cell does not exist", async () => {
		const registry = registeredTools();
		await expect(
			registry.run("analyze-code", { cellIndex: 99 }, makeContext()),
		).rejects.toThrow(/Cell 99 not found in submission "2026SS_38"/);
	});

	it("throws when the submission cannot be resolved to an assignment", async () => {
		const registry = registeredTools();
		await expect(
			registry.run(
				"analyze-code",
				{ cellIndex: 0 },
				makeContext({ submissionId: "2026SS_99" }),
			),
		).rejects.toThrow(/2026SS_99/);
	});
});

// ---------------------------------------------------------------------------
// explain-error
// ---------------------------------------------------------------------------

describe("explain-error", () => {
	it("includes the error text and the cell source in the prompt, and returns the explanation", async () => {
		const registry = registeredTools();
		const explanation = await registry.run("explain-error", { cellIndex: 1 }, makeContext());
		expect(explanation).toBe("default explanation");

		const prompt = lastUserPrompt();
		expect(prompt).toContain("FileNotFoundError");
		expect(prompt).toContain('df = pd.read_csv("soil.csv")');
		expect(prompt).toContain("Earlier cells");
		expect(prompt).toContain("Failing cell 1");
	});

	it("throws when the cell did not produce an error", async () => {
		const registry = registeredTools();
		await expect(
			registry.run("explain-error", { cellIndex: 0 }, makeContext()),
		).rejects.toThrow(/did not produce an error/);
	});
});

// ---------------------------------------------------------------------------
// compare-to-key
// ---------------------------------------------------------------------------

describe("compare-to-key", () => {
	it("includes the key notebook cells and the task title in the prompt, and returns the comparison", async () => {
		const registry = registeredTools();
		const comparison = await registry.run(
			"compare-to-key",
			{ taskTitle: "Soil quality index" },
			makeContext(),
		);
		expect(comparison).toBe("default comparison");

		const prompt = lastUserPrompt();
		expect(prompt).toContain("Reference key");
		expect(prompt).toContain("def soil_quality_index");
		expect(prompt).toContain("Soil quality index");
		expect(prompt).toContain("Student submission");
		expect(prompt).toContain("FileNotFoundError"); // student error surfaced in the preview
	});

	it("throws when no key notebook exists for the assignment", async () => {
		await rm(path.join(dataDir, "materials", ASSIGNMENT), { recursive: true, force: true });
		const registry = registeredTools();
		await expect(registry.run("compare-to-key", {}, makeContext())).rejects.toThrow(
			/No reference key notebook/,
		);
	});
});

// ---------------------------------------------------------------------------
// KI Connect failure handling
// ---------------------------------------------------------------------------

describe("KI Connect failure handling", () => {
	it("throws a helpful error when chatCompletion rejects", async () => {
		kiConnectMock.chatCompletion.mockRejectedValueOnce(new Error("upstream timeout"));
		const registry = registeredTools();
		await expect(registry.run("analyze-code", { cellIndex: 0 }, makeContext())).rejects.toThrow(
			/KI Connect call failed for analyze-code/,
		);
	});

	it("throws a helpful error when chatCompletion returns no usable envelope", async () => {
		kiConnectMock.chatCompletion.mockResolvedValueOnce(null);
		const registry = registeredTools();
		await expect(registry.run("analyze-code", { cellIndex: 0 }, makeContext())).rejects.toThrow(
			/KI Connect returned no explanation/,
		);
	});
});
