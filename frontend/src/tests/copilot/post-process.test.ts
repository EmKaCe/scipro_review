/**
 * @file Unit tests for the post-processing layer (post-process.ts).
 *
 * Covers all 6 deterministic correction passes via the 8 canonical cases:
 * empty mandatory-category fill (GenAI), checkbox-textarea sync, the
 * disallowed-library scan in both directions, plagiarism stripping, filler
 * stripping, execution-evidence textarea fill (SciPy R^2/RMSE), and the
 * PostProcessResult contract. Pure logic — no mocks needed.
 */

import { describe, expect, it } from "vitest";

import { postProcessSubmission } from "$lib/server/copilot/post-process";
import type { PostProcessOptions } from "$lib/server/copilot/post-process";
import type { PreAnalysis } from "$lib/server/copilot/pre-analysis";
import type { ExecutionResult, ExecutedCell } from "$lib/server/executor-client";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Full 5-dimension score set (soil_contamination weights: ×4 ×4 ×4 ×4 ×1). */
const DIMENSIONS: Record<string, number> = {
	code_quality_design: 4,
	code_execution_results: 5,
	assignment_requirements: 5,
	scientific_programming: 4.5,
	creativity: 3,
};

function makePreAnalysis(overrides: Partial<PreAnalysis> = {}): PreAnalysis {
	return {
		nonDescriptiveNames: [],
		importsNotAlphabetized: false,
		unusedImports: [],
		codeCellCount: 8,
		markdownCellCount: 6,
		citationCount: 3,
		hasInterpretation: true,
		errorCount: 0,
		issueSummary: "no deterministic issues detected",
		...overrides,
	};
}

function makeCell(index: number, source: string, output = ""): ExecutedCell {
	return {
		index,
		type: "code",
		source,
		original_source: source,
		output,
		error: null,
		traceback: null,
		execution_count: index + 1,
		marker: "same",
	};
}

function makeExecutionRecord(overrides: Partial<ExecutionResult> = {}): ExecutionResult {
	return {
		success: true,
		notebookPath: "submissions/soil_contamination/2026SS_38.ipynb",
		cells: [],
		fixedCells: null,
		totalCells: 0,
		executedCells: 0,
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
		autofix: { attempts: 0, succeeded: 0 },
		...overrides,
	};
}

