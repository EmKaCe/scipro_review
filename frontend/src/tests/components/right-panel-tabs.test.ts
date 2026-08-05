/**
 * @file L4 component test — rubric comment/deduction wiring.
 *
 * Renders right-panel-tabs with a one-category rubric through a bindable
 * harness, checks a sub-point, edits the comment and deduction fields, and
 * asserts the edits landed in `categorySelections` (the bindable prop).
 *
 * The TipTap notes editor is not driven here (hard in jsdom) — notes are
 * covered by the L1 round-trip tests in grading-persistence.test.ts.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";

import Harness from "./right-panel-tabs-harness.svelte";
import type { MergedRubric } from "$lib/types/criteria.js";
import type { CategorySelections } from "$lib/types/session.js";
import { categoryKeyOf } from "$lib/types/criteria.js";
import { defaultGradingInputs } from "$lib/types/grading.js";

// ---------------------------------------------------------------------------
// TipTap mocks (real ProseMirror does not run in jsdom)
// ---------------------------------------------------------------------------

vi.mock("@tiptap/core", () => ({
	Editor: vi.fn().mockImplementation(() => ({
		destroy: vi.fn(),
		setEditable: vi.fn(),
		setContent: vi.fn(),
		getHTML: vi.fn(() => "<p></p>"),
		commands: { setContent: vi.fn() },
	})),
}));

vi.mock("@tiptap/starter-kit", () => ({}));

vi.mock("@tiptap/extension-placeholder", () => ({
	default: { configure: vi.fn().mockReturnValue({}) },
}));

vi.mock("marked", () => ({
	marked: { parse: vi.fn((text: string) => `<p>${text}</p>`) },
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const rubric: MergedRubric = {
	categories: [
		{
			key: categoryKeyOf("code_formatting"),
			category: {
				title: "Code Formatting",
				additional_notes: true,
				positive: [
					{
						main_point: "Good formatting",
						sub_points: [
							{
								text: "consistent_indentation",
								comment: true,
								point_deduction: true,
							},
						],
					},
				],
				neutral: [],
				negative: [],
			},
		},
	],
};

/** Render the rubric tab with the one-category rubric and expand the category. */
async function renderExpandedRubric() {
	const result = render(Harness, {
		activeTab: "rubric",
		onTabChange: vi.fn(),
		dimensions: [],
		grading: defaultGradingInputs(),
		gradeResult: null,
		totalDeductions: 0,
		onUpdateDimension: vi.fn(),
		rubric,
		studentId: "2026SS_03",
		assignmentId: "soil_contamination",
	});

	const header = screen.getByText("Code Formatting").closest("button");
	expect(header).not.toBeNull();
	await fireEvent.click(header!);
	return result;
}

function readSelections(component: unknown): Record<string, CategorySelections> {
	return (component as { categorySelections: Record<string, CategorySelections> })
		.categorySelections;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("right-panel-tabs.svelte — rubric feedback wiring (A4)", () => {
	it("writes a typed comment into categorySelections keyed by sub-point text", async () => {
		const { component } = await renderExpandedRubric();

		// Check the sub-point so its comment/deduction fields appear.
		await fireEvent.click(screen.getByRole("checkbox"));
		await fireEvent.input(screen.getByLabelText("Comment for consistent_indentation"), {
			target: { value: "Great indentation" },
		});

		const selections = readSelections(component);
		expect(selections.code_formatting?.comments.consistent_indentation).toBe(
			"Great indentation",
		);
	});

	it("writes an entered deduction into categorySelections keyed by sub-point text", async () => {
		const { component } = await renderExpandedRubric();

		await fireEvent.click(screen.getByRole("checkbox"));
		await fireEvent.input(screen.getByLabelText("Deduction for consistent_indentation"), {
			target: { value: "1.5" },
		});

		const selections = readSelections(component);
		expect(selections.code_formatting?.deductions.consistent_indentation).toBe(1.5);
	});

	it("keeps an existing comment when the deduction field is edited (immutable merge)", async () => {
		const { component } = await renderExpandedRubric();

		await fireEvent.click(screen.getByRole("checkbox"));
		await fireEvent.input(screen.getByLabelText("Comment for consistent_indentation"), {
			target: { value: "Keep me" },
		});
		await fireEvent.input(screen.getByLabelText("Deduction for consistent_indentation"), {
			target: { value: "0.5" },
		});

		const selections = readSelections(component);
		expect(selections.code_formatting?.comments.consistent_indentation).toBe("Keep me");
		expect(selections.code_formatting?.deductions.consistent_indentation).toBe(0.5);
	});

	it("updates the tab-header sentiment count when a checkbox is toggled (P3-2 regression)", async () => {
		await renderExpandedRubric();

		// The positive item is in the fixture rubric; before any click the
		// count must be zero.
		expect(screen.getByText(/^Rubric/).closest("button")!.textContent).toContain("0");
		await fireEvent.click(screen.getByRole("checkbox"));

		// Live counts are computed on the page side (sentimentCounts prop)
		// from the bindable state — asserting the rendered header reflects the
		// click. Guards the Svelte 5 bindable/$derived staleness bug
		// (child-side assignments did not re-trigger a local
		// derived over the bindable prop).
		const header = screen.getByText(/^Rubric/).closest("button")!;
		expect(header.textContent).toContain("1");
	});
});
