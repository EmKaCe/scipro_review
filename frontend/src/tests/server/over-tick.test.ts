// @vitest-environment node
/**
 * @file Over-tick guard (review-diff workflow, signed off 2026-08-18) —
 * flag logic with synthetic norms.
 *
 * Covers the three signals:
 *   Signal A — global count flag: total > max(median*1.5, median+10).
 *   Signal B — per-category flag: count > category_median + 3 (the useful
 *     one; drives the dashboard badge and the review-page extras panel).
 *   Signal C — overlap warning: total within ±10 of the median but < 60%
 *     of the pipeline's items appear in the cohort's typical-review set.
 *
 * Also covers the pipeline→norm category-key mapping, the stored-envelope
 * accessor (postProcessed preferred over raw preEval), and norm loading
 * from DATA_DIR (absent file → null; corrupt YAML → throw).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { StoredExecutionResult } from "$lib/server/results-store";
import {
	computeOverTick,
	loadCohortNorms,
	overTickFromStored,
	type CohortNorms,
} from "$lib/server/copilot/over-tick";

// ---------------------------------------------------------------------------
// Synthetic norms (mirror the committed soil_contamination shape)
// ---------------------------------------------------------------------------

const NORMS: CohortNorms = {
	assignment: "soil_contamination",
	submissions: 19,
	global: {
		min: 35,
		max: 67,
		mean: 55.5,
		median: 56,
		distribution: [35, 43, 44, 46, 50, 52, 53, 54, 55, 56, 58, 59, 60, 61, 64, 65, 66, 66, 67],
	},
	categories: {
		plotting: { median: 12, max: 14 },
		codeFormatting: { median: 9, max: 11 },
		userDefinedFunctions: { median: 6, max: 7 },
		codingConcept: { median: 3, max: 4 },
	},
	typical_checked: {
		plotting: ["axis labels", "legend", "title"],
		codeFormatting: ["f-string - properly used", "indentation - consistent and done with 4 spaces"],
	},
};

/** One pipeline selection entry. */
function sel(categoryKey: string, optionKey: string) {
	return { categoryKey, optionKey };
}

// ---------------------------------------------------------------------------
// Signal A — global count flag
// ---------------------------------------------------------------------------

describe("over-tick Signal A (global count)", () => {
	it("flags a total above max(median*1.5, median+10)", () => {
		// median 56 → threshold max(84, 66) = 84.
		const selections = Array.from({ length: 85 }, (_, i) =>
			sel("plotting_visualization", `item ${i}`),
		);
		const result = computeOverTick(selections, NORMS);
		expect(result.totalFlagged).toBe(true);
		expect(result.total).toBe(85);
	});

	it("does not flag a total at or below the threshold", () => {
		const selections = Array.from({ length: 84 }, (_, i) =>
			sel("plotting_visualization", `item ${i}`),
		);
		expect(computeOverTick(selections, NORMS).totalFlagged).toBe(false);
	});

	it("does not flag a normal total (e.g. 58)", () => {
		const selections = Array.from({ length: 58 }, (_, i) =>
			sel("plotting_visualization", `item ${i}`),
		);
		const result = computeOverTick(selections, NORMS);
		expect(result.totalFlagged).toBe(false);
		expect(result.median).toBe(56);
	});
});

// ---------------------------------------------------------------------------
// Signal B — per-category flag
// ---------------------------------------------------------------------------

