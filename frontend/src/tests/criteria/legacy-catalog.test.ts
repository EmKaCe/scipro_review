/**
 * @file Unit tests for legacy-catalog.ts — the category-key → legacy element-ID
 * prefix mapping and buildLegacyId() helper.
 *
 * The legacy grading form rebuilds checkbox IDs at runtime from raw category/sentiment/
 * mainPoint/subPoint text (generate.js line 96), so the helper must preserve
 * text VERBATIM — including the legacy form's known typos and double spaces.
 */
import { describe, expect, it } from "vitest";

import { buildLegacyId, LEGACY_CATEGORY_PREFIXES } from "$lib/server/criteria/legacy-catalog";

describe("legacy-catalog", () => {
	it("maps general_feedback to the legacy 'general' prefix", () => {
		const id = buildLegacyId("general_feedback", "positive", "Overall", "good");
		expect(id.startsWith("general-")).toBe(true);
	});

	it("maps following_instructions to 'followingInstructions'", () => {
		const id = buildLegacyId("following_instructions", "neutral", "main", "sub");
		expect(id.startsWith("followingInstructions-")).toBe(true);
	});

	it("preserves legacy double space in the jupyterNotebooks negative mainPoint", () => {
		const id = buildLegacyId(
			"jupyter_notebooks",
			"negative",
			"Notebook was poorly done,  which",
			"kept the tasks apart",
		);
		expect(id).toContain("poorly done,  which");
	});

	it("preserves the 'separatation' typo", () => {
		const id = buildLegacyId(
			"jupyter_notebooks",
			"negative",
			"separatation of the tasks",
			"was not clear",
		);
		expect(id).toContain("separatation");
	});

	it("maps code_formatting to 'codeFormatting'", () => {
		const id = buildLegacyId("code_formatting", "positive", "PEP8", "followed");
		expect(id.startsWith("codeFormatting-")).toBe(true);
	});

	it("returns a string of the form prefix-sentiment-mainPoint-subPoint", () => {
		const id = buildLegacyId("numpy", "positive", "used arrays", "efficiently");
		expect(id).toBe("NumPy-positive-used arrays-efficiently");
	});

	it("does NOT clean or normalize any text — raw strings pass through", () => {
		const mainPoint = "  Spaced   OUT  text, with punctuation!";
		const subPoint = "trailing space ";
		const id = buildLegacyId("scipy", "neutral", mainPoint, subPoint);
		expect(id).toBe(`SciPy-neutral-${mainPoint}-${subPoint}`);
		expect(id).toContain("  Spaced   OUT  text, with punctuation!");
		expect(id.endsWith("trailing space ")).toBe(true);
	});

	it("produces valid non-empty IDs for all 14 category keys", () => {
		expect(Object.keys(LEGACY_CATEGORY_PREFIXES)).toHaveLength(14);
		for (const key of Object.keys(LEGACY_CATEGORY_PREFIXES)) {
			const id = buildLegacyId(key, "positive", "main point", "sub point");
			expect(id).not.toBe("");
			expect(id.startsWith(`${LEGACY_CATEGORY_PREFIXES[key]}-`)).toBe(true);
		}
	});
});
