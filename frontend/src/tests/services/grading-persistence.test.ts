/**
 * @file L1 unit tests for the grading persistence serialization helpers.
 *
 * Covers the lossless round-trip between live `CategorySelections` (Sets)
 * and the persisted v2 `CategoryFeedback` shape (arrays), plus the
 * category-key whitelist applied when restoring.
 */

import { describe, expect, it } from "vitest";

import { feedbackToSelections, selectionsToFeedback } from "$lib/services/grading-persistence.js";

describe("grading persistence serialization", () => {
	it("round-trips selections -> feedback -> selections losslessly", () => {
		const selections = {
			code_formatting: {
				checked_items: new Set(["blank lines - consistent", "naming - not descriptive"]),
				comments: { "naming - not descriptive": "rename df" },
				deductions: { "naming - not descriptive": 0.5 },
				notes: "<p>HTML from TipTap</p>",
			},
		};

		const feedback = selectionsToFeedback(selections);
		expect(feedback.code_formatting.checked).toEqual([
			"blank lines - consistent",
			"naming - not descriptive",
		]);

		const restored = feedbackToSelections(feedback, ["code_formatting"]);
		expect([...restored.code_formatting.checked_items]).toEqual([
			...selections.code_formatting.checked_items,
		]);
		expect(restored.code_formatting.comments).toEqual(selections.code_formatting.comments);
		expect(restored.code_formatting.deductions).toEqual(selections.code_formatting.deductions);
		expect(restored.code_formatting.notes).toBe(selections.code_formatting.notes);
	});

	it("drops unknown category keys on restore", () => {
		const restored = feedbackToSelections(
			{ ghost: { checked: ["x"], comments: {}, deductions: {}, notes: "" } },
			["known"],
		);
		expect(restored.ghost).toBeUndefined();
		// Known keys get empty defaults when absent from the feedback block.
		expect(restored.known).toEqual({
			checked_items: new Set(),
			comments: {},
			deductions: {},
			notes: "",
		});
	});
});