function makeOptions(overrides: Partial<PostProcessOptions> = {}): PostProcessOptions {
	return {
		submissionId: "2026SS_38",
		dimensions: DIMENSIONS,
		rubricSelections: [],
		additionalNotes: {},
		preAnalysis: makePreAnalysis(),
		executionRecord: makeExecutionRecord(),
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("postProcessSubmission", () => {
	it("fills empty GenAI category with 'no concerns' textarea", () => {
		const { data, result } = postProcessSubmission(makeOptions());

		expect(data.additionalNotes["genai"]).toContain("No GenAI concerns");
		expect(result.fixes).toContainEqual(
			expect.objectContaining({ pass: "fill-empty", field: "GenAI-textarea" }),
		);
	});

	it("adds checkbox when textarea claim matches existing rubric item", () => {
		const { data, result } = postProcessSubmission(
			makeOptions({
				rubricSelections: [
					{
						categoryKey: "code_formatting",
						optionKey: "spacing - consistent and correct usage",
					},
				],
				additionalNotes: {
					code_formatting: "The imports are not alphabetized in the first cell.",
				},
			}),
		);

		expect(data.rubricSelections).toContainEqual(
			expect.objectContaining({
				categoryKey: "code_formatting",
				optionKey: "imports - not alphabetized",
			}),
		);
		expect(result.fixes).toContainEqual(
			expect.objectContaining({
				pass: "checkbox-textarea-sync",
				field: "codeFormatting-negative:imports - not alphabetized",
			}),
		);
	});

	it("removes 'Disallowed libraries not used' when seaborn is imported", () => {
		const { data, result } = postProcessSubmission(
			makeOptions({
				executionRecord: makeExecutionRecord({
					cells: [
						makeCell(0, "import numpy as np"),
						makeCell(1, "import seaborn as sns"),
					],
				}),
				rubricSelections: [
					{
						categoryKey: "following_instructions",
						optionKey: "Disallowed libraries were not used.",
					},
				],
			}),
		);

		expect(data.rubricSelections).not.toContainEqual(
			expect.objectContaining({
				categoryKey: "following_instructions",
				optionKey: "Disallowed libraries were not used.",
			}),
		);
		expect(result.fixes).toContainEqual(
			expect.objectContaining({ pass: "disallowed-library-scan", newValue: "(removed)" }),
		);
	});

	it("adds 'Disallowed libraries not used' when imports are clean", () => {
		// Give following_instructions another selection so Pass 1 skips it and
		// the addition is provably done by the disallowed-library scan (Pass 3).
		const { data, result } = postProcessSubmission(
			makeOptions({
				executionRecord: makeExecutionRecord({
					cells: [
						makeCell(0, "import numpy as np"),
						makeCell(1, "import pandas as pd"),
						makeCell(2, "from sklearn.cluster import KMeans"),
						makeCell(3, "import matplotlib.pyplot as plt"),
					],
				}),
				rubricSelections: [
					{
						categoryKey: "following_instructions",
						optionKey: "The solution adhered to all submission requirements.",
					},
				],
			}),
		);

		expect(data.rubricSelections).toContainEqual(
			expect.objectContaining({
				categoryKey: "following_instructions",
				optionKey: "Disallowed libraries were not used.",
			}),
		);
		expect(result.fixes).toContainEqual(
			expect.objectContaining({ pass: "disallowed-library-scan", newValue: "checked" }),
		);
	});

	it("strips plagiarism sentences from academicScholarship textarea", () => {
		const { data, result } = postProcessSubmission(
			makeOptions({
				additionalNotes: {
					academic_scholarship:
						"Your solution was very similar to another student's solution. Otherwise the analysis is solid.",
				},
			}),
		);

		expect(data.additionalNotes["academic_scholarship"]).not.toContain(
			"similar to another student",
		);
		expect(data.additionalNotes["academic_scholarship"]).toContain("analysis is solid");
		expect(result.fixes).toContainEqual(
			expect.objectContaining({
				pass: "strip-plagiarism",
				field: "academicScholarship-textarea",
			}),
		);
	});

	it("strips 'ID at top of the notebook' filler from textarea", () => {
		const { data, result } = postProcessSubmission(
			makeOptions({
				additionalNotes: {
					code_formatting: "Student added their SciPro ID to the top of the notebook.",
				},
			}),
		);

		expect(data.additionalNotes["code_formatting"]).not.toContain("SciPro ID");
		expect(data.additionalNotes["code_formatting"]).toBe("No significant issues found.");
		expect(result.fixes).toContainEqual(
			expect.objectContaining({ pass: "strip-filler", field: "codeFormatting-textarea" }),
		);
	});

	it("fills SciPy textarea with R squared and RMSE from execution record", () => {
		const { data, result } = postProcessSubmission(
			makeOptions({
				executionRecord: makeExecutionRecord({
					cells: [
						makeCell(0, "import numpy as np"),
						makeCell(1, "from scipy.optimize import curve_fit"),
						makeCell(
							2,
							"popt, pcov = curve_fit(plume_model, xdata=x, ydata=y)",
							"R^2 = 0.941\nRMSE = 42.58",
						),
					],
				}),
			}),
		);

		expect(data.additionalNotes["scipy"]).toContain("0.941");
		expect(data.additionalNotes["scipy"]).toContain("42.58");
		expect(result.fixes).toContainEqual(
			expect.objectContaining({ pass: "fill-textarea", field: "SciPy-textarea" }),
		);
	});

	it("returns PostProcessResult with all fix records", () => {
		const { result } = postProcessSubmission(
			makeOptions({
				rubricSelections: [{ categoryKey: "general_feedback", optionKey: "good" }],
				additionalNotes: {
					code_formatting: "Imports are not alphabetized and naming is not descriptive.",
					academic_scholarship:
						"The code was similar to another student. Plagiarism concerns noted.",
				},
			}),
		);

		expect(result.submissionId).toBe("2026SS_38");
		expect(result.fixes.length).toBeGreaterThan(0);
		for (const fix of result.fixes) {
			expect(fix.pass).toBeTruthy();
			expect(fix.field).toBeTruthy();
			expect(fix.oldValue === null || typeof fix.oldValue === "string").toBe(true);
			expect(typeof fix.newValue).toBe("string");
			expect(typeof fix.reason).toBe("string");
		}
	});
});
