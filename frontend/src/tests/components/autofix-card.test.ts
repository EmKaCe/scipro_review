/**
 * L4 component test — AutofixCard suggestion flow.
 *
 * Renders the card with a mocked submissions-api, fires "Suggest fix", and
 * asserts the card leaves the "unavailable" branch and renders the
 * suggestion (summary, Copy to notes, confidence). Also covers the error
 * path. This is the regression guard for the autofix UI round-trip
 * (route + executor are covered by route/executor tests).
 */
// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";

import AutofixCard from "$lib/components/submissions/autofix-card.svelte";
import * as api from "$lib/services/submissions-api.js";
import { autofixStore } from "$lib/services/autofix-store.svelte.js";

const SUGGESTION = {
	skipped: false,
	suggestion: "import helper\nresult = helper(values)",
	explanation: "The helper was missing.",
	confidence: 0.95,
	fixType: "import_fix",
	patchedSource: "import helper\nresult = helper(values)",
	syntaxValid: true,
};

vi.mock("$lib/services/submissions-api.js", async (importOriginal) => {
	const actual = await importOriginal<typeof api>();
	return {
		...actual,
		suggestAutofix: vi.fn(),
	};
});

const mockedSuggest = vi.mocked(api.suggestAutofix);

function renderCard() {
	return render(AutofixCard, {
		props: {
			cellIndex: 2,
			source: "result = undefined_helper(values)",
			error: "NameError: name 'undefined_helper' is not defined",
			submissionId: "2026SS_03",
			assignmentId: "soil_contamination",
			existingNotes: "",
		},
	});
}

describe("AutofixCard suggestion flow", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// The store is a module-level singleton — reset between tests so
		// state from a previous render cannot leak into the next card.
		autofixStore.reset();
	});

	it("shows an idle state before a suggestion is requested", () => {
		renderCard();
		expect(screen.getByText("Auto-fix")).toBeTruthy();
		expect(screen.getByText(/No fix requested yet/)).toBeTruthy();
		expect(screen.getByRole("button", { name: "Suggest fix" })).toBeTruthy();
	});

	it("renders the suggestion after suggestAutofix resolves", async () => {
		mockedSuggest.mockResolvedValue(SUGGESTION);
		renderCard();

		await fireEvent.click(screen.getByRole("button", { name: "Suggest fix" }));

		// Wait for the suggestion branch to render.
		await waitFor(() => {
			expect(screen.queryByText("Auto-fix unavailable")).toBeNull();
		});
		expect(screen.getByText(/import helper/)).toBeTruthy();
		expect(screen.getByRole("button", { name: "Copy to notes" })).toBeTruthy();
		expect(screen.getByText(/Confidence 95%/)).toBeTruthy();
		expect(mockedSuggest).toHaveBeenCalledTimes(1);
		expect(mockedSuggest).toHaveBeenCalledWith(
			"2026SS_03",
			expect.objectContaining({ cellIndex: 2 }),
			"soil_contamination",
		);
	});

	it("renders the error note when suggestAutofix rejects", async () => {
		mockedSuggest.mockRejectedValue(new Error("boom"));
		renderCard();

		await fireEvent.click(screen.getByRole("button", { name: "Suggest fix" }));

		await waitFor(() => {
			expect(screen.getByText(/Fix request failed: boom/)).toBeTruthy();
		});
	});
});
