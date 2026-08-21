/**
 * Phase 4c — ReferenceComparison with pre-evaluation data.
 *
 * preEval absent / markers null → neutral pending notice (no "Phase 4"
 * wording) plus execution-error rows. markers present → per-cell verdict
 * overview: notebook summary, verdict rows (cell index, marker label,
 * reason) with D2 tones, and the read-only suggested-grade block.
 * "different" is an EXPLAINER tone (neutral), never a flag.
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

describe("ReferenceComparison without pre-evaluation data", () => {
	it("shows a neutral pending notice (no Phase 4 wording) when preEval is absent", () => {
		render(ReferenceComparison, { props: { submissionCells: CELLS } });
		expect(screen.getByText(/pre-evaluation has run/i)).toBeTruthy();
		expect(screen.queryByText(/Phase 4/i)).toBeNull();
	});

	it("keeps the pending notice when preEval.markers is null", () => {
		render(ReferenceComparison, {
			props: { submissionCells: CELLS, preEval: { ...PRE_EVAL, markers: null } },
		});
		expect(screen.getByText(/pre-evaluation has run/i)).toBeTruthy();
		expect(screen.queryByText(/cells compared/i)).toBeNull();
	});

	it("still lists execution errors in the pending state", () => {
		render(ReferenceComparison, { props: { submissionCells: CELLS } });
		expect(screen.getByText(/execution failed/i)).toBeTruthy();
	});
});

describe("ReferenceComparison with pre-evaluation data", () => {
	it("replaces the pending notice with the notebook summary + verdict rows", () => {
		render(ReferenceComparison, { props: { submissionCells: CELLS, preEval: PRE_EVAL } });
		expect(screen.queryByText(/pre-evaluation has run/i)).toBeNull();
		expect(
			screen.getByText("Clean, well-commented notebook with a working model."),
		).toBeTruthy();
		expect(screen.getByText("Approach matches reference")).toBeTruthy();
		expect(screen.getByText("Approach differs from reference")).toBeTruthy();
		expect(screen.getByText("same reshape trick")).toBeTruthy();
		expect(screen.getByText("solves via numpy")).toBeTruthy();
		// Execution errors stay visible (cell 1 has no verdict → error row).
		expect(screen.getByText(/execution failed/i)).toBeTruthy();
	});

	it("shows the summary stats and the read-only suggested-grade block", () => {
		render(ReferenceComparison, { props: { submissionCells: CELLS, preEval: PRE_EVAL } });
		expect(screen.getByText("2 cells compared")).toBeTruthy();
		expect(screen.getByText("1 error")).toBeTruthy();
		expect(screen.getByText("Suggested grade")).toBeTruthy();
		expect(screen.getByText("code_quality")).toBeTruthy();
		expect(screen.getByText("8")).toBeTruthy();
		expect(screen.getByText("Solid overall, minor style issues.")).toBeTruthy();
	});

	it("renders 'different' as a neutral explainer row, never as a flagged row", () => {
		const { container } = render(ReferenceComparison, {
			props: { submissionCells: CELLS, preEval: PRE_EVAL },
		});
		// 2 verdict rows + 1 error row (cell 1 has no verdict).
		expect(container.querySelectorAll(".ref-row").length).toBe(3);
		// No questionable verdicts here → no warning-tinted rows; only the
		// error row carries a tint. "different" stays neutral by default.
		expect(container.querySelectorAll(".row-diff").length).toBe(0);
		expect(container.querySelectorAll(".row-error").length).toBe(1);
	});

	it("renders questionable verdicts with the amber (warning) tone", () => {
		const preEval: PreEvalData = {
			...PRE_EVAL,
			markers: [{ cellIndex: 1, marker: "questionable", reason: "hardcoded result" }],
		};
		const { container } = render(ReferenceComparison, {
			props: { submissionCells: CELLS, preEval },
		});
		expect(screen.getByText("Approach is questionable")).toBeTruthy();
		expect(screen.getByText("hardcoded result")).toBeTruthy();
		// The error cell now has a verdict → its row is the amber verdict,
		// so no separate error row is rendered for it.
		expect(container.querySelectorAll(".row-diff").length).toBe(1);
		expect(container.querySelectorAll(".row-error").length).toBe(0);
	});
});

describe("ReferenceComparison — Apply suggested scores (Task B)", () => {
	it("shows the apply button when gradeSuggestion.dimensions has entries", () => {
		render(ReferenceComparison, { props: { submissionCells: CELLS, preEval: PRE_EVAL } });
		expect(screen.getByRole("button", { name: /apply suggested scores/i })).toBeTruthy();
	});

	it("hides the apply button when there are no suggested dimensions", () => {
		const preEval: PreEvalData = {
			...PRE_EVAL,
			gradeSuggestion: { dimensions: {}, justification: "" },
		};
		render(ReferenceComparison, { props: { submissionCells: CELLS, preEval } });
		expect(screen.queryByRole("button", { name: /apply suggested scores/i })).toBeNull();
	});

	it("emits the full pre-evaluation envelope when the apply button is clicked", async () => {
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
