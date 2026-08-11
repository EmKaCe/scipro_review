/**
 * @file Unit tests for cohort-calibration.ts — Phase 2c deterministic
 * cross-submission score calibration (pure, no Svelte environment).
 *
 * Covers the six documented behaviors: reference-fit clustering, the global
 * 6.0 → 5.5 cap, the bounded-fit CER cap against the reference-fit median,
 * outlier detection in homogeneous clusters, the empty result for consistent
 * cohorts, and the error-submission CER cap (exercised through the
 * results-store adapter).
 */

import { describe, expect, it } from "vitest";

import {
	calibrateCohortFromResults,
	calibrateCohortScores,
	classifyExecutionCluster,
	ExecutionCluster,
	SOIL_CONTAMINATION_ANCHORS,
	type SubmissionExecutionOutcome,
} from "$lib/server/copilot/cohort-calibration";
import type {
	ResultsFile,
	StoredExecutionResult,
	StoredPreEvaluation,
} from "$lib/server/results-store";

const CER = "code_execution_results";

/** Scores map helper: submissionId -> dimension scores. */
function scores(
	entries: readonly (readonly [string, Record<string, number>])[],
): Map<string, Record<string, number>> {
	return new Map(entries);
}

/** Outcomes map helper with a shared per-submission outcome. */
function outcomes(
	ids: readonly string[],
	outcome: SubmissionExecutionOutcome,
): Map<string, SubmissionExecutionOutcome> {
	return new Map(ids.map((id) => [id, outcome]));
}

/** Minimal stored pre-evaluation envelope for the results-store adapter. */
function preEval(dimensions: Record<string, number>): StoredPreEvaluation {
	return {
		markers: null,
		gradeSuggestion: { dimensions, justification: "test fixture" },
		feedbackDraft: "",
		notebookSummary: "",
		evaluatedAt: "2026-08-11T00:00:00.000Z",
	};
}

/** Minimal stored execution result for the results-store adapter. */
function storedResult(overrides: {
	error?: string | null;
	success?: boolean;
	preEval?: StoredPreEvaluation;
}): StoredExecutionResult {
	return {
		success: overrides.success ?? true,
		notebookPath: "/tmp/notebook.ipynb",
		cells: [],
		fixedCells: null,
		totalCells: 0,
		executedCells: 0,
		errorCells: 0,
		durationSeconds: 0,
		preprocessing: {
			cellsModified: 0,
			totalEdits: 0,
			editTypes: {},
			llmPreprocessing: "skipped",
			llmAnalysis: false,
		},
		modifiedFiles: [],
		autofix: { attempts: 0, succeeded: 0 },
		error: overrides.error ?? null,
		preEval: overrides.preEval,
	};
}

