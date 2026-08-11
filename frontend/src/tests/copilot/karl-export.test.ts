/**
 * @file Unit tests for the Karl-form grading JSON export (karl-export.ts).
 *
 * Uses a real temp DATA_DIR fixture (criteria/general.yaml) so the export's
 * criteria loading and sentiment/main-point lookup run against actual YAML.
 * Covers the weighted grade formula, the 5 grading slider keys, Karl element
 * IDs for checkboxes (verbatim text — typos and double spaces included),
 * textarea prefixes, the evaluation-textbox summary, and the fail-loud
 * behavior for unmatched rubric selections.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
	findSentimentAndMainPoint,
	generateKarlJson,
	karlGrade,
	weightedPercentage,
} from "$lib/server/copilot/karl-export";
import type { GenerateKarlJsonOptions } from "$lib/server/copilot/karl-export";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Minimal criteria fixture: 3 categories with known Karl prefixes. */
const CRITERIA_YAML = `categories:
  code_formatting:
    title: Code Formatting
    additional_notes: true
    positive:
      - main_point: Formatting is done well, which includes
        sub_points:
          - text: imports - libraries were alphabetized
          - text: naming - descriptive objects/variables (i.e., human readable)
    neutral: []
    negative:
      - main_point: The following formatting issues were present in your code
        sub_points:
          - text: imports - not alphabetized
          - text: line length - too long (i.e., requiring scrolling)
  pandas:
    title: Pandas
    additional_notes: true
    positive:
      - main_point: Data manipulation done well, which includes
        sub_points:
          - text: merging - proper usage
          - text: filtering - proper usage
    neutral: []
    negative:
      - main_point: Data manipulation issues, which includes the following
        sub_points:
          - text: merging - incorrect usage
  general_feedback:
    title: General Feedback
    additional_notes: true
    positive:
      - main_point: Overall, your work done on this assignment was
        sub_points:
          - text: excellent
          - text: very good
    neutral:
      - main_point: Overall, your work done on this assignment was
        sub_points:
          - text: "okay  - there is notable room for improvement"
    negative:
      - main_point: The following were problems with your solutions
        sub_points:
          - text: interpretation - there was no or little attempt to interpret or discuss the code's results
`;

const CRITERIA_FILE = "data/criteria/general.yaml";

/** Dimension scores from the brief's worked example: weighted = 87.0 → grade 1.7. */
const BASE_DIMENSIONS = {
	code_quality_design: 4.5,
	code_execution_results: 5.5,
	assignment_requirements: 5.5,
	scientific_programming: 5.5,
	creativity: 3.0,
};

/** Karl's 5 grading slider element IDs. */
const SLIDER_KEYS = [
	"codequality-grading",
	"codeexecution-grading",
	"assignmentrequirements-grading",
	"scientific-grading",
	"creativity-grading",
];

/** The 14 Karl form prefixes (ground truth, independent of karl-catalog). */
const KNOWN_PREFIXES = [
	"codeFormatting",
	"codingConcept",
	"jupyterNotebooks",
	"academicScholarship",
	"followingInstructions",
	"general",
	"Pandas",
	"NumPy",
	"SciPy",
	"sklearn",
	"GenAI",
	"userDefinedFunctions",
	"callingFunction",
	"plotting",
];

