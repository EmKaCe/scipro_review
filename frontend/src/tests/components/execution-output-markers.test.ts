/**
 * Phase 4c — ExecutionOutput pre-evaluation marker badges.
 *
 * Badges are driven by submissionDetail.preEval.markers, looked up per cell
 * by index: error cells always badge (execution truth), verdict cells badge
 * with their D2 tone, and cells WITHOUT a verdict entry show NO badge even
 * when the submission has markers elsewhere. With no markers at all, only a
 * neutral pending notice + error badges appear (never fabricated "different").
 */
// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/svelte";

import ExecutionOutput from "$lib/components/submissions/execution-output.svelte";
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
	gradeSuggestion: { dimensions: { code_quality: 8 }, justification: "" },
	feedbackDraft: "",
	notebookSummary: "",
	evaluatedAt: "2026-08-08T10:00:00Z",
};

function renderOutput(preEval: PreEvalData | null | undefined) {
	return render(ExecutionOutput, {
		props: {
			cells: CELLS,
			submissionId: "2026SS_03",
			assignmentId: "soil_contamination",
			preEval: preEval ?? null,
		},
	});
}

describe("ExecutionOutput without pre-evaluation markers", () => {
	it("shows no approach badges and a neutral notice (no Phase 4 wording)", () => {
		renderOutput(null);
		expect(screen.getByText(/pre-evaluation has run/i)).toBeTruthy();
		expect(screen.queryByText(/Phase 4/i)).toBeNull();
		expect(screen.queryByText("Same approach")).toBeNull();
		expect(screen.queryByText("Different approach")).toBeNull();
		expect(screen.queryByText("Questionable")).toBeNull();
	});

	it("keeps the pending state when preEval.markers is null", () => {
		renderOutput({ ...PRE_EVAL, markers: null });
		expect(screen.getByText(/pre-evaluation has run/i)).toBeTruthy();
	});

	it("still badges error cells — execution truth is independent of comparison", () => {
		renderOutput(null);
		expect(screen.getByText("Error")).toBeTruthy();
	});
});

describe("ExecutionOutput with pre-evaluation markers", () => {
	it("renders verdict badges from preEval.markers with D2 tones", () => {
		const { container } = renderOutput(PRE_EVAL);
		expect(screen.queryByText(/pre-evaluation has run/i)).toBeNull();
		expect(screen.getByText("Same approach")).toBeTruthy();
		expect(screen.getByText("Different approach")).toBeTruthy();
		// D2: same → info, different → neutral.
		expect(container.querySelectorAll(".cell-marker.badge-info").length).toBe(1);
		expect(container.querySelectorAll(".cell-marker.badge-neutral").length).toBe(1);
	});

	it("shows NO badge for a cell without a verdict entry even when the submission has markers", () => {
		const { container } = renderOutput(PRE_EVAL);
		const cards = container.querySelectorAll(".cell-card");
		expect(cards.length).toBe(4);
		// Cells 0 (same), 1 (error), 2 (different) badge; cell 3 has no verdict.
		expect(cards[0].querySelector(".cell-marker")?.textContent).toContain("Same approach");
		expect(cards[1].querySelector(".cell-marker")?.textContent).toContain("Error");
		expect(cards[2].querySelector(".cell-marker")?.textContent).toContain("Different approach");
		expect(cards[3].querySelector(".cell-marker")).toBeNull();
	});

	it("renders questionable verdicts with the amber tone", () => {
		const preEval: PreEvalData = {
			...PRE_EVAL,
			markers: [{ cellIndex: 3, marker: "questionable", reason: "hardcoded result" }],
		};
		const { container } = renderOutput(preEval);
		expect(screen.getByText("Questionable")).toBeTruthy();
		expect(container.querySelectorAll(".cell-marker.badge-warning").length).toBe(1);
	});

	it("keeps the error badge for a failing cell that has no verdict", () => {
		const preEval: PreEvalData = {
			...PRE_EVAL,
			markers: [{ cellIndex: 0, marker: "same", reason: "same reshape trick" }],
		};
		const { container } = renderOutput(preEval);
		const cards = container.querySelectorAll(".cell-card");
		expect(cards[1].querySelector(".cell-marker")?.textContent).toContain("Error");
		expect(screen.getByText("Error")).toBeTruthy();
	});
});