describe("calibrateCohortScores", () => {
	it("groups submissions into reference-fit cluster when R squared at least 0.97", () => {
		// Reference-fit band is derived from the anchor facts:
		// R² 0.9794 → floor 0.97, RMSE 25.18 → ceil 30.
		expect(SOIL_CONTAMINATION_ANCHORS).toEqual({
			A: 1210.91,
			B: -484.95,
			x0: -4.8,
			y0: 986.98,
			L: 684.48,
			rSquared: 0.9794,
			rmse: 25.18,
		});

		expect(classifyExecutionCluster({ rSquared: 0.98, rmse: 20 })).toBe(
			ExecutionCluster.reference_fit,
		);
		// Boundary values of the band are still reference-fit.
		expect(classifyExecutionCluster({ rSquared: 0.97, rmse: 30 })).toBe(
			ExecutionCluster.reference_fit,
		);
		// Below the floor or above the ceiling — not reference-fit.
		expect(classifyExecutionCluster({ rSquared: 0.9699, rmse: 20 })).not.toBe(
			ExecutionCluster.reference_fit,
		);
		expect(classifyExecutionCluster({ rSquared: 0.98, rmse: 31 })).not.toBe(
			ExecutionCluster.reference_fit,
		);
		// Bounded fits and metric-less submissions land elsewhere.
		expect(classifyExecutionCluster({ bounded: true })).toBe(ExecutionCluster.bounded_fit);
		expect(classifyExecutionCluster({})).toBe(ExecutionCluster.no_metrics);
	});

	it("caps 6.0 to 5.5 across all submissions", () => {
		const adjustments = calibrateCohortScores(
			scores([
				["s1", { [CER]: 6.0, code_quality_design: 6.0 }],
				["s2", { [CER]: 5.5, creativity: 6.0 }],
			]),
		);

		expect(adjustments).toHaveLength(3);
		for (const adjustment of adjustments) {
			expect(adjustment.oldScore).toBe(6.0);
			expect(adjustment.newScore).toBe(5.5);
			expect(adjustment.reason).toContain("5.5");
		}
		// Every capped submission+dimension is present, sorted deterministically.
		expect(adjustments.map((a) => `${a.submissionId}:${a.dimension}`)).toEqual([
			"s1:code_execution_results",
			"s1:code_quality_design",
			"s2:creativity",
		]);
		// A valid 5.5 is never touched.
		expect(adjustments.some((a) => a.dimension === CER && a.submissionId === "s2")).toBe(false);
	});

	it("caps bounded-fit CER at or below reference-fit median", () => {
		const adjustments = calibrateCohortScores(
			scores([
				// Reference-fit cluster: CER median 5.0.
				["r1", { [CER]: 5.0 }],
				["r2", { [CER]: 5.0 }],
				["r3", { [CER]: 5.0 }],
				// Bounded-fit submissions.
				["b1", { [CER]: 5.5 }],
				["b2", { [CER]: 4.5 }],
			]),
			SOIL_CONTAMINATION_ANCHORS,
			new Map<string, SubmissionExecutionOutcome>([
				// Reference-fit cluster.
				["r1", { rSquared: 0.98, rmse: 20 }],
				["r2", { rSquared: 0.98, rmse: 20 }],
				["r3", { rSquared: 0.98, rmse: 20 }],
				// Bounded-fit submissions (used bounds, no metrics).
				["b1", { bounded: true }],
				["b2", { bounded: true }],
			]),
		);

		// b1's 5.5 is capped to the reference-fit median 5.0; b2 already sits
		// at or below the median and stays untouched.
		expect(adjustments).toHaveLength(1);
		expect(adjustments[0]).toMatchObject({
			submissionId: "b1",
			dimension: CER,
			oldScore: 5.5,
			newScore: 5.0,
		});
		expect(adjustments[0].reason).toContain("reference-fit median");
	});

	it("flags score outlier in homogeneous execution cluster", () => {
		// Five submissions with the same R² — four scored CER 5.5, one 4.0.
		const adjustments = calibrateCohortScores(
			scores([
				["s1", { [CER]: 5.5 }],
				["s2", { [CER]: 5.5 }],
				["s3", { [CER]: 5.5 }],
				["s4", { [CER]: 5.5 }],
				["s5", { [CER]: 4.0 }],
			]),
			SOIL_CONTAMINATION_ANCHORS,
			outcomes(["s1", "s2", "s3", "s4", "s5"], { rSquared: 0.98, rmse: 20 }),
		);

		expect(adjustments).toHaveLength(1);
		expect(adjustments[0]).toMatchObject({
			submissionId: "s5",
			dimension: CER,
			oldScore: 4.0,
			newScore: 5.5, // cluster median
		});
		expect(adjustments[0].reason).toContain("homogeneous");
	});

	it("returns empty adjustments when all scores are consistent", () => {
		const adjustments = calibrateCohortScores(
			scores([
				["s1", { [CER]: 5.5, code_quality_design: 5.0 }],
				["s2", { [CER]: 5.5, code_quality_design: 5.0 }],
				["s3", { [CER]: 5.5, code_quality_design: 5.0 }],
				["s4", { [CER]: 5.5, code_quality_design: 5.0 }],
				["s5", { [CER]: 5.5, code_quality_design: 5.0 }],
			]),
			SOIL_CONTAMINATION_ANCHORS,
			outcomes(["s1", "s2", "s3", "s4", "s5"], { rSquared: 0.98, rmse: 20 }),
		);

		expect(adjustments).toEqual([]);
	});

	it("caps error-submission CER at or below 5.0", () => {
		// Exercised through the results-store adapter: error flags come from
		// the stored execution result, scores from the stored pre-evaluation.
		const results: ResultsFile = {
			s1: storedResult({ error: "kernel died", preEval: preEval({ [CER]: 5.5 }) }),
			s2: storedResult({ success: false, preEval: preEval({ [CER]: 5.5 }) }),
			s3: storedResult({ preEval: preEval({ [CER]: 5.5 }) }),
			s4: storedResult({ error: "boom", preEval: preEval({ [CER]: 4.5 }) }),
			s5: storedResult({ error: "boom", preEval: preEval({ code_quality_design: 5.5 }) }),
		};

		const adjustments = calibrateCohortFromResults(results);

		// s1 and s2 failed execution → capped at 5.0; s3 (clean), s4 (already
		// at or below 5.0) and s5 (non-CER dimension) stay untouched.
		expect(adjustments).toHaveLength(2);
		expect(adjustments.map((a) => a.submissionId)).toEqual(["s1", "s2"]);
		for (const adjustment of adjustments) {
			expect(adjustment.dimension).toBe(CER);
			expect(adjustment.oldScore).toBe(5.5);
			expect(adjustment.newScore).toBe(5.0);
			expect(adjustment.reason).toContain("execution");
		}
	});
});