function makeOptions(overrides: Partial<GenerateKarlJsonOptions> = {}): GenerateKarlJsonOptions {
	return {
		submissionId: "2026SS_00",
		dimensions: { ...BASE_DIMENSIONS },
		rubricSelections: [],
		additionalNotes: {},
		criteriaFiles: [CRITERIA_FILE],
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Test environment: real temp DATA_DIR with a criteria fixture
// ---------------------------------------------------------------------------

let dataDir: string;

beforeEach(async () => {
	dataDir = await mkdtemp(path.join(os.tmpdir(), "scipro-karl-export-"));
	process.env.DATA_DIR = dataDir;
	await mkdir(path.join(dataDir, "criteria"), { recursive: true });
	await writeFile(path.join(dataDir, "criteria", "general.yaml"), CRITERIA_YAML);
});

afterEach(async () => {
	delete process.env.DATA_DIR;
	await rm(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("generateKarlJson", () => {
	it("emits the 5 grading slider keys with string score values", async () => {
		const output = await generateKarlJson(makeOptions());

		expect(output["codequality-grading"]).toBe("4.5");
		expect(output["codeexecution-grading"]).toBe("5.5");
		expect(output["assignmentrequirements-grading"]).toBe("5.5");
		expect(output["scientific-grading"]).toBe("5.5");
		expect(output["creativity-grading"]).toBe("3.0");

		for (const key of SLIDER_KEYS) {
			expect(typeof output[key]).toBe("string");
		}
	});

	it("applies the weighted formula and grade boundaries (87.0 → 1.7)", async () => {
		expect(weightedPercentage(BASE_DIMENSIONS)).toBe(87.0);
		expect(karlGrade(87.0)).toBe(1.7);

		const output = await generateKarlJson(makeOptions());
		expect(output["evaluation-textbox"]).toContain("1.7");
		expect(output["evaluation-textbox"]).toContain("87.0");
	});

	it("maps every grade boundary correctly", () => {
		expect(karlGrade(95)).toBe(1.0);
		expect(karlGrade(94.99)).toBe(1.3);
		expect(karlGrade(90)).toBe(1.3);
		expect(karlGrade(85)).toBe(1.7);
		expect(karlGrade(80)).toBe(2.0);
		expect(karlGrade(75)).toBe(2.3);
		expect(karlGrade(70)).toBe(2.7);
		expect(karlGrade(69.99)).toBe(3.0);
		expect(karlGrade(0)).toBe(3.0);
	});

	it("caps the weighted percentage at 100", () => {
		const maxed = {
			code_quality_design: 6,
			code_execution_results: 6,
			assignment_requirements: 6,
			scientific_programming: 6,
			creativity: 4,
		};
		expect(weightedPercentage(maxed)).toBe(100);
		expect(weightedPercentage({})).toBe(0);
	});

	it('emits "checked" checkbox keys using Karl element IDs (prefix-sentiment-mainPoint-subPoint)', async () => {
		const output = await generateKarlJson(
			makeOptions({
				rubricSelections: [
					{ categoryKey: "pandas", optionKey: "merging - proper usage" },
					{ categoryKey: "code_formatting", optionKey: "imports - not alphabetized" },
					{ categoryKey: "general_feedback", optionKey: "excellent" },
				],
			}),
		);

		expect(
			output[
				"Pandas-positive-Data manipulation done well, which includes-merging - proper usage"
			],
		).toBe("checked");
		expect(
			output[
				"codeFormatting-negative-The following formatting issues were present in your code-imports - not alphabetized"
			],
		).toBe("checked");
		expect(
			output["general-positive-Overall, your work done on this assignment was-excellent"],
		).toBe("checked");
	});

	it("preserves Karl's verbatim text (double spaces, typos) in checkbox IDs", async () => {
		const output = await generateKarlJson(
			makeOptions({
				rubricSelections: [
					{
						categoryKey: "general_feedback",
						optionKey: "okay  - there is notable room for improvement",
					},
				],
			}),
		);

		expect(
			output[
				"general-neutral-Overall, your work done on this assignment was-okay  - there is notable room for improvement"
			],
		).toBe("checked");
	});

	it("emits textarea keys with the Karl category prefix (general_feedback → general-textarea)", async () => {
		const notes = {
			code_formatting: "Imports follow stdlib→third-party convention.",
			general_feedback: "Solid overall work.",
		};
		const output = await generateKarlJson(makeOptions({ additionalNotes: notes }));

		expect(output["codeFormatting-textarea"]).toBe(notes.code_formatting);
		expect(output["general-textarea"]).toBe(notes.general_feedback);
	});

	it("includes an evaluation-textbox with the grade summary and key findings", async () => {
		const output = await generateKarlJson(
			makeOptions({
				additionalNotes: { pandas: "Merges are correct and well documented." },
			}),
		);

		const summary = output["evaluation-textbox"];
		expect(summary).toContain("2026SS_00");
		expect(summary).toContain("1.7");
		expect(summary).toContain("87.0");
		expect(summary).toContain("Key findings");
		expect(summary).toContain("pandas: Merges are correct and well documented.");
	});

	it("does not emit keys that do not exist in Karl's rubric", async () => {
		const output = await generateKarlJson(
			makeOptions({
				rubricSelections: [
					{
						categoryKey: "code_formatting",
						optionKey: "imports - libraries were alphabetized",
					},
					{ categoryKey: "pandas", optionKey: "merging - incorrect usage" },
				],
				additionalNotes: {
					code_formatting: "Imports follow stdlib→third-party convention.",
				},
			}),
		);

		for (const key of Object.keys(output)) {
			if (SLIDER_KEYS.includes(key) || key === "evaluation-textbox") continue;
			expect(KNOWN_PREFIXES.some((prefix) => key.startsWith(`${prefix}-`))).toBe(true);
		}
	});

	it("handles empty rubric selections (no checkbox keys emitted)", async () => {
		const output = await generateKarlJson(makeOptions());

		const checkedKeys = Object.entries(output).filter(([, value]) => value === "checked");
		expect(checkedKeys).toHaveLength(0);
		// 5 sliders + evaluation-textbox only.
		expect(Object.keys(output)).toHaveLength(6);
	});

	it("omits textareas for categories without notes", async () => {
		const output = await generateKarlJson(
			makeOptions({
				additionalNotes: {
					code_formatting: "Imports follow stdlib→third-party convention.",
				},
			}),
		);

		expect(output["codeFormatting-textarea"]).toBe(
			"Imports follow stdlib→third-party convention.",
		);
		expect(output["general-textarea"]).toBeUndefined();
		expect(output["Pandas-textarea"]).toBeUndefined();
	});

	it("throws when a rubric selection cannot be matched to the criteria YAML", async () => {
		await expect(
			generateKarlJson(
				makeOptions({
					rubricSelections: [
						{ categoryKey: "code_formatting", optionKey: "made up option" },
					],
				}),
			),
		).rejects.toThrow(/not found in category "code_formatting"/);

		await expect(
			generateKarlJson(
				makeOptions({
					rubricSelections: [{ categoryKey: "no_such_category", optionKey: "x" }],
				}),
			),
		).rejects.toThrow(/unknown category "no_such_category"/);
	});
});

describe("findSentimentAndMainPoint", () => {
	it("locates the sentiment and main point of a sub-point text", async () => {
		const match = await findSentimentAndMainPoint(
			[CRITERIA_FILE],
			"code_formatting",
			"imports - libraries were alphabetized",
		);
		expect(match).toEqual({
			sentiment: "positive",
			mainPoint: "Formatting is done well, which includes",
		});
	});

	it("returns null for unknown sub-points or categories", async () => {
		expect(
			await findSentimentAndMainPoint([CRITERIA_FILE], "code_formatting", "no such option"),
		).toBeNull();
		expect(
			await findSentimentAndMainPoint([CRITERIA_FILE], "no_such_category", "x"),
		).toBeNull();
	});
});
