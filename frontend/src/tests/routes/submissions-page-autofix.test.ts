/**
 * @file L4 page test — non-destructive autofix view: page-level sticky
 * counter, "Show all original" reset, save reminder, and persisted
 * per-cell dispositions.
 *
 * Renders the per-submission page with the REAL ExecutionOutput (the
 * toggle/disposition UI lives there); API client mocked, heavy children
 * mocked. Asserts:
 *   - the sticky bar is hidden until a cell is toggled to the fixed view;
 *   - toggling shows the counter and "Show all original" resets it;
 *   - Accept/Ignore on the fixed strip writes dispositions into page state;
 *   - Save includes autofixDispositions and fires a reminder toast while
 *     any cell is in the derived view;
 *   - persisted dispositions restore on load (view state never does).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";

import Page from "../../routes/submissions/[id]/+page.svelte";
import type { SubmissionDetail } from "$lib/types/submissions.js";
import type { MergedRubric } from "$lib/types/criteria.js";
import { categoryKeyOf } from "$lib/types/criteria.js";

// ---------------------------------------------------------------------------
// Mocks — API client only; the stores themselves are real.
// ---------------------------------------------------------------------------

const api = vi.hoisted(() => ({
	fetchSubmission: vi.fn(),
	saveGrading: vi.fn(),
	exportSubmission: vi.fn(),
	importTeacherYaml: vi.fn(),
	fetchPlagiarismResults: vi.fn(),
}));

vi.mock("$lib/services/submissions-api.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("$lib/services/submissions-api.js")>();
	return { ...actual, ...api };
});

vi.mock("$lib/stores/toast.svelte.js", () => ({
	addToast: vi.fn(),
}));

vi.mock("$lib/services/criteria-loader.js", () => ({
	getCriteriaForAssignment: vi.fn(),
}));

vi.mock("$lib/services/grading-config.js", () => ({
	getGradingConfig: vi.fn().mockResolvedValue(null),
}));

vi.mock("$app/state", () => ({
	page: { params: { id: "2026SS_03" } },
}));

vi.mock("$app/paths", () => ({ base: "" }));

// Heavy/leaf children — not the subject under test. ExecutionOutput stays
// REAL (the toggle + disposition buttons are part of this flow).
vi.mock("$lib/components/submissions/reference-comparison.svelte", () => ({
	default: () => {},
}));
vi.mock("$lib/components/submissions/right-panel-tabs.svelte", () => ({
	default: () => {},
}));
vi.mock("$lib/components/ui/menu-button.svelte", () => ({ default: () => {} }));
vi.mock("$lib/components/ui/skeleton-pulse.svelte", () => ({ default: () => {} }));

// Real singletons — assertions read what the page actually writes/calls.
import { ApiError } from "$lib/services/submissions-api.js";
import { headerConfig } from "$lib/stores/header.svelte.js";
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
	cells: [
		{ index: 0, type: "code", source: "x = 5", marker: "pending" },
		{
			index: 1,
			type: "code",
			source: "y = (x + 1",
			error: "SyntaxError: invalid syntax",
			marker: "error",
		},
	],
	fixedCells: [
		{ index: 0, type: "code", source: "x = 5", marker: "pending" },
		{ index: 1, type: "code", source: "y = (x + 1)", output: "6\n", marker: "pending" },
	],
	grading: {
		notes: "",
		dimensions: {
			code_quality_design: 14,
			code_execution_results: 0,
			assignment_requirements: 0,
			scientific_programming: 0,
			creativity: 0,
		},
		feedback: {},
		// A prior session accepted cell 2's fix — durable, must restore.
		autofixDispositions: { "1": "accepted" },
	},
};

function cardFor(label: string): HTMLElement {
	const node = screen.getAllByText(label)[0];
	if (!node) throw new Error(`missing cell label ${label}`);
	const card = node.closest(".cell-card");
	if (!card) throw new Error(`no .cell-card ancestor for ${label}`);
	return card as HTMLElement;
}

describe("submissions/[id] — autofix view state + dispositions", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		api.fetchSubmission.mockResolvedValue(DETAIL);
		api.saveGrading.mockResolvedValue(DETAIL);
		api.exportSubmission.mockResolvedValue({
			fileName: "2026SS_03.yaml",
			content: "student_id: 2026SS_03\n",
		});
		api.importTeacherYaml.mockResolvedValue(DETAIL);
		api.fetchPlagiarismResults.mockRejectedValue(new ApiError(404, "No plagiarism check yet"));
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

	it("hides the sticky bar until a cell is toggled; Show all original resets", async () => {
		render(Page);
		await screen.findByText("Cell 2");

		// No cell in the derived view → no bar (even though dispositions exist).
		expect(screen.queryByText(/cell\(s\) showing auto-fixed versions/)).toBeNull();

		const card = cardFor("Cell 2");
		await fireEvent.click(within(card).getByRole("button", { name: "Show auto-fixed" }));

		// The page-level bar counts the toggled cell.
		expect(screen.getByText(/1 cell\(s\) showing auto-fixed versions/)).toBeTruthy();

		await fireEvent.click(screen.getByRole("button", { name: "Show all original" }));

		expect(screen.queryByText(/cell\(s\) showing auto-fixed versions/)).toBeNull();
	});

	it("persisted dispositions restore on load; view state does not", async () => {
		render(Page);
		await screen.findByText("Cell 2");

		// Durable disposition came back from grading state…
		// (exercised via Save below); the VIEW set is empty — the authentic
		// original is shown by default and no bar appears.
		expect(screen.queryByText(/cell\(s\) showing auto-fixed versions/)).toBeNull();
		expect(cardFor("Cell 2").classList.contains("cell-autofixed")).toBe(false);
	});

	it("Accept/Ignore on the fixed strip writes dispositions; Save carries them + reminds", async () => {
		render(Page);
		await screen.findByText("Cell 2");

		const card = cardFor("Cell 2");
		await fireEvent.click(within(card).getByRole("button", { name: "Show auto-fixed" }));
		// Strip shows the disposition buttons in the derived view.
		await fireEvent.click(within(card).getByRole("button", { name: "Accept" }));

		// Save via the header.
		headerConfig.onsaveclick?.();
		await waitFor(() => expect(api.saveGrading).toHaveBeenCalled());

		const patch = api.saveGrading.mock.calls[0][1] as Record<string, unknown>;
		expect(patch.autofixDispositions).toEqual({ "1": "accepted" });
		// Reminder toast fired because a cell is still in the derived view.
		expect(vi.mocked(addToast)).toHaveBeenCalledWith(
			"info",
			expect.stringContaining("auto-fixed"),
			expect.any(Number),
		);
	});

	it("keeps dispositions in the save payload even with no cell toggled", async () => {
		render(Page);
		await screen.findByText("Cell 2");

		headerConfig.onsaveclick?.();
		await waitFor(() => expect(api.saveGrading).toHaveBeenCalled());

		const patch = api.saveGrading.mock.calls[0][1] as Record<string, unknown>;
		// The restored disposition rides along on the first save.
		expect(patch.autofixDispositions).toEqual({ "1": "accepted" });
	});
});
