/**
 * Phase 4c — ReferenceComparison as the compact "Pre-evaluation results"
 * summary.
 *
 * preEval absent / markers null → neutral pending invitation (no "Phase 4"
 * wording, no red banner). markers present → always-visible header
 * ("Pre-evaluation results" + status stats + Apply button), notebook
 * summary, and the suggested-grade grid with dimension TITLES resolved from
 * `dimensionTitles` (raw key fallback). The per-cell verdict list is GONE —
 * reasons/errors now render on the cell cards (execution-output.svelte).
 */
// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";

import ReferenceComparison from "$lib/components/submissions/reference-comparison.svelte";
import type { CellInfo, PreEvalData } from "$lib/types/submissions.js";

function cell(index: number, opts: Partial<CellInfo> = {}): CellInfo {
	return { index, type: "code", source: "x = 1", marker: "pending", ...opts };
}

const CELLS: CellInfo[] = [cell(0), cell(1, { marker: "error", error: "boom" }), cell(2), cell(3)];

const PRE_EVAL: PreEvalData = {
	markers: [
		{ cellIndex: 0, marker: "same", reason: "same reshape trick" },
		{ cellIndex: 2, marker: "different", reason: "solves via numpy" },
	],
	gradeSuggestion: {
		dimensions: { code_quality: 8, correctness: 7 },
		justification: "Solid overall, minor style issues.",
	},
	feedbackDraft: "",
	notebookSummary: "Clean, well-commented notebook with a working model.",
	evaluatedAt: "2026-08-08T10:00:00Z",
};

const DIMENSION_TITLES: Record<string, string> = {
	code_quality: "Code Quality",
	correctness: "Correctness",
};

describe("ReferenceComparison without pre-evaluation data", () => {
	it("shows the pending invitation copy when preEval is absent (no Phase 4 wording, no Apply button)", () => {
		render(ReferenceComparison, { props: { submissionCells: CELLS } });
		expect(
			screen.getByText(
				"Run pre-evaluation to get a notebook summary, suggested scores, and per-cell notes.",
			),
		).toBeTruthy();
		expect(screen.queryByText(/Phase 4/i)).toBeNull();
		expect(screen.queryByRole("button", { name: /apply suggested scores/i })).toBeNull();
	});

	it("keeps the pending invitation when preEval.markers is null", () => {
		render(ReferenceComparison, {
			props: { submissionCells: CELLS, preEval: { ...PRE_EVAL, markers: null } },
		});
		expect(
			screen.getByText(
				"Run pre-evaluation to get a notebook summary, suggested scores, and per-cell notes.",
			),
		).toBeTruthy();
		expect(screen.queryByText(/cells compared/i)).toBeNull();
		expect(screen.queryByRole("button", { name: /apply suggested scores/i })).toBeNull();
	});
});

describe("ReferenceComparison with pre-evaluation data", () => {
	it("shows the 'Pre-evaluation results' title, summary and stats (no pending notice)", () => {
		render(ReferenceComparison, { props: { submissionCells: CELLS, preEval: PRE_EVAL } });
		expect(screen.getByText("Pre-evaluation results")).toBeTruthy();
		expect(screen.queryByText(/run pre-evaluation to get/i)).toBeNull();
		expect(
			screen.getByText("Clean, well-commented notebook with a working model."),
		).toBeTruthy();
		expect(screen.getByText("2 cells compared")).toBeTruthy();
		expect(screen.getByText("1 error")).toBeTruthy();
	});

	it("renders the suggested-grade grid with RESOLVED dimension titles from dimensionTitles", () => {
		render(ReferenceComparison, {
			props: { submissionCells: CELLS, preEval: PRE_EVAL, dimensionTitles: DIMENSION_TITLES },
		});
		expect(screen.getByText("Suggested grade")).toBeTruthy();
		expect(screen.getByText("Code Quality")).toBeTruthy();
		expect(screen.getByText("Correctness")).toBeTruthy();
		// Raw keys must NOT appear when a title is provided.
		expect(screen.queryByText("code_quality")).toBeNull();
		expect(screen.queryByText("correctness")).toBeNull();
		expect(screen.getByText("8")).toBeTruthy();
		expect(screen.getByText("7")).toBeTruthy();
		expect(screen.getByText("Solid overall, minor style issues.")).toBeTruthy();
	});

	it("falls back to the raw dimension key when no title is in the map", () => {
		render(ReferenceComparison, {
			props: {
				submissionCells: CELLS,
				preEval: PRE_EVAL,
				dimensionTitles: { code_quality: "Code Quality" }, // correctness has no title
			},
		});
		expect(screen.getByText("Code Quality")).toBeTruthy();
		expect(screen.getByText("correctness")).toBeTruthy();
	});

	it("renders NO verdict-list rows — reasons now live on the cell cards", () => {
		render(ReferenceComparison, { props: { submissionCells: CELLS, preEval: PRE_EVAL } });
		expect(screen.queryByText("same reshape trick")).toBeNull();
		expect(screen.queryByText("solves via numpy")).toBeNull();
		expect(screen.queryByText("Approach matches reference")).toBeNull();
		expect(screen.queryByText("Approach differs from reference")).toBeNull();
		expect(screen.queryByText(/execution failed/i)).toBeNull();
	});
});

describe("ReferenceComparison — Apply suggested scores", () => {
	it("shows the Apply button in the header when gradeSuggestion.dimensions has entries", () => {
		render(ReferenceComparison, { props: { submissionCells: CELLS, preEval: PRE_EVAL } });
		expect(screen.getByRole("button", { name: /apply suggested scores/i })).toBeTruthy();
	});

	it("hides the Apply button when there are no suggested dimensions", () => {
		const preEval: PreEvalData = {
			...PRE_EVAL,
			gradeSuggestion: { dimensions: {}, justification: "" },
		};
		render(ReferenceComparison, { props: { submissionCells: CELLS, preEval } });
		expect(screen.queryByRole("button", { name: /apply suggested scores/i })).toBeNull();
	});

	it("emits the full pre-evaluation envelope when the Apply button is clicked", async () => {
		let emitted: PreEvalData | undefined;
		render(ReferenceComparison, {
			props: {
				submissionCells: CELLS,
				preEval: PRE_EVAL,
				onApplyGradeSuggestion: (data: PreEvalData) => (emitted = data),
			},
		});
		await fireEvent.click(screen.getByRole("button", { name: /apply suggested scores/i }));
		expect(emitted).toBe(PRE_EVAL);
	});

	it("does not fire the callback without a pre-evaluation payload", async () => {
		let fired = false;
		render(ReferenceComparison, {
			props: {
				submissionCells: CELLS,
				onApplyGradeSuggestion: () => (fired = true),
			},
		});
		// No grade suggestion → no apply button at all.
		expect(screen.queryByRole("button", { name: /apply suggested scores/i })).toBeNull();
		expect(fired).toBe(false);
	});
});