describe("over-tick Signal B (per-category)", () => {
	it("flags a category whose count exceeds median + 3", () => {
		// plotting median 12 → threshold 15; 16 checked = the spec's example.
		const selections = [
			...Array.from({ length: 16 }, (_, i) => sel("plotting_visualization", `plot ${i}`)),
			sel("code_formatting", "f-string - properly used"),
		];
		const result = computeOverTick(selections, NORMS);
		expect(result.overTickCategories).toHaveLength(1);
		const cat = result.overTickCategories[0]!;
		expect(cat.categoryKey).toBe("plotting_visualization");
		expect(cat.count).toBe(16);
		expect(cat.median).toBe(12);
		expect(cat.threshold).toBe(15);
		expect(cat.items).toHaveLength(16);
	});

	it("does not flag a category at or below median + 3", () => {
		const selections = Array.from({ length: 15 }, (_, i) =>
			sel("plotting_visualization", `plot ${i}`),
		);
		expect(computeOverTick(selections, NORMS).overTickCategories).toHaveLength(0);
	});

	it("flags multiple categories and sorts by count descending", () => {
		const selections = [
			...Array.from({ length: 10 }, (_, i) => sel("user_defined_functions", `fn ${i}`)), // median 6 → 10 > 9
			...Array.from({ length: 7 }, (_, i) => sel("coding_concept", `cc ${i}`)), // median 3 → 7 > 6
		];
		const result = computeOverTick(selections, NORMS);
		expect(result.overTickCategories.map((c) => c.categoryKey)).toEqual([
			"user_defined_functions",
			"coding_concept",
		]);
	});

	it("never flags a category without a norm entry (e.g. genai)", () => {
		const selections = Array.from({ length: 50 }, (_, i) => sel("genai", `g ${i}`));
		expect(computeOverTick(selections, NORMS).overTickCategories).toHaveLength(0);
	});

	it("carries the exact pipeline-checked item texts for the extras panel", () => {
		const selections = [
			sel("plotting_visualization", "axis labels"),
			sel("plotting_visualization", "legend"),
			sel("plotting_visualization", "title"),
			sel("plotting_visualization", "extra detail padding"),
			sel("plotting_visualization", "another padding item"),
			sel("plotting_visualization", "sixth"),
			sel("plotting_visualization", "seventh"),
			sel("plotting_visualization", "eighth"),
			sel("plotting_visualization", "ninth"),
			sel("plotting_visualization", "tenth"),
			sel("plotting_visualization", "eleventh"),
			sel("plotting_visualization", "twelfth"),
			sel("plotting_visualization", "thirteenth"),
			sel("plotting_visualization", "fourteenth"),
			sel("plotting_visualization", "fifteenth"),
			sel("plotting_visualization", "sixteenth"),
		];
		const result = computeOverTick(selections, NORMS);
		expect(result.overTickCategories[0]!.items).toContain("extra detail padding");
		expect(result.overTickCategories[0]!.items).toHaveLength(16);
	});
});

// ---------------------------------------------------------------------------
// Signal C — overlap warning
// ---------------------------------------------------------------------------

