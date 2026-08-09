/**
 * @file Unit tests for apply-suggestion.ts — the pure copilot suggestion
 * apply helper (Phase 4e).
 *
 * Covers the four documented behaviors: grade suggestions merge dimension
 * scores with clamping and preserve unmentioned dimensions; feedbackDraft
 * fills notesDraft only when it is empty; draft suggestions set notes only
 * when empty; unknown kinds leave the state object untouched (same
 * reference). Pure — no Svelte environment involved.
 */

import { describe, expect, it } from "vitest";
import { SvelteSet } from "svelte/reactivity";
import { applySuggestionToState, type ApplySuggestionState } from "$lib/utils/apply-suggestion.js";
import type { CopilotSuggestion } from "$lib/components/submissions/copilot-store.svelte.js";

/** Minimal `grade` suggestion carrying a PreEvaluation-like envelope. */
function gradeSuggestion(data: unknown): CopilotSuggestion {
	return {
		suggestionId: "s-grade",
		kind: "grade",
		title: "Suggested grade",
		body: "Based on the notebook analysis.",
		actionLabel: "Apply scores",
		data,
	};
}

/** Minimal `draft` suggestion carrying `{ notes }`. */
function draftSuggestion(notes: string): CopilotSuggestion {
	return {
		suggestionId: "s-draft",
		kind: "draft",
		title: "Feedback draft",
		body: "Draft feedback text.",
		actionLabel: "Apply draft",
		data: { notes },
	};
}

const preEvalData = {
	markers: null,
	gradeSuggestion: {
		dimensions: {
			code_quality_design: 4,
			code_execution_results: 5.5,
			assignment_requirements: -3,
			scientific_programming: 9999,
		},
		justification: "Solid work overall.",
	},
	feedbackDraft: "Great submission — keep it up.",
	notebookSummary: "A notebook about soil contamination.",
	evaluatedAt: "2026-08-08T00:00:00.000Z",
};

describe("applySuggestionToState — grade kind", () => {
	it("merges suggested dimensions, clamps out-of-range values, and preserves unmentioned ones", () => {
		const state: ApplySuggestionState = {
			gradingInputs: {
				code_quality_design: 1,
				creativity: 2.5,
			},
			notesDraft: "",
		};

		const next = applySuggestionToState(gradeSuggestion(preEvalData), state);

		expect(next).not.toBe(state);
		// Mentioned dimensions take the suggested value (clamped).
		expect(next.gradingInputs.code_quality_design).toBe(4);
		expect(next.gradingInputs.code_execution_results).toBe(5.5);
		// Out-of-range suggestions are clamped to [0, 1000].
		expect(next.gradingInputs.assignment_requirements).toBe(0);
		expect(next.gradingInputs.scientific_programming).toBe(1000);
		// Unmentioned dimensions keep their existing value.
		expect(next.gradingInputs.creativity).toBe(2.5);
		// The input state was not mutated.
		expect(state.gradingInputs.code_quality_design).toBe(1);
	});

	it("fills notesDraft from feedbackDraft when notesDraft is empty", () => {
		const state: ApplySuggestionState = { gradingInputs: {}, notesDraft: "" };

		const next = applySuggestionToState(gradeSuggestion(preEvalData), state);

		expect(next.notesDraft).toBe("Great submission — keep it up.");
	});

	it("never clobbers teacher-written notes", () => {
		const state: ApplySuggestionState = {
			gradingInputs: {},
			notesDraft: "My own notes — do not overwrite.",
		};

		const next = applySuggestionToState(gradeSuggestion(preEvalData), state);

		expect(next.notesDraft).toBe("My own notes — do not overwrite.");
		// Dimensions still merge even when the notes stay put.
		expect(next.gradingInputs.code_quality_design).toBe(4);
	});

	it("skips non-finite suggested values instead of writing NaN into state", () => {
		const state: ApplySuggestionState = {
			gradingInputs: { creativity: 2 },
			notesDraft: "",
		};
		const suggestion = gradeSuggestion({
			...preEvalData,
			gradeSuggestion: {
				dimensions: {
					creativity: Number.NaN,
					code_quality_design: Number.POSITIVE_INFINITY,
				},
			},
		});

		const next = applySuggestionToState(suggestion, state);

		expect(next.gradingInputs.creativity).toBe(2);
		expect(next.gradingInputs.code_quality_design).toBeUndefined();
	});

	it("returns a fresh state object even when the payload has no dimensions", () => {
		const state: ApplySuggestionState = { gradingInputs: { creativity: 3 }, notesDraft: "" };

		const next = applySuggestionToState(
			gradeSuggestion({ markers: null, gradeSuggestion: {}, feedbackDraft: "" }),
			state,
		);

		expect(next).not.toBe(state);
		expect(next.gradingInputs).toEqual({ creativity: 3 });
	});
});

