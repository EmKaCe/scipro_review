/**
 * @file Unit tests for the pre-evaluation worksheet module
 * ($lib/server/copilot/worksheet).
 *
 * Uses the real rubric fixture (CRITERIA_YAML from pre-evaluation.test.ts,
 * copied verbatim) extended with a second category (coding_concept) so the
 * cross-category fallback and per-category notes paths are exercised. The
 * MergedRubric is constructed manually from the YAML — no DATA_DIR needed.
 */

import { describe, expect, it } from "vitest";
import * as yaml from "js-yaml";

import {
	generateWorksheet,
	parseWorksheet,
	parseWorksheetSection,
	sentimentOfOption,
	validateWorksheetSection,
	type WorksheetContext,
} from "$lib/server/copilot/worksheet";
import type { Category, MergedRubric } from "$lib/types/criteria";
import { parseCategoryKey } from "$lib/types/criteria";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Mirrors the CRITERIA_YAML fixture from pre-evaluation.test.ts (verbatim)
 * plus a second category (coding_concept) with positive/neutral/negative
 * sub-points — needed to exercise the cross-category fallback and
 * per-category additional notes.
 */
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
          - text: imports - libraries were alphabetized
          - text: blank lines - consistent and good usage
    neutral: []
    negative:
      - main_point: Formatting issues
        sub_points:
          - text: Inconsistent indentation
            comment: false
            point_deduction: false
          - text: imports - not alphabetized
          - text: blank lines - not enough used (e.g., separating ideas and improving readability)
          - text: blank lines - too many used (i.e., not concise)
  coding_concept:
    title: Coding Concept
    additional_notes: true
    positive:
      - main_point: Concepts understood
        sub_points:
          - text: Correct use of loops
          - text: Correct use of functions
          - text: set
          - text: tuple
          - text: looping - 'zip' usage to iterate over two lists
    neutral:
      - main_point: Minor remarks
        sub_points:
          - text: Could simplify conditionals
    negative:
      - main_point: Concept issues
        sub_points:
          - text: Missing boundary checks
          - text: using 'set' - unique elements
          - text: using 'tuple' - immutable elements
          - text: looping - use 'zip' to loop over two lists of equal length
  jupyter_notebooks:
    title: Jupyter Notebooks
    additional_notes: true
    positive:
      - main_point: Notebook is done well
        sub_points:
          - text: cell structure - good usage to separate ideas (e.g., thoughts, tasks/subtasks, user-defined functions)
          - text: code cells - good separation of encode ideas
          - text: markdown cells - good usage to communicate ideas, thoughts or workflow
    neutral:
      - main_point: Notebook could be slightly improved
        sub_points:
          - text: cell structure - some additional separation of ideas (both code and markdown cells)
          - text: markdown cells - some additional communication would have been more informative
    negative:
      - main_point: Notebook was poorly done
        sub_points:
          - text: cell structure - separatation of the tasks, subtasks, or ideas needs to be better
          - text: markdown cells - are not used, or there is a significant lack of good, informative communication
  academic_scholarship:
    title: Academic Scholarship (Citations and Writing)
    additional_notes: true
    positive:
      - main_point: Scholarship done well
        sub_points:
          - text: citing - source of information and knowledge
          - text: citing - proper ordering within the written text (e.g., ...[1-2]...[3] and not ...[3-4]...[1]...)
          - text: units - input and output numbers have units (e.g., N, kJ, m/s, Hz)
          - text: sentences - clear, concise and provides good context (i.e., C^3)
          - text: sentences - complete written when appropriate (e.g., within markdown cells, docstrings)
    neutral: []
    negative:
      - main_point: Scholarship done poorly
        sub_points:
          - text: citing - missing references for knowledge (e.g., datasets, equations, libraries)
          - text: citing - done out-of-order (e.g., the first citation in your text is not to Reference 1)
          - text: units - were not provided when needed
          - text: sentences - not clean, concise and/or context provided (C^3)
          - text: sentences - incomplete sentences (e.g., capitalization, subject, verb) when needed (including in f-strings)