describe("over-tick Signal C (overlap warning)", () => {
	it("shows the note when the total is within ±10 of the median but overlap < 60%", () => {
		// total 58 (within 46..66), 2 of 58 in the typical set → 3.4%.
		const selections = [
			sel("plotting_visualization", "axis labels"), // typical
			sel("plotting_visualization", "legend"), // typical
			sel("plotting_visualization", "padding one"),
			sel("plotting_visualization", "padding two"),
			sel("plotting_visualization", "padding three"),
			...Array.from({ length: 53 }, (_, i) => sel("code_formatting", `filler ${i}`)),
		];
		const result = computeOverTick(selections, NORMS);
		expect(result.total).toBe(58);
		expect(result.overlapNote).toMatch(/count looks normal, but 56 of 58 items differ/);
	});

	it("omits the note when overlap is ≥ 60%", () => {
		// total 58, 35 of 58 in the typical set → 60.3% (not < 60%).
		// Duplicate selections count: overlap iterates every selection.
		const typicalTexts = [
			"axis labels",
			"legend",
			"title",
			"f-string - properly used",
			"indentation - consistent and done with 4 spaces",
		];
		const selections = [
			...Array.from({ length: 35 }, (_, i) =>
				sel("plotting_visualization", typicalTexts[i % typicalTexts.length]!),
			),
			...Array.from({ length: 23 }, (_, i) => sel("code_formatting", `filler ${i}`)),
		];
		expect(computeOverTick(selections, NORMS).overlapNote).toBeUndefined();
	});

	it("omits the note when the total is outside the ±10 band", () => {
		// total 30 — far below the median band.
		const selections = Array.from({ length: 30 }, (_, i) =>
			sel("plotting_visualization", `item ${i}`),
		);
		expect(computeOverTick(selections, NORMS).overlapNote).toBeUndefined();
	});

	it("omits the note for an empty selection", () => {
		expect(computeOverTick([], NORMS).overlapNote).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Stored-envelope accessor
// ---------------------------------------------------------------------------

describe("overTickFromStored", () => {
	it("prefers postProcessed rubricSelections over the raw preEval", () => {
		const stored = {
			preEval: {
				rubricSelections: [
					sel("plotting_visualization", "raw item"),
					sel("plotting_visualization", "raw item 2"),
					sel("plotting_visualization", "raw item 3"),
					sel("plotting_visualization", "raw item 4"),
					sel("plotting_visualization", "raw item 5"),
					sel("plotting_visualization", "raw item 6"),
					sel("plotting_visualization", "raw item 7"),
					sel("plotting_visualization", "raw item 8"),
					sel("plotting_visualization", "raw item 9"),
					sel("plotting_visualization", "raw item 10"),
					sel("plotting_visualization", "raw item 11"),
					sel("plotting_visualization", "raw item 12"),
					sel("plotting_visualization", "raw item 13"),
					sel("plotting_visualization", "raw item 14"),
					sel("plotting_visualization", "raw item 15"),
					sel("plotting_visualization", "raw item 16"),
				],
			},
			postProcessed: {
				rubricSelections: [
					sel("plotting_visualization", "corrected item"),
					sel("plotting_visualization", "corrected item 2"),
					sel("plotting_visualization", "corrected item 3"),
					sel("plotting_visualization", "corrected item 4"),
					sel("plotting_visualization", "corrected item 5"),
					sel("plotting_visualization", "corrected item 6"),
					sel("plotting_visualization", "corrected item 7"),
					sel("plotting_visualization", "corrected item 8"),
					sel("plotting_visualization", "corrected item 9"),
					sel("plotting_visualization", "corrected item 10"),
					sel("plotting_visualization", "corrected item 11"),
					sel("plotting_visualization", "corrected item 12"),
					sel("plotting_visualization", "corrected item 13"),
					sel("plotting_visualization", "corrected item 14"),
					sel("plotting_visualization", "corrected item 15"),
					sel("plotting_visualization", "corrected item 16"),
				],
			},
		} as unknown as StoredExecutionResult;
		const result = overTickFromStored(stored, NORMS)!;
		expect(result.overTickCategories[0]!.items[0]).toBe("corrected item");
	});

	it("falls back to the raw preEval envelope when postProcessed is absent", () => {
		const stored = {
			preEval: {
				rubricSelections: [
					sel("plotting_visualization", "raw item"),
					sel("plotting_visualization", "raw item 2"),
					sel("plotting_visualization", "raw item 3"),
					sel("plotting_visualization", "raw item 4"),
					sel("plotting_visualization", "raw item 5"),
					sel("plotting_visualization", "raw item 6"),
					sel("plotting_visualization", "raw item 7"),
					sel("plotting_visualization", "raw item 8"),
					sel("plotting_visualization", "raw item 9"),
					sel("plotting_visualization", "raw item 10"),
					sel("plotting_visualization", "raw item 11"),
					sel("plotting_visualization", "raw item 12"),
					sel("plotting_visualization", "raw item 13"),
					sel("plotting_visualization", "raw item 14"),
					sel("plotting_visualization", "raw item 15"),
					sel("plotting_visualization", "raw item 16"),
				],
			},
		} as unknown as StoredExecutionResult;
		const result = overTickFromStored(stored, NORMS)!;
		expect(result.overTickCategories[0]!.items[0]).toBe("raw item");
	});

	it("returns null when the submission carries no rubric selections", () => {
		expect(overTickFromStored({} as StoredExecutionResult, NORMS)).toBeNull();
		expect(overTickFromStored(null, NORMS)).toBeNull();
		expect(overTickFromStored(undefined, NORMS)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Norm loading from DATA_DIR
// ---------------------------------------------------------------------------

describe("loadCohortNorms", () => {
	let dataDir: string;

	beforeEach(async () => {
		dataDir = await mkdtemp(path.join(os.tmpdir(), "scipro-overtick-"));
		process.env.DATA_DIR = dataDir;
	});

	afterEach(async () => {
		delete process.env.DATA_DIR;
		await rm(dataDir, { recursive: true, force: true });
	});

	it("loads a committed norms file", async () => {
		await mkdir(path.join(dataDir, "cohort_norms"), { recursive: true });
		await writeFile(
			path.join(dataDir, "cohort_norms", "soil_contamination.yaml"),
			[
				"assignment: soil_contamination",
				"submissions: 19",
				"global:",
				"  min: 35",
				"  max: 67",
				"  mean: 55.5",
				"  median: 56",
				"  distribution: [35, 43, 44, 46, 50, 52, 53, 54, 55, 56, 58, 59, 60, 61, 64, 65, 66, 66, 67]",
				"categories:",
				"  plotting:",
				"    median: 12",
				"    max: 14",
				"typical_checked:",
				"  plotting:",
				'    - "axis labels"',
			].join("\n"),
		);
		const norms = await loadCohortNorms("soil_contamination");
		expect(norms).not.toBeNull();
		expect(norms!.global.median).toBe(56);
		expect(norms!.categories.plotting.median).toBe(12);
		expect(norms!.typical_checked.plotting).toEqual(["axis labels"]);
	});

	it("returns null when no norm is committed for the assignment", async () => {
		expect(await loadCohortNorms("soil_contamination")).toBeNull();
	});

	it("throws on a corrupt norms file", async () => {
		await mkdir(path.join(dataDir, "cohort_norms"), { recursive: true });
		await writeFile(
			path.join(dataDir, "cohort_norms", "soil_contamination.yaml"),
			"not: [valid: yaml",
		);
		await expect(loadCohortNorms("soil_contamination")).rejects.toThrow();
	});
});
