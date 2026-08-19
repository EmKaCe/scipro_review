/**
 * B3 / BUG-002 — cohort calibration visibility.
 *
 * The detail page must surface old→new dimension score adjustments applied
 * by cross-submission cohort calibration. The note component renders them
 * only when at least one adjustment is present; an empty/absent list renders
 * nothing (the calibrated scores were flagged as unremarkable by the UI).
 */
// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/svelte";

import CohortCalibrationNote from "$lib/components/submissions/cohort-calibration-note.svelte";
import type { CalibrationAdjustment } from "$lib/types/submissions.js";

const ADJUSTMENTS: CalibrationAdjustment[] = [
	{
		submissionId: "2026SS_03",
		dimension: "creativity",
		oldScore: 2.5,
		newScore: 3.5,
		reason: "shifted toward cohort reference-fit median",
	},
	{
		submissionId: "2026SS_03",
		dimension: "code_execution_results",
		oldScore: 3,
		newScore: 3,
		reason: "consistent with the cohort",
	},
];

describe("CohortCalibrationNote with adjustments", () => {
	it("renders the explainer and each old→new pair", () => {
		render(CohortCalibrationNote, { props: { adjustments: ADJUSTMENTS } });
		expect(screen.getByText("Cohort calibration")).toBeTruthy();
		expect(
			screen.getByText(
				/Dimension scores were shifted toward the cohort reference during pre-evaluation calibration/i,
			),
		).toBeTruthy();
		// Prettified dimension labels.
		expect(screen.getByText("Creativity")).toBeTruthy();
		expect(screen.getByText("Code execution results")).toBeTruthy();
		// Old → new values.
		expect(screen.getByText("2.5")).toBeTruthy();
		expect(screen.getByText("3.5")).toBeTruthy();
		// "3" appears twice (old and new for code_execution_results).
		expect(screen.getAllByText("3").length).toBe(2);
	});

	it("marks the note element with a note role for the regression hook", () => {
		const { container } = render(CohortCalibrationNote, {
			props: { adjustments: ADJUSTMENTS },
		});
		expect(container.querySelector(".cal-note")).not.toBeNull();
	});
});

describe("CohortCalibrationNote without adjustments", () => {
	it("renders nothing when the list is empty", () => {
		const { container } = render(CohortCalibrationNote, { props: { adjustments: [] } });
		expect(container.querySelector(".cal-note")).toBeNull();
		expect(screen.queryByText("Cohort calibration")).toBeNull();
	});
});