`;

/** Build the MergedRubric from the fixture YAML (same shape as loadCriteriaForAssignment). */
function makeRubric(): MergedRubric {
	const parsed = yaml.load(CRITERIA_YAML) as { categories: Record<string, Category> };
	return {
		categories: Object.entries(parsed.categories).map(([key, category]) => ({
			key: parseCategoryKey(key),
			category,
		})),
	};
}

const RUBRIC = makeRubric();

function makeContext(overrides: Partial<WorksheetContext> = {}): WorksheetContext {
	return {
		submissionId: "2026SS_38",
		assignmentId: "soil_contamination",
		cellCount: 5,
		codeCellCount: 3,
		markdownCellCount: 2,
		preAnalysisSummary: "2 issue(s) found: Non-descriptive variable names detected; Unused imports detected",
		markerCounts: { same: 1, different: 2, questionable: 0 },
		dimensionScores: { code_quality_design: 5, code_execution_results: 4 },
		rubric: RUBRIC,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// generateWorksheet
// ---------------------------------------------------------------------------

describe("generateWorksheet", () => {
	it("produces markdown with the worksheet header and all categories present", () => {
		const md = generateWorksheet(makeContext());

		expect(md).toContain("# Pre-Evaluation Worksheet: 2026SS_38");
		expect(md).toContain("## Rubric: code_formatting — Code Formatting");
		expect(md).toContain("## Rubric: coding_concept — Coding Concept");
		expect(md).toContain("## Rubric: jupyter_notebooks — Jupyter Notebooks");
		expect(md).toContain("## Rubric: academic_scholarship — Academic Scholarship (Citations and Writing)");
	});

	it("includes every sub-point from every category as an unchecked checkbox", () => {
		const md = generateWorksheet(makeContext());

		for (const entry of RUBRIC.categories) {
			for (const sentiment of ["positive", "neutral", "negative"] as const) {
				for (const mp of entry.category[sentiment]) {
					for (const sp of mp.sub_points) {
						expect(md).toContain(`- [ ] ${sp.text}`);
					}
				}
			}
		}

		// Everything starts unchecked, and no fabricated boxes are emitted.
		expect(md).not.toContain("[x]");
		expect(md).not.toContain("[X]");
	});

	it("emits the Neutral heading only for categories that have neutral sub-points", () => {
		const md = generateWorksheet(makeContext());

		// coding_concept and jupyter_notebooks have neutral sub-points;
		// code_formatting and academic_scholarship have none.
		expect(md).toMatch(/### Neutral\n- \[ \] Could simplify conditionals/);
		expect(md.match(/### Neutral/g)).toHaveLength(2);

		// Every category gets an Additional Notes slot with the placeholder.
		expect(md.match(/### Additional Notes/g)).toHaveLength(4);
		expect(md.split("_(to be filled)_").length - 1).toBe(4);
	});

	it("includes the Context section with cell counts and pre-analysis", () => {
		const md = generateWorksheet(makeContext());

		expect(md).toContain("## Context");
		expect(md).toContain("- Assignment: soil_contamination");
		expect(md).toContain("- Cells: 5 (3 code, 2 markdown)");
		expect(md).toContain("- Pre-analysis: 2 issue(s) found: Non-descriptive variable names detected; Unused imports detected");
		expect(md).toContain("- Cell markers: 1 same, 2 different, 0 questionable");
		expect(md).toContain("- Dimension scores: code_quality_design: 5, code_execution_results: 4");
	});

	it("omits marker counts and dimension scores when they are unavailable", () => {
		const md = generateWorksheet(
			makeContext({ markerCounts: null, dimensionScores: undefined }),
		);

		expect(md).toContain("- Cell markers: none (pre-evaluation has not run)");
		expect(md).not.toContain("Dimension scores");
	});
});

// ---------------------------------------------------------------------------
// parseWorksheetSection
// ---------------------------------------------------------------------------

describe("parseWorksheetSection", () => {
	it("extracts checked [x] items and maps them to the rubric", () => {
		const section = [
			"### Positive",
			"",
			"- [x] Readable variable names",
			"",
			"### Negative",
			"",
			"- [ ] Inconsistent indentation",
		].join("\n");

		const result = parseWorksheetSection(section, "code_formatting", RUBRIC);

		expect(result.selections).toEqual([
			{ categoryKey: "code_formatting", optionKey: "Readable variable names" },
		]);
		expect(result.unmatched).toEqual([]);
		expect(result.notes).toBeNull();
	});

	it("accepts uppercase [X] and trims checkbox text", () => {
		const section = "### Negative\n\n- [X]   Inconsistent indentation  \n";

		const result = parseWorksheetSection(section, "code_formatting", RUBRIC);

		expect(result.selections).toEqual([
			{ categoryKey: "code_formatting", optionKey: "Inconsistent indentation" },
		]);
	});

	it("rejects fabricated text that does not exist in the rubric", () => {
		const section = "### Positive\n\n- [x] Invented criterion that does not exist\n";

		const result = parseWorksheetSection(section, "code_formatting", RUBRIC);

		expect(result.selections).toEqual([]);
		expect(result.unmatched).toEqual([
			{ categoryKey: "code_formatting", text: "Invented criterion that does not exist" },
		]);
	});

	it("falls back across categories when text sits under the wrong section", () => {
		// Correct use of loops is a coding_concept item placed under
		// code_formatting — the parser must still resolve it.
		const section = "### Positive\n\n- [x] Correct use of loops\n";

		const result = parseWorksheetSection(section, "code_formatting", RUBRIC);

		expect(result.selections).toEqual([
			{ categoryKey: "coding_concept", optionKey: "Correct use of loops" },
		]);
		expect(result.unmatched).toEqual([]);
	});

	it("extracts additional notes after the Additional Notes heading", () => {
		const section = [
			"### Positive",
			"",
			"- [x] Readable variable names",
			"",
			"### Additional Notes",
			"",
			"The student should rename `df` to something descriptive.",
			"",
			"Also mention the missing docstring.",
		].join("\n");

		const result = parseWorksheetSection(section, "code_formatting", RUBRIC);

		expect(result.notes).toBe(
			"The student should rename `df` to something descriptive.\n\nAlso mention the missing docstring.",
		);
		expect(result.selections).toHaveLength(1);
	});

	it("treats the unfilled placeholder as no notes", () => {
		const section = "### Additional Notes\n\n_(to be filled)_\n";

		const result = parseWorksheetSection(section, "code_formatting", RUBRIC);

		expect(result.notes).toBeNull();
	});

	it("stops notes and checkbox scanning at the next level-2 header", () => {
		const section = [
			"### Positive",
			"",
			"- [x] Readable variable names",
			"",
			"### Additional Notes",
			"",
			"Note that stops here.",
			"",
			"## Rubric: coding_concept — Coding Concept",
			"",
			"### Positive",
			"",
			"- [x] Correct use of loops",
		].join("\n");

		const result = parseWorksheetSection(section, "code_formatting", RUBRIC);

		expect(result.notes).toBe("Note that stops here.");
		// The trailing header (and its checkbox) belongs to the next section.
		expect(result.selections).toEqual([
			{ categoryKey: "code_formatting", optionKey: "Readable variable names" },
		]);
	});
});

// ---------------------------------------------------------------------------
// parseWorksheet
// ---------------------------------------------------------------------------

describe("parseWorksheet", () => {
	it("round-trips a filled worksheet end-to-end", () => {
		// Generate, then fill: check two boxes and replace each category's
		// notes placeholder with real notes.
		let md = generateWorksheet(makeContext());
		md = md.replace("- [ ] Readable variable names", "- [x] Readable variable names");
		md = md.replace("- [ ] Correct use of loops", "- [x] Correct use of loops");
		md = md.replace("_(to be filled)_", "Note for code formatting.");
		md = md.replace("_(to be filled)_", "Note for coding concept.");

		const result = parseWorksheet(md, RUBRIC);

		expect(result.rubricSelections).toEqual([
			{ categoryKey: "code_formatting", optionKey: "Readable variable names" },
			{ categoryKey: "coding_concept", optionKey: "Correct use of loops" },
		]);
		expect(result.additionalNotes).toEqual({
			code_formatting: "Note for code formatting.",
			coding_concept: "Note for coding concept.",
		});
		expect(result.unmatched).toEqual([]);
	});

	it("accumulates unmatched items from every section with their stated category", () => {
		let md = generateWorksheet(makeContext());
		md = md.replace("- [ ] Readable variable names", "- [x] Totally fabricated item A");
		md = md.replace("- [ ] Correct use of loops", "- [x] Totally fabricated item B");

		const result = parseWorksheet(md, RUBRIC);

		expect(result.rubricSelections).toEqual([]);
		expect(result.additionalNotes).toEqual({});
		expect(result.unmatched).toEqual([
			{ categoryKey: "code_formatting", text: "Totally fabricated item A" },
			{ categoryKey: "coding_concept", text: "Totally fabricated item B" },
		]);
	});

	it("keeps matched selections while surfacing unmatched ones", () => {
		let md = generateWorksheet(makeContext());
		md = md.replace("- [ ] Readable variable names", "- [x] Readable variable names");
		md = md.replace("- [ ] Correct use of loops", "- [x] Totally fabricated item");

		const result = parseWorksheet(md, RUBRIC);

		expect(result.rubricSelections).toEqual([
			{ categoryKey: "code_formatting", optionKey: "Readable variable names" },
		]);
		expect(result.unmatched).toEqual([
			{ categoryKey: "coding_concept", text: "Totally fabricated item" },
		]);
	});

	it("ignores the Context section and unknown rubric headers", () => {
		const md = [
			"# Pre-Evaluation Worksheet: 2026SS_38",
			"",
			"## Context",
			"",
			"- Assignment: soil_contamination",
			"- Cells: 5 (3 code, 2 markdown)",
			"",
			"## Rubric: code_formatting — Code Formatting",
			"",
			"### Positive",
			"",
			"- [x] Readable variable names",
			"",
			"## Rubric: totally_made_up — Not A Real Category",
			"",
			"### Positive",
			"",
			"- [x] Some text",
		].join("\n");

		const result = parseWorksheet(md, RUBRIC);

		// The context block contributed nothing; the unknown category's
		// section is skipped (nothing to match against).
		expect(result.rubricSelections).toEqual([
			{ categoryKey: "code_formatting", optionKey: "Readable variable names" },
		]);
		expect(result.unmatched).toEqual([]);
		expect(result.additionalNotes).toEqual({});
	});
});

// ---------------------------------------------------------------------------
// validateWorksheetSection
// ---------------------------------------------------------------------------

describe("validateWorksheetSection", () => {
	it("accepts a clean section (header + checked item + notes)", () => {
		const section = [
			"## Rubric: code_formatting — Code Formatting",
			"",
			"### Positive",
			"",
			"- [x] Readable variable names",
			"",
			"### Additional Notes",
			"",
			"Names are descriptive throughout.",
		].join("\n");

		const result = validateWorksheetSection(section, "code_formatting", RUBRIC);

		expect(result.ok).toBe(true);
		expect(result.errors).toEqual([]);
		expect(result.selections).toEqual([
			{ categoryKey: "code_formatting", optionKey: "Readable variable names" },
		]);
		expect(result.notes).toBe("Names are descriptive throughout.");
	});

	it("flags a header that does not start with the expected category key", () => {
		const section = [
			"## Rubric: coding_concept — Coding Concept",
			"",
			"### Positive",
			"",
			"- [x] Readable variable names",
		].join("\n");

		const result = validateWorksheetSection(section, "code_formatting", RUBRIC);

		expect(result.ok).toBe(false);
		expect(result.errors.map((e) => e.type)).toEqual(["header_mismatch"]);
		expect(result.errors[0]!.message).toContain("## Rubric: code_formatting");
	});

	it("flags a section with no checked items and no notes as empty", () => {
		const section = [
			"## Rubric: code_formatting — Code Formatting",
			"",
			"### Positive",
			"",
			"- [ ] Readable variable names",
			"",
			"### Additional Notes",
			"",
			"_(to be filled)_",
		].join("\n");

		const result = validateWorksheetSection(section, "code_formatting", RUBRIC);

		expect(result.ok).toBe(false);
		expect(result.errors.map((e) => e.type)).toEqual(["empty"]);
	});

	it("does not flag a section that is empty of checks but has a real note", () => {
		const section = [
			"## Rubric: code_formatting — Code Formatting",
			"",
			"### Additional Notes",
			"",
			"Everything is fine; nothing to mark.",
		].join("\n");

		const result = validateWorksheetSection(section, "code_formatting", RUBRIC);

		expect(result.ok).toBe(true);
		expect(result.errors).toEqual([]);
		expect(result.selections).toEqual([]);
		expect(result.notes).toBe("Everything is fine; nothing to mark.");
	});

	it("flags checked text that matches no rubric sub-point anywhere", () => {
		const section = [
			"## Rubric: code_formatting — Code Formatting",
			"",
			"### Positive",
			"",
			"- [x] Invented criterion that does not exist",
		].join("\n");

		const result = validateWorksheetSection(section, "code_formatting", RUBRIC);

		expect(result.ok).toBe(false);
		expect(result.errors.map((e) => e.type)).toEqual(["unknown"]);
		expect(result.errors[0]!.items).toEqual(["Invented criterion that does not exist"]);
	});

	it("flags both sides of a mutual-exclusion pair being checked", () => {
		const section = [
			"## Rubric: code_formatting — Code Formatting",
			"",
			"### Positive",
			"",
			"- [x] imports - libraries were alphabetized",
			"",
			"### Negative",
			"",
			"- [x] imports - not alphabetized",
		].join("\n");

		const result = validateWorksheetSection(section, "code_formatting", RUBRIC);

		expect(result.ok).toBe(false);
		expect(result.errors.map((e) => e.type)).toEqual(["mutual_exclusion"]);
		expect(result.errors[0]!.items).toEqual([
			"imports - libraries were alphabetized",
			"imports - not alphabetized",
		]);
	});

	it("flags mutual-exclusion pairs for coding_concept", () => {
		const section = [
			"## Rubric: coding_concept — Coding Concept",
			"",
			"### Positive",
			"",
			"- [x] set",
			"",
			"### Negative",
			"",
			"- [x] using 'set' - unique elements",
		].join("\n");

		const result = validateWorksheetSection(section, "coding_concept", RUBRIC);

		expect(result.ok).toBe(false);
		expect(result.errors.map((e) => e.type)).toEqual(["mutual_exclusion"]);
		expect(result.errors[0]!.items).toEqual(["set", "using 'set' - unique elements"]);
	});

	it("flags mutual-exclusion pairs for jupyter_notebooks", () => {
		const section = [
			"## Rubric: jupyter_notebooks — Jupyter Notebooks",
			"",
			"### Positive",
			"",
			"- [x] cell structure - good usage to separate ideas (e.g., thoughts, tasks/subtasks, user-defined functions)",
			"",
			"### Negative",
			"",
			"- [x] cell structure - separatation of the tasks, subtasks, or ideas needs to be better",
		].join("\n");

		const result = validateWorksheetSection(section, "jupyter_notebooks", RUBRIC);

		expect(result.ok).toBe(false);
		expect(result.errors.map((e) => e.type)).toEqual(["mutual_exclusion"]);
		expect(result.errors[0]!.items).toEqual([
			"cell structure - good usage to separate ideas (e.g., thoughts, tasks/subtasks, user-defined functions)",
			"cell structure - separatation of the tasks, subtasks, or ideas needs to be better",
		]);
	});

	it("flags mutual-exclusion pairs for academic_scholarship", () => {
		const section = [
			"## Rubric: academic_scholarship — Academic Scholarship (Citations and Writing)",
			"",
			"### Positive",
			"",
			"- [x] units - input and output numbers have units (e.g., N, kJ, m/s, Hz)",
			"",
			"### Negative",
			"",
			"- [x] units - were not provided when needed",
		].join("\n");

		const result = validateWorksheetSection(section, "academic_scholarship", RUBRIC);

		expect(result.ok).toBe(false);
		expect(result.errors.map((e) => e.type)).toEqual(["mutual_exclusion"]);
		expect(result.errors[0]!.items).toEqual([
			"units - input and output numbers have units (e.g., N, kJ, m/s, Hz)",
			"units - were not provided when needed",
		]);
	});

	it("flags every negative blank-lines variant against the shared positive (multi-way)", () => {
		const section = [
			"## Rubric: code_formatting — Code Formatting",
			"",
			"### Positive",
			"",
			"- [x] blank lines - consistent and good usage",
			"",
			"### Negative",
			"",
			"- [x] blank lines - too many used (i.e., not concise)",
		].join("\n");

		const result = validateWorksheetSection(section, "code_formatting", RUBRIC);

		expect(result.ok).toBe(false);
		expect(result.errors.map((e) => e.type)).toEqual(["mutual_exclusion"]);
		expect(result.errors[0]!.items).toEqual([
			"blank lines - consistent and good usage",
			"blank lines - too many used (i.e., not concise)",
		]);
	});

	it("allows mixed positive + negative sentiment when the items are not a mutual-exclusion pair", () => {
		const section = [
			"## Rubric: code_formatting — Code Formatting",
			"",
			"### Positive",
			"",
			"- [x] imports - libraries were alphabetized",
			"",
			"### Negative",
			"",
			"- [x] Inconsistent indentation",
		].join("\n");

		const result = validateWorksheetSection(section, "code_formatting", RUBRIC);

		expect(result.ok).toBe(true);
		expect(result.errors).toEqual([]);
	});

	it("allows mixed sentiment in any category when no mutual-exclusion pair is co-checked", () => {
		const section = [
			"## Rubric: coding_concept — Coding Concept",
			"",
			"### Positive",
			"",
			"- [x] Correct use of loops",
			"",
			"### Negative",
			"",
			"- [x] Missing boundary checks",
		].join("\n");

		const result = validateWorksheetSection(section, "coding_concept", RUBRIC);

		expect(result.ok).toBe(true);
		expect(result.errors).toEqual([]);
	});

	it("does not flag neutral + one other sentiment as mixed", () => {
		const section = [
			"## Rubric: coding_concept — Coding Concept",
			"",
			"### Neutral",
			"",
			"- [x] Could simplify conditionals",
			"",
			"### Negative",
			"",
			"- [x] Missing boundary checks",
		].join("\n");

		const result = validateWorksheetSection(section, "coding_concept", RUBRIC);

		expect(result.ok).toBe(true);
		expect(result.errors).toEqual([]);
	});

	it("flags unknown items even when other checked items are valid", () => {
		const section = [
			"## Rubric: coding_concept — Coding Concept",
			"",
			"### Positive",
			"",
			"- [x] Correct use of loops",
			"",
			"### Negative",
			"",
			"- [x] Missing boundary checks",
			"- [x] Totally fabricated item",
		].join("\n");

		const result = validateWorksheetSection(section, "coding_concept", RUBRIC);

		expect(result.ok).toBe(false);
		expect(result.errors.map((e) => e.type)).toEqual(["unknown"]);
	});
});

// ---------------------------------------------------------------------------
// sentimentOfOption
// ---------------------------------------------------------------------------

describe("sentimentOfOption", () => {
	const codeFormatting = RUBRIC.categories.find((e) => e.key === "code_formatting")!.category;
	const codingConcept = RUBRIC.categories.find((e) => e.key === "coding_concept")!.category;

	it("classifies sub-points by sentiment", () => {
		expect(sentimentOfOption(codeFormatting, "Readable variable names")).toBe("positive");
		expect(sentimentOfOption(codeFormatting, "Inconsistent indentation")).toBe("negative");
		expect(sentimentOfOption(codingConcept, "Could simplify conditionals")).toBe("neutral");
	});

	it("returns null for text that is not a sub-point of the category", () => {
		expect(sentimentOfOption(codeFormatting, "Correct use of loops")).toBeNull();
		expect(sentimentOfOption(codeFormatting, "Totally fabricated item")).toBeNull();
	});
});
