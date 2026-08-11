/**
 * @file Unit tests for karl-catalog.ts — the category-key → Karl element-ID
 * prefix mapping and buildKarlId() helper.
 *
 * Karl's form rebuilds checkbox IDs at runtime from raw category/sentiment/
 * mainPoint/subPoint text (generate.js line 96), so the helper must preserve
 * text VERBATIM — including Karl's known typos and double spaces.
 */
import { describe, expect, it } from "vitest";

import { buildKarlId, KARL_CATEGORY_PREFIXES } from "$lib/server/criteria/karl-catalog";

describe("karl-catalog", () => {
	it("maps general_feedback to Karl's 'general' prefix", () => {
		const id = buildKarlId("general_feedback", "positive", "Overall", "good");
		expect(id.startsWith("general-")).toBe(true);
	});

	it("maps following_instructions to 'followingInstructions'", () => {
		const id = buildKarlId("following_instructions", "neutral", "main", "sub");
		expect(id.startsWith("followingInstructions-")).toBe(true);
	});

	it("preserves Karl's double space in the jupyterNotebooks negative mainPoint", () => {
		const id = buildKarlId(
			"jupyter_notebooks",
			"negative",
			"Notebook was poorly done,  which",
			"kept the tasks apart",
		);
		expect(id).toContain("poorly done,  which");
	});

	it("preserves Karl's 'separatation' typo", () => {
		const id = buildKarlId(
			"jupyter_notebooks",
			"negative",
			"separatation of the tasks",
			"was not clear",
		);
		expect(id).toContain("separatation");
	});

	it("maps code_formatting to 'codeFormatting'", () => {
		const id = buildKarlId("code_formatting", "positive", "PEP8", "followed");
		expect(id.startsWith("codeFormatting-")).toBe(true);
	});

	it("returns a string of the form prefix-sentiment-mainPoint-subPoint", () => {
		const id = buildKarlId("numpy", "positive", "used arrays", "efficiently");
		expect(id).toBe("NumPy-positive-used arrays-efficiently");
	});

	it("does NOT clean or normalize any text — raw strings pass through", () => {
		const mainPoint = "  Spaced   OUT  text, with punctuation!";
		const subPoint = "trailing space ";
		const id = buildKarlId("scipy", "neutral", mainPoint, subPoint);
		expect(id).toBe(`SciPy-neutral-${mainPoint}-${subPoint}`);
		expect(id).toContain("  Spaced   OUT  text, with punctuation!");
		expect(id.endsWith("trailing space ")).toBe(true);
	});

	it("produces valid non-empty IDs for all 14 category keys", () => {
		expect(Object.keys(KARL_CATEGORY_PREFIXES)).toHaveLength(14);
		for (const key of Object.keys(KARL_CATEGORY_PREFIXES)) {
			const id = buildKarlId(key, "positive", "main point", "sub point");
			expect(id).not.toBe("");
			expect(id.startsWith(`${KARL_CATEGORY_PREFIXES[key]}-`)).toBe(true);
		}
	});
});
