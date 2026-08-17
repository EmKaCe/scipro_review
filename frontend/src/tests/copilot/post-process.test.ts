/**
 * @file Unit tests for the post-processing layer (post-process.ts).
 *
 * Covers all 7 deterministic correction passes via the canonical cases:
 * empty mandatory-category fill (GenAI), checkbox-textarea sync, the
 * disallowed-library scan in both directions, plagiarism stripping, filler
 * stripping, execution-evidence textarea fill (SciPy R^2/RMSE), the
 * evidence-grounded selection corrections, and the PostProcessResult
 * contract. Pure logic — no mocks needed.
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
		importsAlphabetized: true,
		disallowedImports: [],
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
				// Evidence must agree with the textarea claim, otherwise
				// Pass 7 (evidence-grounded) flips the checkbox back.
				preAnalysis: makePreAnalysis({
					importsAlphabetized: false,
					importsNotAlphabetized: true,
				}),
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

	it("strips 'copied from' plagiarism language from a textarea", () => {
		const { data, result } = postProcessSubmission(
			makeOptions({
				additionalNotes: {
					academic_scholarship:
						"The solution appears copied from the reference solution. Otherwise the analysis is solid and the discussion is well structured.",
				},
			}),
		);

		expect(data.additionalNotes["academic_scholarship"]).not.toContain("copied from");
		expect(data.additionalNotes["academic_scholarship"]).toContain(
			"Otherwise the analysis is solid",
		);
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

	it("flips the alphabetized positive to the not-alphabetized negative when evidence says imports are not alphabetized", () => {
		const { data, result } = postProcessSubmission(
			makeOptions({
				preAnalysis: makePreAnalysis({
					importsAlphabetized: false,
					importsNotAlphabetized: true,
				}),
				rubricSelections: [
					{
						categoryKey: "code_formatting",
						optionKey: "imports - libraries were alphabetized",
					},
				],
			}),
		);

		expect(data.rubricSelections).not.toContainEqual(
			expect.objectContaining({
				categoryKey: "code_formatting",
				optionKey: "imports - libraries were alphabetized",
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
				pass: "evidence-grounded",
				field: "codeFormatting-negative:imports - not alphabetized",
				newValue: "checked",
			}),
		);
	});

	it("flips the not-alphabetized negative to the alphabetized positive when evidence says imports are alphabetized", () => {
		const { data, result } = postProcessSubmission(
			makeOptions({
				// Default makePreAnalysis: importsAlphabetized: true.
				rubricSelections: [
					{
						categoryKey: "code_formatting",
						optionKey: "imports - not alphabetized",
					},
				],
			}),
		);

		expect(data.rubricSelections).not.toContainEqual(
			expect.objectContaining({
				categoryKey: "code_formatting",
				optionKey: "imports - not alphabetized",
			}),
		);
		expect(data.rubricSelections).toContainEqual(
			expect.objectContaining({
				categoryKey: "code_formatting",
				optionKey: "imports - libraries were alphabetized",
			}),
		);
		expect(result.fixes).toContainEqual(
			expect.objectContaining({
				pass: "evidence-grounded",
				field: "codeFormatting-positive:imports - libraries were alphabetized",
				newValue: "checked",
			}),
		);
	});

	it("unchecks the descriptive-naming positive when non-descriptive names are detected", () => {
		const { data, result } = postProcessSubmission(
			makeOptions({
				preAnalysis: makePreAnalysis({ nonDescriptiveNames: ["df", "x"] }),
				rubricSelections: [
					{
						categoryKey: "code_formatting",
						optionKey: "naming - descriptive objects/variables (i.e., human readable)",
					},
				],
			}),
		);

		expect(data.rubricSelections).not.toContainEqual(
			expect.objectContaining({
				categoryKey: "code_formatting",
				optionKey: "naming - descriptive objects/variables (i.e., human readable)",
			}),
		);
		expect(result.fixes).toContainEqual(
			expect.objectContaining({
				pass: "evidence-grounded",
				field: "codeFormatting-positive:naming - descriptive objects/variables (i.e., human readable)",
				newValue: "(removed)",
			}),
		);
	});

	it("adds the unused-imports negative to coding_concept when unused imports are detected", () => {
		const { data, result } = postProcessSubmission(
			makeOptions({
				preAnalysis: makePreAnalysis({ unusedImports: ["os"] }),
			}),
		);

		expect(data.rubricSelections).toContainEqual(
			expect.objectContaining({
				categoryKey: "coding_concept",
				optionKey: "imports - libraries were imported, but not used (not concise coding)",
			}),
		);
		expect(result.fixes).toContainEqual(
			expect.objectContaining({
				pass: "evidence-grounded",
				field: "codingConcept-negative:imports - libraries were imported, but not used (not concise coding)",
				newValue: "checked",
			}),
		);
	});

	it("adds the no-interpretation negative to general_feedback when markdown has no interpretation", () => {
		const { data, result } = postProcessSubmission(
			makeOptions({
				preAnalysis: makePreAnalysis({
					hasInterpretation: false,
					markdownCellCount: 3,
				}),
			}),
		);

		expect(data.rubricSelections).toContainEqual(
			expect.objectContaining({
				categoryKey: "general_feedback",
				optionKey:
					"interpretation - there was no or little attempt to interpret or discuss the code's results",
			}),
		);
		expect(result.fixes).toContainEqual(
			expect.objectContaining({
				pass: "evidence-grounded",
				field: "general-negative:interpretation - there was no or little attempt to interpret or discuss the code's results",
				newValue: "checked",
			}),
		);
	});

	it("adds the no-citations negative to academic_scholarship when markdown has no citations", () => {
		const { data, result } = postProcessSubmission(
			makeOptions({
				preAnalysis: makePreAnalysis({
					citationCount: 0,
					markdownCellCount: 3,
				}),
			}),
		);

		expect(data.rubricSelections).toContainEqual(
			expect.objectContaining({
				categoryKey: "academic_scholarship",
				optionKey:
					"As a university student, you should be citing sources of knowledge. This is something that you will need to do for your thesis.",
			}),
		);
		expect(result.fixes).toContainEqual(
			expect.objectContaining({
				pass: "evidence-grounded",
				field: "academicScholarship-negative:As a university student, you should be citing sources of knowledge. This is something that you will need to do for your thesis.",
				newValue: "checked",
			}),
		);
	});

	it("syncs textarea mention of non-descriptive names to the naming negative", () => {
		const { data, result } = postProcessSubmission(
			makeOptions({
				additionalNotes: {
					code_formatting: "Non-descriptive variable name(s): df, x.",
				},
			}),
		);

		expect(data.rubricSelections).toContainEqual(
			expect.objectContaining({
				categoryKey: "code_formatting",
				optionKey: "naming - object/variable (e.g., df, data, x, y) is not descriptive enough",
			}),
		);
		// "non-descriptive" must NOT trigger the descriptive positive.
		expect(data.rubricSelections).not.toContainEqual(
			expect.objectContaining({
				categoryKey: "code_formatting",
				optionKey: "naming - descriptive objects/variables (i.e., human readable)",
			}),
		);
		expect(result.fixes).toContainEqual(
			expect.objectContaining({
				pass: "checkbox-textarea-sync",
				field: "codeFormatting-negative:naming - object/variable (e.g., df, data, x, y) is not descriptive enough",
			}),
		);
	});

	it("syncs textarea mention of a double blank line to the too-many-blank-lines negative", () => {
		const { data } = postProcessSubmission(
			makeOptions({
				additionalNotes: {
					code_formatting: "The plume function body contains a double blank line.",
				},
			}),
		);

		expect(data.rubricSelections).toContainEqual(
			expect.objectContaining({
				categoryKey: "code_formatting",
				optionKey: "blank lines - too many used (i.e., not concise)",
			}),
		);
	});

	it("syncs textarea mention of imports not at the top to the imports-placement negative", () => {
		const { data } = postProcessSubmission(
			makeOptions({
				additionalNotes: {
					code_formatting: "Imports are not listed together at the notebook's top.",
				},
			}),
		);

		expect(data.rubricSelections).toContainEqual(
			expect.objectContaining({
				categoryKey: "code_formatting",
				optionKey: "imports - not listed together at the notebook's top",
			}),
		);
	});

	it("strips generic LLM filler sentences from textareas", () => {
		const { data, result } = postProcessSubmission(
			makeOptions({
				additionalNotes: {
					code_formatting:
						"The notebook is well-structured. The solution is well organized. All required tasks were completed. The student clearly demonstrates understanding. The code generally follows best practices. The submission meets all requirements. Actual feedback here.",
				},
			}),
		);

		expect(data.additionalNotes["code_formatting"]).toBe("Actual feedback here.");
		expect(result.fixes).toContainEqual(
			expect.objectContaining({ pass: "strip-filler", field: "codeFormatting-textarea" }),
		);
	});

	it("uses importsAlphabetized (whole-list) when generating the codeFormatting note", () => {
		const { data } = postProcessSubmission(
			makeOptions({
				preAnalysis: makePreAnalysis({
					// Split-block heuristic says sorted, whole-list check says NOT.
					importsNotAlphabetized: false,
					importsAlphabetized: false,
				}),
			}),
		);

		expect(data.additionalNotes["code_formatting"]).toContain(
			"Imports are not alphabetized.",
		);
	});
});
