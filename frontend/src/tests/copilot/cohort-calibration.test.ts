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
	applyCalibrationAdjustments,
	calibrateCohortFromResults,
	calibrateCohortScores,
	classifyExecutionCluster,
	ExecutionCluster,
	extractFitMetricsFromResults,
	SOIL_CONTAMINATION_ANCHORS,
	type CalibrationAdjustment,
	type SubmissionExecutionOutcome,
} from "$lib/server/copilot/cohort-calibration";
import type { ExecutedCell } from "$lib/server/executor-client";
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
		// Fixture only — the value is not asserted by these tests.
		gradingConfidence: "review_optional",
		evaluatedAt: "2026-08-11T00:00:00.000Z",
	};
}

/** Minimal stored execution result for the results-store adapter. */
function storedResult(overrides: {
	error?: string | null;
	success?: boolean;
	preEval?: StoredPreEvaluation;
	cells?: ExecutedCell[];
}): StoredExecutionResult {
	return {
		success: overrides.success ?? true,
		notebookPath: "/tmp/notebook.ipynb",
		cells: overrides.cells ?? [],
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

/** Executed-cell fixture: type, source, output (marker default "different"). */
function cell(overrides: {
	index?: number;
	type?: "code" | "markdown";
	source?: string;
	output?: string;
}): ExecutedCell {
	return {
		index: overrides.index ?? 0,
		type: overrides.type ?? "code",
		source: overrides.source ?? "",
		original_source: overrides.source ?? "",
		output: overrides.output ?? "",
		error: null,
		traceback: null,
		execution_count: 1,
		marker: "different",
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

	it("flags score outliers when dissenters exist on both sides of the mode", () => {
		// Six submissions with the same R² — four scored CER 5.0 (mode), one
		// 4.0 (below), one 5.5 (above). Both sides present → flag both.
		const adjustments = calibrateCohortScores(
			scores([
				["s1", { [CER]: 5.0 }],
				["s2", { [CER]: 5.0 }],
				["s3", { [CER]: 5.0 }],
				["s4", { [CER]: 5.0 }],
				["s5", { [CER]: 4.0 }],
				["s6", { [CER]: 5.5 }],
			]),
			SOIL_CONTAMINATION_ANCHORS,
			outcomes(["s1", "s2", "s3", "s4", "s5", "s6"], { rSquared: 0.98, rmse: 20 }),
		);

		expect(adjustments).toHaveLength(2);
		expect(adjustments.map((a) => a.submissionId).sort()).toEqual(["s5", "s6"]);
		expect(adjustments[0]).toMatchObject({
			dimension: CER,
			newScore: 5.0, // cluster median
		});
		expect(adjustments[0].reason).toContain("homogeneous");
	});

	it("does NOT flag one-sided dissenters — the mode is a bias, not a consensus", () => {
		// Four scored CER 5.5, one 4.0 — all dissenters BELOW the mode. This
		// is the 2026-08-17 regression: the LLM's scientific_programming
		// scores clustered at 3 (under-score bias) while the correct 4.5-5.5
		// scores were the dissenters; the old logic dragged the correct
		// scores DOWN to the cluster median (mean Δ 0.66 → 1.39).
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

		expect(adjustments).toHaveLength(0);
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

describe("extractFitMetricsFromResults", () => {
	it("parses R2, RMSE and bounds from executed-cell output and source", () => {
		const results: ResultsFile = {
			// R^2 = and RMSE = forms (post-process.ts canonical), explicit bounds.
			s1: storedResult({
				cells: [
					cell({
						index: 0,
						type: "markdown",
						source: "# Fit — ignore me",
						output: "R^2 = 0.1234",
					}),
					cell({
						index: 1,
						source:
							"popt, pcov = curve_fit(model, x, y, p0=[1000, 0], bounds=(0, np.inf))",
						output: "R^2 = 0.98\nRMSE = 20.5",
					}),
				],
			}),
			// R2: and RMSE ( forms, no bounds in source.
			s2: storedResult({
				cells: [
					cell({ index: 0, source: "x = 1", output: "R2: 0.941" }),
					cell({ index: 1, source: "print(fit)", output: "RMSE (42.58 mg/kg)" }),
				],
			}),
			// ² variant, bounds split across the source line.
			s3: storedResult({
				cells: [
					cell({
						index: 0,
						source: "res = curve_fit(model, x, y, bounds = [0, None])",
						output: "R²=0.8795",
					}),
				],
			}),
			// No metrics, no bounds — outcome present but empty.
			s4: storedResult({ cells: [cell({ index: 0, source: "print('hello')", output: "hello" })] }),
		};

		const outcomes = extractFitMetricsFromResults(results);

		// Only keys present in the results file are returned.
		expect([...outcomes.keys()]).toEqual(["s1", "s2", "s3", "s4"]);
		expect(outcomes.get("s1")).toEqual({ rSquared: 0.98, rmse: 20.5, bounded: true });
		expect(outcomes.get("s2")).toEqual({ rSquared: 0.941, rmse: 42.58 });
		expect(outcomes.get("s3")).toEqual({ rSquared: 0.8795, bounded: true });
		expect(outcomes.get("s4")).toEqual({});
	});

	it("only reads output of code cells and does not mutate the results file", () => {
		const output = "R^2 = 0.9";
		const results: ResultsFile = {
			s1: storedResult({
				cells: [
					cell({ index: 0, type: "markdown", source: "bounds=(0, 1)", output }),
					cell({ index: 1, source: "x = 1", output: "no metrics here" }),
				],
			}),
		};
		const before = JSON.stringify(results);

		const outcomes = extractFitMetricsFromResults(results);

		// Markdown cell output/source is ignored: no R², no bounds flag.
		expect(outcomes.get("s1")).toEqual({});
		expect(JSON.stringify(results)).toBe(before);
	});
});

describe("applyCalibrationAdjustments", () => {
	it("applies multiple adjustments across submissions without mutating the input", () => {
		const input: Record<string, Record<string, number>> = {
			s1: { [CER]: 5.5, code_quality_design: 4.0 },
			s2: { [CER]: 5.5, creativity: 3.0 },
		};
		const adjustments: CalibrationAdjustment[] = [
			{
				submissionId: "s1",
				dimension: CER,
				oldScore: 5.5,
				newScore: 5.0,
				reason: "bounded-fit CER cap",
			},
			{
				submissionId: "s2",
				dimension: CER,
				oldScore: 5.5,
				newScore: 5.0,
				reason: "bounded-fit CER cap",
			},
			{
				submissionId: "s2",
				dimension: "creativity",
				oldScore: 3.0,
				newScore: 3.5,
				reason: "outlier correction",
			},
		];

		const adjusted = applyCalibrationAdjustments(input, adjustments);

		// Adjusted copy carries every change…
		expect(adjusted).toEqual({
			s1: { [CER]: 5.0, code_quality_design: 4.0 },
			s2: { [CER]: 5.0, creativity: 3.5 },
		});
		// …while the input is untouched.
		expect(input).toEqual({
			s1: { [CER]: 5.5, code_quality_design: 4.0 },
			s2: { [CER]: 5.5, creativity: 3.0 },
		});
		// The returned map is a distinct object (copy, not same reference).
		expect(adjusted).not.toBe(input);
		expect(adjusted.s1).not.toBe(input.s1);
	});

	it("skips adjustments for submissions absent from the scores map", () => {
		const input: Record<string, Record<string, number>> = { s1: { [CER]: 5.5 } };
		const adjustments: CalibrationAdjustment[] = [
			{
				submissionId: "missing",
				dimension: CER,
				oldScore: 5.5,
				newScore: 5.0,
				reason: "no such submission",
			},
		];

		expect(applyCalibrationAdjustments(input, adjustments)).toEqual({ s1: { [CER]: 5.5 } });
		expect(input).toEqual({ s1: { [CER]: 5.5 } });
	});

	it("returns an empty map for empty input", () => {
		expect(applyCalibrationAdjustments({}, [])).toEqual({});
	});
});
