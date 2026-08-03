/**
 * @file L4 page test — clean-state items (2026-08-03): real status chip,
 * top-level teacher notes editor, and Generate/Reset (original 3f.5).
 *
 * Renders the per-submission page with stores + heavy children mocked, then
 * asserts:
 *   - the header chip renders the REAL status label (no hardcoded "Executed");
 *   - the notes editor restores the persisted top-level notes and the header
 *     Save persists edits (GradingPatch.notes);
 *   - [Generate] compiles rubric + grading into editable evaluation text;
 *   - [Reset] clears selections + notes + sliders locally, and Save persists
 *     the cleared state.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";

import Page from "../../routes/submissions/[id]/+page.svelte";
import type { SubmissionDetail } from "$lib/types/submissions.js";
import type { MergedRubric } from "$lib/types/criteria.js";
import { categoryKeyOf } from "$lib/types/criteria.js";

// ---------------------------------------------------------------------------
// Mocks (same skeleton as submissions-import-page.test.ts)
// ---------------------------------------------------------------------------

vi.mock("$lib/services/submissions-store.js", () => ({
	submissionsStore: {
		select: vi.fn(),
		saveGrading: vi.fn(),
		export: vi.fn(),
		importTeacherYaml: vi.fn(),
	},
}));

vi.mock("$lib/services/plagiarism-store.svelte.js", () => ({
	plagiarismStore: {
		load: vi.fn().mockResolvedValue(null),
		unreviewedCount: vi.fn(() => 0),
		countByStatus: vi.fn(() => 0),
		ignoreAllUnreviewed: vi.fn().mockResolvedValue(undefined),
	},
}));

vi.mock("$lib/services/autofix-store.svelte.js", () => ({
	autofixStore: { reset: vi.fn() },
}));

vi.mock("$lib/stores/toast.svelte.js", () => ({
	addToast: vi.fn(),
}));

vi.mock("$lib/services/criteria-loader.js", () => ({
	getCriteriaForAssignment: vi.fn(),
}));

vi.mock("$app/state", () => ({
	page: { params: { id: "2026SS_03" } },
}));

vi.mock("$app/paths", () => ({ base: "" }));

// Heavy/leaf children — not the subject under test.
vi.mock("$lib/components/submissions/execution-output.svelte", () => ({
	default: () => {},
}));
vi.mock("$lib/components/submissions/reference-comparison.svelte", () => ({
	default: () => {},
}));
vi.mock("$lib/components/submissions/right-panel-tabs.svelte", () => ({
	default: () => {},
}));
vi.mock("$lib/components/ui/menu-button.svelte", () => ({ default: () => {} }));
vi.mock("$lib/components/ui/skeleton-pulse.svelte", () => ({ default: () => {} }));

// Real singletons — assertions read what the page actually writes/calls.
import { headerConfig } from "$lib/stores/header.svelte.js";
import { submissionsStore } from "$lib/services/submissions-store.js";
import { addToast } from "$lib/stores/toast.svelte.js";
import { getCriteriaForAssignment } from "$lib/services/criteria-loader.js";

if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
	Object.defineProperty(window, "matchMedia", {
		writable: true,
		value: (query: string) => ({
			matches: false,
			media: query,
			onchange: null,
			addListener: () => {},
			removeListener: () => {},
			addEventListener: () => {},
			removeEventListener: () => {},
			dispatchEvent: () => false,
		}),
	});
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const RUBRIC: MergedRubric = {
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

const DETAIL: SubmissionDetail = {
	id: "2026SS_03",
	studentId: "2026SS_03",
	assignmentId: "soil_contamination",
	semester: "2026SS",
	status: "graded",
	createdAt: "2026-08-01T10:00:00.000Z",
	updatedAt: "2026-08-01T10:00:00.000Z",
	cells: [],
	referenceCells: [],
	grading: {
		notes: "existing top-level note",
		dimensions: {
			code_quality_design: 14,
			code_execution_results: 0,
			assignment_requirements: 0,
			scientific_programming: 0,
			creativity: 0,
		},
		feedback: {
			code_formatting: {
				checked: ["consistent_indentation"],
				comments: {},
				deductions: {},
				notes: "",
			},
		},
	},
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("submissions/[id] — clean state: chip, notes editor, Generate/Reset", () => {
	beforeEach(() => {
		vi.mocked(submissionsStore.select).mockReset();
		vi.mocked(submissionsStore.select).mockResolvedValue(DETAIL);
		vi.mocked(submissionsStore.saveGrading).mockReset();
		vi.mocked(submissionsStore.saveGrading).mockResolvedValue(DETAIL);
		vi.mocked(getCriteriaForAssignment).mockReset();
		vi.mocked(getCriteriaForAssignment).mockResolvedValue(RUBRIC);
		vi.mocked(addToast).mockClear();
		headerConfig.showSave = false;
		headerConfig.onsaveclick = undefined;
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("renders the REAL status label in the header chip (not hardcoded)", async () => {
		render(Page);

		const chip = await waitFor(() => {
			const el = document.querySelector(".status-badge.status-graded");
			expect(el).not.toBeNull();
			return el;
		});
		expect(chip!.textContent).toContain("Graded");
	});

	it("restores persisted top-level notes and the header Save persists edits", async () => {
		render(Page);
		const textarea = await screen.findByPlaceholderText(/Top-level feedback notes/);
		expect((textarea as HTMLTextAreaElement).value).toBe("existing top-level note");

		await fireEvent.input(textarea, { target: { value: "existing top-level note + edit" } });
		headerConfig.onsaveclick?.();
		await waitFor(() => expect(vi.mocked(submissionsStore.saveGrading)).toHaveBeenCalled());

		const patch = vi.mocked(submissionsStore.saveGrading).mock.calls[0][1];
		expect(patch.notes).toBe("existing top-level note + edit");
		// The rest of the grading payload still travels with the save.
		expect(patch.dimensions).toBeDefined();
		expect(patch.feedback).toBeDefined();
	});

	it("[Generate] compiles rubric + grading into editable evaluation text", async () => {
		render(Page);
		await screen.findByPlaceholderText(/Top-level feedback notes/);

		await fireEvent.click(screen.getByText("Generate"));

		const textarea = (await screen.findByPlaceholderText(
			/Top-level feedback notes/,
		)) as HTMLTextAreaElement;
		expect(textarea.value).toContain("Evaluation for 2026SS_03 — soil_contamination");
		expect(textarea.value).toContain("Positive Observations");
		expect(textarea.value).toContain("consistent_indentation");
		expect(vi.mocked(addToast)).toHaveBeenCalledWith(
			"success",
			expect.stringContaining("Generated"),
			3500,
		);
	});

	it("[Reset] clears selections + notes + sliders locally; Save persists the cleared state", async () => {
		render(Page);
		await screen.findByPlaceholderText(/Top-level feedback notes/);

		// The restored state has one checked item + a slider value + notes.
		await fireEvent.click(screen.getByText("Reset"));

		headerConfig.onsaveclick?.();
		await waitFor(() => expect(vi.mocked(submissionsStore.saveGrading)).toHaveBeenCalled());

		const patch = vi.mocked(submissionsStore.saveGrading).mock.calls[0][1];
		expect(patch.notes).toBe("");
		expect(patch.feedback).toBeDefined();
		expect(patch.feedback!.code_formatting.checked).toEqual([]);
		expect(patch.dimensions).toBeDefined();
		expect(patch.dimensions!.code_quality_design).toBe(0);
	});
});
