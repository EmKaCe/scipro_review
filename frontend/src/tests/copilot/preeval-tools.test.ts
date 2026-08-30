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
	chatCompletionText: vi.fn(),
}));

vi.mock("$lib/server/ki-connect", () => ({
	getKiConnectClient: () => ({
		chatCompletion: kiConnectMock.chatCompletion,
		chatCompletionText: kiConnectMock.chatCompletionText,
		listModels: vi.fn().mockResolvedValue([]),
	}),
	warnIfUnknownModel: vi.fn().mockResolvedValue(undefined),
}));

// (B13) Cell screening is stubbed so pre-eval call-counts stay exact (no
// screening calls ride through kiConnectMock.chatCompletion).
const screeningCellsMock = vi.hoisted(() => ({ screenNotebookCells: vi.fn() }));

vi.mock("$lib/server/copilot/screening", () => ({
	screenNotebookCells: screeningCellsMock.screenNotebookCells,
	screenStudentContent: vi.fn(),
	INJECTION_CELL_PLACEHOLDER: "[cell content removed: injection attempt]",
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
	rubricSelections: [],
	// The fixture has no criteria files — the worksheet pipeline is skipped,
	// so the envelope carries an empty additionalNotes record.
	additionalNotes: {},
	feedbackDraft: "**Nice job** — keep it up.",
	notebookSummary: "The notebook computes a soil quality index.",
};

// Split into phase responses (Phase 2 is now 2a scoring + 2a critique;
// the worksheet rubric batches are skipped entirely — no criteria files).
const PHASE1_MARKERS = { markers: ENVELOPE.markers };
const PHASE3_FEEDBACK = {
	feedbackDraft: ENVELOPE.feedbackDraft,
	notebookSummary: ENVELOPE.notebookSummary,
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
	kiConnectMock.chatCompletionText.mockReset();
	// Default screening: pass cells through unchanged (clean).
	screeningCellsMock.screenNotebookCells.mockReset();
	screeningCellsMock.screenNotebookCells.mockImplementation(
		async (cells: readonly unknown[]) => ({
			cells: cells as typeof cells,
			needsReview: false,
		}),
	);
	kiConnectMock.chatCompletion.mockImplementation(async (systemPrompt: string) => {
		if (systemPrompt.includes("Your ONLY job is to mark each cell")) {
			return PHASE1_MARKERS;
		}
		// Phase 2a: scoring only (new split pipeline — must come before the legacy catch-all)
		if (systemPrompt.includes("Your ONLY job is to assign RAW POINT scores")) {
			return { gradeSuggestion: ENVELOPE.gradeSuggestion };
		}
		// Self-critique pass: review scores (optional, gated by CRITIQUE_ENABLED)
		if (systemPrompt.includes("reviewing dimension scores for correctness")) {
			return { gradeSuggestion: ENVELOPE.gradeSuggestion };
		}
		if (systemPrompt.includes("writing constructive feedback for ONE student")) {
			return PHASE3_FEEDBACK;
		}
		throw new Error(`Unexpected system prompt: ${systemPrompt.slice(0, 100)}`);
	});
	// The fixture has NO criteria files, so the worksheet pipeline is skipped
	// and the raw-text path must never be hit.
	kiConnectMock.chatCompletionText.mockImplementation(async () => {
		throw new Error("Unexpected chatCompletionText call — no rubric is configured");
	});
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
	it("registers pre-evaluate (auto), draft-notes (approval), and pre-evaluate-all (approval + cost guard)", () => {
		const registry = registeredTools();
		const names = registry.list().map((t) => t.name);
		expect(names).toEqual(
			expect.arrayContaining(["pre-evaluate", "draft-notes", "pre-evaluate-all"]),
		);

		expect(registry.get("pre-evaluate").permission).toBe("auto");
		expect(registry.get("draft-notes").permission).toBe("approval");
		expect(registry.get("pre-evaluate-all").permission).toBe("approval");
		expect(ALWAYS_ASK_COST).toContain("pre-evaluate-all");
	});
});

// ---------------------------------------------------------------------------
// pre-evaluate
// ---------------------------------------------------------------------------

describe("pre-evaluate", () => {
	/** Unwrap the __suggestion marker returned by the tool. */
	function unwrapGrade(result: unknown): {
		kind: string;
		title: string;
		body: string;
		actionLabel: string;
		data: unknown;
	} {
		const wrapped = result as { __suggestion?: Record<string, unknown> };
		expect(wrapped.__suggestion).toBeDefined();
		return wrapped.__suggestion as {
			kind: string;
			title: string;
			body: string;
			actionLabel: string;
			data: unknown;
		};
	}

	it("runs the service, persists preEval into results.json, and returns the envelope as a grade suggestion", async () => {
		const registry = registeredTools();
		const result = await registry.run(
			"pre-evaluate",
			{},
			makeContext({ submissionId: STUDENT_A, assignmentId: ASSIGNMENT }),
		);

		// 4e: the result is the envelope wrapped as a "grade" suggestion.
		const suggestion = unwrapGrade(result);
		expect(suggestion.kind).toBe("grade");
		expect(suggestion.title).toBe("Grade suggestion ready");
		expect(suggestion.actionLabel).toBe("Apply suggested scores");
		expect(suggestion.body).toBe(ENVELOPE.notebookSummary);
		// Wave 8: the envelope now carries postProcessed/postProcessFixes
		// alongside the raw fields — match the raw envelope only.
		expect(suggestion.data).toMatchObject(ENVELOPE);

		const stored = (await readResults(ASSIGNMENT))[STUDENT_A]!;
		expect(stored.preEval).toBeDefined();
		expect(stored.preEval!.evaluatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(stored.preEval!.markers).toEqual(ENVELOPE.markers);
		expect(stored.preEval!.gradeSuggestion).toEqual(ENVELOPE.gradeSuggestion);
		expect(stored.preEval!.rubricSelections).toEqual([]);
		expect(stored.preEval!.additionalNotes).toEqual({});
		expect(stored.preEval!.feedbackDraft).toBe(ENVELOPE.feedbackDraft);
		expect(stored.preEval!.notebookSummary).toBe(ENVELOPE.notebookSummary);

		// 4 KI Connect calls per submission (P1 markers, P2a scoring, 2a
		// critique, P3 feedback) — no worksheet batch calls: the fixture has
		// no criteria files, so the worksheet pipeline is skipped.
		expect(kiConnectMock.chatCompletion).toHaveBeenCalledTimes(4);
		expect(kiConnectMock.chatCompletionText).not.toHaveBeenCalled();
	});

	it("resolves submissionId from args and assignmentId via the enabled-assignment fallback", async () => {
		const registry = registeredTools();
		const result = await registry.run(
			"pre-evaluate",
			{ submissionId: STUDENT_B },
			makeContext(),
		);

		const suggestion = unwrapGrade(result);
		expect(suggestion.kind).toBe("grade");
		// Wave 8: the envelope now carries postProcessed/postProcessFixes
		// alongside the raw fields — match the raw envelope only.
		expect(suggestion.data).toMatchObject(ENVELOPE);
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
// draft-notes
// ---------------------------------------------------------------------------

describe("draft-notes", () => {
	it("runs the pre-evaluation service and returns the feedback draft as a draft suggestion", async () => {
		const registry = registeredTools();
		const result = await registry.run(
			"draft-notes",
			{},
			makeContext({ submissionId: STUDENT_A, assignmentId: ASSIGNMENT }),
		);

		const wrapped = result as { __suggestion?: Record<string, unknown> };
		expect(wrapped.__suggestion).toBeDefined();
		const suggestion = wrapped.__suggestion as {
			kind: string;
			title: string;
			body: string;
			actionLabel: string;
			data: { notes?: string };
		};
		expect(suggestion.kind).toBe("draft");
		expect(suggestion.title).toBe("Feedback draft ready");
		expect(suggestion.actionLabel).toBe("Use feedback draft");
		expect(suggestion.body).toBe(ENVELOPE.feedbackDraft);
		expect(suggestion.data.notes).toBe(ENVELOPE.feedbackDraft);

		// 4 KI Connect calls per submission (P1 markers, P2a scoring, 2a
		// critique, P3 feedback) — and NOTHING is persisted by draft-notes.
		expect(kiConnectMock.chatCompletion).toHaveBeenCalledTimes(4);
		expect(kiConnectMock.chatCompletionText).not.toHaveBeenCalled();
		const stored = (await readResults(ASSIGNMENT))[STUDENT_A]!;
		expect(stored.preEval).toBeUndefined();
	});

	it("throws when no submissionId is available (args or context)", async () => {
		const registry = registeredTools();
		await expect(registry.run("draft-notes", {}, makeContext())).rejects.toThrow(
			/draft-notes requires a submissionId/,
		);
		expect(kiConnectMock.chatCompletion).not.toHaveBeenCalled();
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

		// The loop did not abort: 4 calls per successful row (×2 rows).
		expect(kiConnectMock.chatCompletion).toHaveBeenCalledTimes(8);
		expect(kiConnectMock.chatCompletionText).not.toHaveBeenCalled();

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
		// Each attempt makes 3 phase calls, but the first Phase 1 call
		// for each row rejects, so only 2 calls per row actually fire.
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
