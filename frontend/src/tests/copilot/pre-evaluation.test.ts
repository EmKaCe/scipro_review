/**
 * @file Unit tests for the pre-evaluation service (pre-evaluation.ts).
 *
 * Uses a stubbed KI Connect client (vi.mock of $lib/server/ki-connect) with a
 * real temp DATA_DIR fixture: assignments.yaml + criteria YAML +
 * grading_config.yaml + input_data files + materials key notebook + a stored
 * execution result (results.json). Covers the validated envelope, the
 * grounded prompt (criteria, dimensions, file names, key summary, bounded
 * cells), the never-fabricate-markers rule (null without a key), and KI
 * Connect failure / invalid output surfacing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { preEvaluateSubmission } from "$lib/server/copilot/pre-evaluation";
import type { ExecutionResult } from "$lib/server/executor-client";
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

const ASSIGNMENTS_YAML = `assignments:
  - id: soil_contamination
    title: Soil Contamination by Factories
    enabled: true
    criteria_files:
      - data/criteria/soil_contamination.yaml
    dimensions:
      - code_quality_design
      - code_execution_results
      - assignment_requirements
`;

const CRITERIA_YAML = `categories:
  code_formatting:
    title: Code Formatting
    additional_notes: false
    positive:
      - main_point: Code follows PEP 8
        sub_points:
          - text: Readable variable names
            comment: false
            point_deduction: false
    neutral: []
    negative:
      - main_point: Formatting issues
        sub_points:
          - text: Inconsistent indentation
            comment: false
            point_deduction: false
`;

const GRADING_YAML = `dimensions:
  - key: code_quality_design
    title: Code Quality & Design
    max_points: 6
    weight: 1
  - key: code_execution_results
    title: Code Execution Results
    max_points: 6
    weight: 1
  - key: assignment_requirements
    title: Assignment Requirements
    max_points: 4
    weight: 1
grade_boundaries:
  - min_percentage: 95
    grade: 1.0
    label: excellent
    us_equiv: A+
`;

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

const ENVELOPE = {
	markers: [
		{ cell_index: 0, marker: "same", reason: "Same vectorized approach as the key" },
		{
			cell_index: 1,
			marker: "different",
			reason: "Reads the CSV directly instead of via the key's helper",
		},
	],
	gradeSuggestion: {
		dimensions: {
			code_quality_design: 5,
			code_execution_results: 4,
			assignment_requirements: 4,
		},
		justification: "Clean structure and correct results, with minor inefficiencies.",
	},
	feedbackDraft: "**Good work!** Consider extracting the index computation into a function.",
	notebookSummary: "The notebook loads soil contamination data and computes a quality index.",
};

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
				marker: "pending",
			},
		],
		totalCells: 2,
		executedCells: 2,
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
	dataDir = await mkdtemp(path.join(os.tmpdir(), "scipro-preeval-"));
	process.env.DATA_DIR = dataDir;

	// Assignment registry + rubric + grading config.
	await writeFile(path.join(dataDir, "assignments.yaml"), ASSIGNMENTS_YAML);
	await mkdir(path.join(dataDir, "criteria"), { recursive: true });
	await writeFile(path.join(dataDir, "criteria", "soil_contamination.yaml"), CRITERIA_YAML);
	await writeFile(path.join(dataDir, "grading_config.yaml"), GRADING_YAML);

	// Stored execution result (single execution carries cells).
	await mkdir(path.join(dataDir, "submissions", ASSIGNMENT), { recursive: true });
	await writeResults(ASSIGNMENT, { [STUDENT]: makeExecutionResult() });

	// Reference key + input data files (materials).
	await mkdir(path.join(dataDir, "materials", ASSIGNMENT, "input_data"), { recursive: true });
	await writeFile(path.join(dataDir, "materials", ASSIGNMENT, "key.ipynb"), KEY_NOTEBOOK);
	await writeFile(path.join(dataDir, "materials", ASSIGNMENT, "input_data", "soil.csv"), "x,y\n");

	kiConnectMock.chatCompletion.mockReset();
	kiConnectMock.chatCompletion.mockResolvedValue(ENVELOPE);
});

afterEach(async () => {
	delete process.env.DATA_DIR;
	await rm(dataDir, { recursive: true, force: true });
});

/** The user prompt (second argument) of the last chatCompletion call. */
function lastUserPrompt(): string {
	const calls = kiConnectMock.chatCompletion.mock.calls;
	return String(calls[calls.length - 1]![1]);
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("preEvaluateSubmission", () => {
	it("returns the validated envelope and grounds the prompt in assignment context", async () => {
		const result = await preEvaluateSubmission({
			submissionId: STUDENT,
			assignmentId: ASSIGNMENT,
		});

		expect(result).toEqual(ENVELOPE);

		const prompt = lastUserPrompt();
		// Criteria rubric.
		expect(prompt).toContain("Code Formatting");
		expect(prompt).toContain("Code follows PEP 8");
		// Grading dimensions.
		expect(prompt).toContain("code_quality_design | Code Quality & Design | max 6");
		// Input data file names (available_paths style).
		expect(prompt).toContain("soil.csv");
		// Reference key summary.
		expect(prompt).toContain("key.ipynb");
		expect(prompt).toContain("def soil_quality_index");
		// Bounded executed cells.
		expect(prompt).toContain("[Cell 1] code");
		expect(prompt).toContain("FileNotFoundError");

		// JSON-object response format requested from KI Connect.
		expect(kiConnectMock.chatCompletion.mock.calls[0]![3]).toEqual({ type: "json_object" });
	});

	it("bounds long cell sources and outputs in the prompt", async () => {
		const longSource =
			Array.from({ length: 60 }, (_, i) => `print(${i})`).join("\n") + "\nTAIL_MARKER_UNIQUE";
		const longOutput = "z".repeat(700);
		await writeResults(ASSIGNMENT, {
			[STUDENT]: {
				...makeExecutionResult(),
				cells: [
					{
						...makeExecutionResult().cells[0]!,
						source: longSource,
						original_source: longSource,
						output: longOutput,
					},
				],
			},
		});

		await preEvaluateSubmission({ submissionId: STUDENT, assignmentId: ASSIGNMENT });

		const prompt = lastUserPrompt();
		expect(prompt).toContain("[source truncated after 40 lines]");
		expect(prompt).not.toContain("TAIL_MARKER_UNIQUE");
		expect(prompt).toContain("[output truncated]");
	});

	it("throws when the submission has no stored execution result", async () => {
		await expect(
			preEvaluateSubmission({ submissionId: "2026SS_99", assignmentId: ASSIGNMENT }),
		).rejects.toThrow(/No stored execution result for submission "2026SS_99"/);
	});

	it("throws when the stored result carries no executed cells (batch summary)", async () => {
		await writeResults(ASSIGNMENT, {
			[STUDENT]: { ...makeExecutionResult(), cells: [] },
		});
		await expect(
			preEvaluateSubmission({ submissionId: STUDENT, assignmentId: ASSIGNMENT }),
		).rejects.toThrow(/no stored executed cell data/);
	});
});

// ---------------------------------------------------------------------------
// Markers are never fabricated
// ---------------------------------------------------------------------------

describe("markers are never fabricated", () => {
	it("forces markers null when the reference key notebook is missing", async () => {
		await rm(path.join(dataDir, "materials", ASSIGNMENT), { recursive: true, force: true });

		const result = await preEvaluateSubmission({
			submissionId: STUDENT,
			assignmentId: ASSIGNMENT,
		});

		// The model returned markers — the service must NOT trust them.
		expect(kiConnectMock.chatCompletion).toHaveBeenCalledTimes(1);
		expect(result.markers).toBeNull();
		expect(result.gradeSuggestion).toEqual(ENVELOPE.gradeSuggestion);
		expect(result.feedbackDraft).toBe(ENVELOPE.feedbackDraft);
		expect(result.notebookSummary).toBe(ENVELOPE.notebookSummary);
		expect(lastUserPrompt()).toContain("Reference key notebook: none available");
	});

	it("forces markers null when the key notebook exists but is unreadable", async () => {
		await writeFile(
			path.join(dataDir, "materials", ASSIGNMENT, "key.ipynb"),
			"this is not json {",
		);

		const result = await preEvaluateSubmission({
			submissionId: STUDENT,
			assignmentId: ASSIGNMENT,
		});

		expect(result.markers).toBeNull();
		expect(result.gradeSuggestion.dimensions.code_quality_design).toBe(5);
	});
});

// ---------------------------------------------------------------------------
// Failure handling
// ---------------------------------------------------------------------------

describe("KI Connect failure handling", () => {
	it("throws a helpful error when chatCompletion rejects (incl. bad JSON)", async () => {
		kiConnectMock.chatCompletion.mockRejectedValueOnce(new Error("Unexpected token < in JSON"));
		await expect(
			preEvaluateSubmission({ submissionId: STUDENT, assignmentId: ASSIGNMENT }),
		).rejects.toThrow(/KI Connect call failed for pre-evaluation of submission "2026SS_38"/);
	});

	it("throws when the model output does not match the envelope shape", async () => {
		kiConnectMock.chatCompletion.mockResolvedValueOnce({
			markers: "nope",
			gradeSuggestion: 42,
		});
		await expect(
			preEvaluateSubmission({ submissionId: STUDENT, assignmentId: ASSIGNMENT }),
		).rejects.toThrow(/returned invalid output/);
	});

	it("throws when chatCompletion returns nothing usable (null)", async () => {
		kiConnectMock.chatCompletion.mockResolvedValueOnce(null);
		await expect(
			preEvaluateSubmission({ submissionId: STUDENT, assignmentId: ASSIGNMENT }),
		).rejects.toThrow(/returned invalid output/);
	});
});
