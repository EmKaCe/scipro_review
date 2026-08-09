/**
 * @file L4 page test — Task W3: chip → incomingPrompt delivery.
 *
 * Renders the per-submission page with the API client mocked and the REAL
 * stores (heavy children mocked), then exercises the inline "Ask copilot"
 * chip path end-to-end: a `copilot-request` CustomEvent on window → the
 * page switches to the Copilot tab → the prompt flows through
 * right-panel-tabs as the $bindable `incomingPrompt` prop → the panel
 * fills its chat input and resets the prop (the round-trip that enables
 * re-clicking the same chip).
 *
 * Replaces the old DOM-event + ".copilot-container input.input-field"
 * selector drain (W3) — there is no selector coupling left to test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";

import Page from "../../routes/submissions/[id]/+page.svelte";
import type { SubmissionDetail } from "$lib/types/submissions.js";
import type { GradingConfig } from "$lib/types/grading.js";
import type { MergedRubric } from "$lib/types/criteria.js";
import { categoryKeyOf } from "$lib/types/criteria.js";
import { parseDimensionKey } from "$lib/types/grading.js";
import * as copilot from "$lib/components/submissions/copilot-store.svelte.js";

// ---------------------------------------------------------------------------
// Mocks — API client only; the stores themselves are real.
// ---------------------------------------------------------------------------

const api = vi.hoisted(() => ({
	fetchSubmission: vi.fn(),
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
	getGradingConfig: vi.fn(),
}));

vi.mock("$app/state", () => ({
	page: { params: { id: "2026SS_03" } },
}));

vi.mock("$app/paths", () => ({ base: "" }));

// Heavy/leaf children — not the subject under test. right-panel-tabs and
// copilot-panel stay REAL so the incomingPrompt chain is exercised.
vi.mock("$lib/components/submissions/execution-output.svelte", () => ({
	default: () => {},
}));
vi.mock("$lib/components/submissions/reference-comparison.svelte", () => ({
	default: () => {},
}));
vi.mock("$lib/components/ui/menu-button.svelte", () => ({ default: () => {} }));
vi.mock("$lib/components/ui/skeleton-pulse.svelte", () => ({ default: () => {} }));
vi.mock("$lib/components/rubric-category.svelte", () => ({ default: () => {} }));
vi.mock("$lib/components/grading-sidebar.svelte", () => ({ default: () => {} }));
vi.mock("$lib/components/submissions/plagiarism-tab.svelte", () => ({
	default: () => {},
}));

import { ApiError } from "$lib/services/submissions-api.js";
import { getCriteriaForAssignment } from "$lib/services/criteria-loader.js";
import { getGradingConfig } from "$lib/services/grading-config.js";

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
				positive: [],
				neutral: [],
				negative: [],
			},
		},
	],
};

const GRADING_CONFIG: GradingConfig = {
	dimensions: [
		{
			key: parseDimensionKey("code_quality_design"),
			title: "Code Quality & Design",
			max_points: 6,
			weight: 1,
		},
	],
	grade_boundaries: [{ min_percentage: 0, grade: 5.0, label: "fail", us_equiv: "F" }],
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Render the loaded page (desktop: right panel visible, rubric tab active). */
async function renderLoadedPage() {
	render(Page);
	await waitFor(() => expect(document.querySelector(".review-layout")).not.toBeNull());
	// Copilot tab is NOT active initially — no chat input anywhere.
	expect(screen.queryByPlaceholderText(/Ask the copilot/)).toBeNull();
}

/** Click an inline "Ask copilot" chip (the rubric-category chip contract). */
function clickAskCopilotChip(prompt: string) {
	window.dispatchEvent(new CustomEvent("copilot-request", { detail: prompt }));
}

/** The panel's chat input (submission scope placeholder). */
function chatInput(): HTMLInputElement {
	return screen.getByPlaceholderText(/Ask the copilot/) as HTMLInputElement;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("submissions/[id] — chip → incomingPrompt prompt delivery (W3)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		api.fetchSubmission.mockResolvedValue(DETAIL);
		api.fetchPlagiarismResults.mockRejectedValue(new ApiError(404, "No plagiarism check yet"));
		vi.mocked(getCriteriaForAssignment).mockResolvedValue(RUBRIC);
		vi.mocked(getGradingConfig).mockResolvedValue(GRADING_CONFIG);
		vi.stubGlobal(
			"fetch",
			vi.fn().mockImplementation((url: RequestInfo | URL) => {
				const u = String(url);
				if (u.includes("/api/copilot/threads")) {
					return Promise.resolve(
						new Response(JSON.stringify({ threads: [] }), {
							status: 200,
							headers: { "content-type": "application/json" },
						}),
					);
				}
				return Promise.resolve({ ok: false } as Response);
			}),
		);
		copilot.apiMode.value = true;
		localStorage.clear();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		copilot.apiMode.value = false;
		localStorage.clear();
	});

	it("switches to the copilot tab and delivers the chip prompt into the panel input", async () => {
		await renderLoadedPage();

		clickAskCopilotChip("Explain cell 3");

		// The tab switched (aria-pressed on the Copilot tab button) AND the
		// panel mounted and filled its input with the delivered prompt.
		await waitFor(() => {
			const tab = screen.getByRole("button", { name: /^Copilot/ });
			expect(tab.getAttribute("aria-pressed")).toBe("true");
			expect(chatInput().value).toBe("Explain cell 3");
		});
		// The delivered prompt is focused, ready for the teacher to Send.
		expect(document.activeElement).toBe(chatInput());
	});

	it("round-trips the reset so re-clicking the SAME chip re-delivers", async () => {
		await renderLoadedPage();

		clickAskCopilotChip("same prompt");
		const input = await waitFor(() => {
			expect(chatInput().value).toBe("same prompt");
			return chatInput();
		});

		// Clear the field manually, then click the same chip again. If the
		// $bindable reset had NOT propagated back to the page's queuedPrompt
		// (stuck at "same prompt"), the second dispatch would be a no-op
		// (same prop value → no effect) and the input would stay empty.
		await fireEvent.input(input, { target: { value: "" } });
		expect(input.value).toBe("");

		clickAskCopilotChip("same prompt");
		await waitFor(() => expect(input.value).toBe("same prompt"));
	});
});