describe("applySuggestionToState — draft kind", () => {
	it("sets notesDraft from data.notes when notesDraft is empty", () => {
		const state: ApplySuggestionState = { gradingInputs: {}, notesDraft: "" };

		const next = applySuggestionToState(
			draftSuggestion("Draft feedback for the student."),
			state,
		);

		expect(next.notesDraft).toBe("Draft feedback for the student.");
		expect(next.gradingInputs).toEqual({});
	});

	it("keeps teacher-written notes when notesDraft is non-empty", () => {
		const state: ApplySuggestionState = {
			gradingInputs: { creativity: 1 },
			notesDraft: "Existing notes.",
		};

		const next = applySuggestionToState(
			draftSuggestion("Draft feedback for the student."),
			state,
		);

		expect(next.notesDraft).toBe("Existing notes.");
		expect(next.gradingInputs).toEqual({ creativity: 1 });
	});
});

describe("applySuggestionToState — unknown kinds", () => {
	it("returns the state object unchanged for fix/export kinds", () => {
		const state: ApplySuggestionState = {
			gradingInputs: { creativity: 4 },
			notesDraft: "notes",
		};
		const fixSuggestion: CopilotSuggestion = {
			suggestionId: "s-fix",
			kind: "fix",
			title: "Fix",
			body: "",
			actionLabel: "Apply",
		};

		// Same reference — nothing was touched.
		expect(applySuggestionToState(fixSuggestion, state)).toBe(state);
		expect(state.gradingInputs).toEqual({ creativity: 4 });
		expect(state.notesDraft).toBe("notes");
	});
});

describe("applySuggestionToState — rubric selections", () => {
	it("merges rubricSelections into existing and new category selections without mutating the input", () => {
		const state: ApplySuggestionState = {
			gradingInputs: {},
			notesDraft: "",
			categorySelections: {
				code_quality: {
					checked_items: new SvelteSet(["already_checked"]),
					notes: "",
					comments: {},
					deductions: {},
				},
			},
		};

		const next = applySuggestionToState(
			gradeSuggestion({
				...preEvalData,
				rubricSelections: [
					{ categoryKey: "code_quality", optionKey: "already_checked" },
					{ categoryKey: "code_quality", optionKey: "new_item" },
					{ categoryKey: "missing_category", optionKey: "created_item" },
				],
			}),
			state,
		);

		expect(next.categorySelections).toBeDefined();
		// Existing category keeps its items and gains the new one (no dupes).
		expect(next.categorySelections!.code_quality.checked_items.has("already_checked")).toBe(
			true,
		);
		expect(next.categorySelections!.code_quality.checked_items.has("new_item")).toBe(true);
		// A category the suggestion named that did not exist yet is created.
		expect(next.categorySelections!.missing_category.checked_items.has("created_item")).toBe(
			true,
		);
		expect(next.categorySelections!.missing_category.notes).toBe("");
		// The input record was not mutated.
		expect(state.categorySelections!.code_quality.checked_items.has("new_item")).toBe(false);
		expect(state.categorySelections!.missing_category).toBeUndefined();
		// Dimensions still merge alongside the rubric selections.
		expect(next.gradingInputs.code_quality_design).toBe(4);
	});

	it("keeps the selections record reference when the suggestion carries no rubric data", () => {
		const state: ApplySuggestionState = {
			gradingInputs: {},
			notesDraft: "",
			categorySelections: {
				code_quality: {
					checked_items: new SvelteSet(["x"]),
					notes: "",
					comments: {},
					deductions: {},
				},
			},
		};

		const next = applySuggestionToState(gradeSuggestion(preEvalData), state);

		expect(next.categorySelections).toBe(state.categorySelections);
	});

	it("skips malformed rubric items instead of writing junk into state", () => {
		const state: ApplySuggestionState = {
			gradingInputs: {},
			notesDraft: "",
			categorySelections: {},
		};

		const next = applySuggestionToState(
			gradeSuggestion({
				...preEvalData,
				rubricSelections: [
					null,
					{ categoryKey: "only_key" },
					{ categoryKey: "", optionKey: "" },
					{ categoryKey: "cat", optionKey: "ok" },
				],
			}),
			state,
		);

		expect(next.categorySelections).toBeDefined();
		expect(next.categorySelections!.cat.checked_items.has("ok")).toBe(true);
		expect(Object.keys(next.categorySelections!)).toEqual(["cat"]);
	});
});
