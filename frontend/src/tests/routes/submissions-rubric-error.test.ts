/**
 * @file L4 page test — rubric load failure notice.
 *
 * Renders the per-submission page with stores + heavy children mocked (same
 * skeleton as submissions-notes-page.test.ts), then asserts the right-panel
 * notice:
 *   - `getCriteriaForAssignment` resolving null (loader failure) → the
 *     "Rubric could not be loaded" notice renders in the right panel;
 *   - a successful rubric → no notice.
 *
 * The criteria-loader itself is NOT modified — its null-on-failure contract
 * is now surfaced instead of being a silent empty panel.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/svelte";

import Page from "../../routes/submissions/[id]/+page.svelte";
import type { SubmissionDetail } from "$lib/types/submissions.js";
import type { MergedRubric } from "$lib/types/criteria.js";
import { categoryKeyOf } from "$lib/types/criteria.js";

// ---------------------------------------------------------------------------
// Mocks (same skeleton as submissions-notes-page.test.ts)
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

vi.mock("$lib/services/grading-config.js", () => ({
	getGradingConfig: vi.fn().mockResolvedValue(null),
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

import { submissionsStore } from "$lib/services/submissions-store.js";
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
		notes: "",
		dimensions: {
			code_quality_design: 0,
			code_execution_results: 0,
			assignment_requirements: 0,
			scientific_programming: 0,
			creativity: 0,
		},
		feedback: {},
	},
};

const NOTICE_TEXT = "Rubric could not be loaded for this assignment.";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("submissions/[id] — rubric load failure notice", () => {
	beforeEach(() => {
		vi.mocked(submissionsStore.select).mockReset();
		vi.mocked(submissionsStore.select).mockResolvedValue(DETAIL);
		vi.mocked(getCriteriaForAssignment).mockReset();
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("shows the rubric notice when getCriteriaForAssignment returns null", async () => {
		vi.mocked(getCriteriaForAssignment).mockResolvedValue(null);
		render(Page);

		const notice = await waitFor(() => {
			const el = document.querySelector(".rubric-error-notice");
			expect(el).not.toBeNull();
			return el;
		});
		expect(notice!.textContent).toContain(NOTICE_TEXT);
	});

	it("shows no rubric notice when the rubric loads successfully", async () => {
		vi.mocked(getCriteriaForAssignment).mockResolvedValue(RUBRIC);
		render(Page);

		// Wait for the load to complete (page leaves the loading skeleton).
		await waitFor(() => expect(screen.queryByText(NOTICE_TEXT)).toBeNull());
		await waitFor(() => expect(document.querySelector(".review-layout")).not.toBeNull());
		expect(document.querySelector(".rubric-error-notice")).toBeNull();
	});
});
