/**
 * @file Phase 2c — deterministic cross-submission cohort calibration.
 *
 * Runs AFTER every submission in a batch has been pre-evaluated (Phase 2a).
 * It takes the stored per-submission dimension scores, groups submissions by
 * their execution outcome, and emits {@link CalibrationAdjustment}s that flag
 * LLM drift: scores that violate hard caps, bounded-fit scores that outrank
 * the reference-fit cluster, and outliers inside otherwise homogeneous
 * execution clusters.
 *
 * Everything here is DETERMINISTIC — no LLM calls, no prompts, no score
 * targets. The reference anchor values (see {@link SOIL_CONTAMINATION_ANCHORS})
 * are FACTS used only to identify the reference-fit cluster; they are never
 * injected into prompts and never used as score suggestions.
 *
 * Score sources: the persisted pre-evaluation envelope
 * (`preEval.gradeSuggestion.dimensions` in results.json, see
 * `$lib/server/results-store`) is the canonical Phase 2a input. The results
 * store does NOT carry fit metrics (R², RMSE, bounds), so execution outcomes
 * are accepted as a parameter — callers extract them from executed cell
 * outputs. {@link calibrateCohortFromResults} wires the store shape into the
 * core function for free (scores + error flags).
 *
 * Caps enforced (CER = the `code_execution_results` dimension):
 *   - 6.0 is never valid — every dimension score is capped at 5.5
 *   - a bounded-fit submission's CER must sit at or below the reference-fit
 *     cluster's CER median
 *   - a submission that failed execution is capped at CER 5.0
 *
 * This module runs only on the SvelteKit server (`$lib/server/`).
 */

import type { ResultsFile } from "$lib/server/results-store";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Execution-outcome cluster a submission belongs to (deterministic). */
export enum ExecutionCluster {
	reference_fit = "reference_fit",
	bounded_fit = "bounded_fit",
	no_metrics = "no_metrics",
}

/**
 * One suggested score correction. `oldScore` is the stored Phase 2a score,
 * `newScore` the calibrated replacement; `reason` is a plain-language
 * explanation for the teacher.
 */
export interface CalibrationAdjustment {
	submissionId: string;
	/** Dimension id, e.g. "code_execution_results". */
	dimension: string;
	oldScore: number;
	newScore: number;
	reason: string;
}

/**
 * Reference solution facts for the assignment (soil_contamination). These are
 * FACTS, not score targets: they only identify which submissions belong to the
 * reference-fit cluster. The fit thresholds are derived from them:
 *   - R² floor  = anchor R² rounded DOWN to two decimals (0.9794 → 0.97)
 *   - RMSE ceil = anchor RMSE rounded UP to tens (25.18 → 30)
 */
export interface ReferenceAnchors {
	/** Reference slope A (mg/kg). */
	A: number;
	/** Reference intercept B (mg/kg). */
	B: number;
	/** Reference inflection x0 (m). */
	x0: number;
	/** Reference asymptote y0 (m). */
	y0: number;
	/** Reference length scale L (m). */
	L: number;
	/** Reference fit R². */
	rSquared: number;
	/** Reference fit RMSE (mg/kg). */
	rmse: number;
}

/** Hardcoded assignment-key facts for soil_contamination (see brief). */
export const SOIL_CONTAMINATION_ANCHORS: ReferenceAnchors = {
	A: 1210.91,
	B: -484.95,
	x0: -4.8,
	y0: 986.98,
	L: 684.48,
	rSquared: 0.9794,
	rmse: 25.18,
};

/**
 * Per-submission execution outcome used for clustering. `bounded` is true
 * when the submission's fit used parameter bounds (B equals 0, or bounds
 * were explicitly applied). `hadError` is true when execution failed.
 */
export interface SubmissionExecutionOutcome {
	/** Model R² for the fitted function; absent when not computed. */
	rSquared?: number;
	/** Fit RMSE in mg/kg; absent when not computed. */
	rmse?: number;
	/** True when the fit used bounds (B equals 0 or explicitly bounded). */
	bounded?: boolean;
	/** True when the submission failed execution. */
	hadError?: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Dimension id of the Code Execution & Results score (6-point scale). */
export const CER_DIMENSION = "code_execution_results";

/** 6.0 is never valid — the top of the scale is 5.5. */
const MAX_VALID_SCORE = 5.5;

/** Submissions that failed execution are capped at 5.0 on CER. */
const ERROR_CER_CAP = 5.0;

/** Outlier detection needs 4+ submissions sharing one value to call a cluster homogeneous. */
const MIN_OUTLIER_CONSENSUS = 4;

// ---------------------------------------------------------------------------
// Clustering
// ---------------------------------------------------------------------------

/** R² floor of the reference-fit band: anchor R² rounded down to 2 decimals (0.9794 → 0.97). */
function referenceFitMinRSquared(anchors: ReferenceAnchors): number {
	return Math.floor(anchors.rSquared * 100) / 100;
}

/** RMSE ceiling of the reference-fit band: anchor RMSE rounded up to tens (25.18 → 30). */
function referenceFitMaxRmse(anchors: ReferenceAnchors): number {
	return Math.ceil(anchors.rmse / 10) * 10;
}

/**
 * Assign a submission to its execution-outcome cluster (priority order):
 *   1. reference_fit — R² ≥ floor AND RMSE ≤ ceil (both metrics computed)
 *   2. bounded_fit   — used bounds (B equals 0 or explicitly bounded)
 *   3. no_metrics    — no R²/RMSE computed (residual bucket, also catches
 *      fits that miss the reference band without using bounds)
 */
export function classifyExecutionCluster(
	outcome: SubmissionExecutionOutcome | undefined,
	anchors: ReferenceAnchors = SOIL_CONTAMINATION_ANCHORS,
): ExecutionCluster {
	if (!outcome) {
		return ExecutionCluster.no_metrics;
	}
	const hasMetrics = outcome.rSquared !== undefined && outcome.rmse !== undefined;
	if (hasMetrics) {
		if (
			outcome.rSquared! >= referenceFitMinRSquared(anchors) &&
			outcome.rmse! <= referenceFitMaxRmse(anchors)
		) {
			return ExecutionCluster.reference_fit;
		}
		// Metrics exist but miss the reference band: bounded fits still get
		// their own cluster, everything else falls into the residual bucket.
		if (!outcome.bounded) {
			return ExecutionCluster.no_metrics;
		}
	}
	return outcome.bounded ? ExecutionCluster.bounded_fit : ExecutionCluster.no_metrics;
}

// ---------------------------------------------------------------------------
// Core calibration
// ---------------------------------------------------------------------------

/**
 * Calibrate a fully pre-evaluated cohort.
 *
 * @param scoresBySubmission submission id → Phase 2a dimension scores
 *   (`preEval.gradeSuggestion.dimensions` from the results store).
 * @param anchors reference solution facts; defaults to
 *   {@link SOIL_CONTAMINATION_ANCHORS}. Facts only — used for clustering,
 *   never as score targets.
 * @param outcomes per-submission execution outcomes (R², RMSE, bounds,
 *   error flag) extracted from executed cell outputs; absent outcomes are
 *   treated as `no_metrics`.
 * @returns calibration adjustments, sorted by submissionId then dimension.
 *   Empty when every score is already consistent.
 */
export function calibrateCohortScores(
	scoresBySubmission: ReadonlyMap<string, Readonly<Record<string, number>>>,
	anchors: ReferenceAnchors = SOIL_CONTAMINATION_ANCHORS,
	outcomes: ReadonlyMap<string, SubmissionExecutionOutcome> = new Map(),
): CalibrationAdjustment[] {
	const adjustments: CalibrationAdjustment[] = [];
	/** `${submissionId}\0${dimension}` pairs already adjusted (one per pair). */
	const adjusted = new Set<string>();
	/** Post-cap scores — caps run first so outlier math sees corrected values. */
	const effective = new Map<string, Record<string, number>>();

	// 1) Per-submission caps (global 5.5, error 5.0) → effective scores.
	for (const [submissionId, dimensions] of scoresBySubmission) {
		const outcome = outcomes.get(submissionId);
		const capped: Record<string, number> = {};
		for (const [dimension, score] of Object.entries(dimensions)) {
			capped[dimension] = capScore(
				submissionId,
				dimension,
				score,
				outcome,
				adjusted,
				adjustments,
			);
		}
		effective.set(submissionId, capped);
	}

	// 2) Group by execution-outcome cluster.
	const groups = new Map<ExecutionCluster, string[]>();
	for (const submissionId of effective.keys()) {
		const cluster = classifyExecutionCluster(outcomes.get(submissionId), anchors);
		const members = groups.get(cluster);
		if (members) {
			members.push(submissionId);
		} else {
			groups.set(cluster, [submissionId]);
		}
	}

	// 3) Bounded-fit CER cap: must sit at or below the reference-fit median.
	const referenceFitIds = groups.get(ExecutionCluster.reference_fit) ?? [];
	const referenceFitCerMedian =
		referenceFitIds.length > 0
			? dimensionMedian(effective, referenceFitIds, CER_DIMENSION)
			: undefined;
	if (referenceFitCerMedian !== undefined) {
		for (const submissionId of groups.get(ExecutionCluster.bounded_fit) ?? []) {
			const dimensions = effective.get(submissionId);
			const current = dimensions?.[CER_DIMENSION];
			if (
				current === undefined ||
				!Number.isFinite(current) ||
				current <= referenceFitCerMedian ||
				adjusted.has(adjustKey(submissionId, CER_DIMENSION))
			) {
				continue;
			}
			adjustments.push({
				submissionId,
				dimension: CER_DIMENSION,
				oldScore: current,
				newScore: referenceFitCerMedian,
				reason: `bounded-fit CER ${current} exceeds the reference-fit median ${referenceFitCerMedian} — capped to the reference-fit median`,
			});
			dimensions![CER_DIMENSION] = referenceFitCerMedian;
			adjusted.add(adjustKey(submissionId, CER_DIMENSION));
		}
	}

	// 4) Per-cluster, per-dimension outlier detection.
	for (const cluster of Object.values(ExecutionCluster) as ExecutionCluster[]) {
		const ids = groups.get(cluster);
		if (!ids || ids.length === 0) {
			continue;
		}
		for (const dimension of collectDimensions(effective, ids)) {
			detectOutliers(cluster, ids, dimension, effective, adjusted, adjustments);
		}
	}

	adjustments.sort(
		(a, b) =>
			a.submissionId.localeCompare(b.submissionId) || a.dimension.localeCompare(b.dimension),
	);
	return adjustments;
}

/**
 * Wire the results-store shape into {@link calibrateCohortScores}: dimension
 * scores come from each stored pre-evaluation envelope; error flags come from
 * the stored execution result (`error` set or `success === false`). Fit
 * metrics (R²/RMSE/bounds) are NOT persisted by the store — pass them via
 * `outcomes` when available.
 */
export function calibrateCohortFromResults(
	results: ResultsFile,
	outcomes: ReadonlyMap<string, SubmissionExecutionOutcome> = new Map(),
): CalibrationAdjustment[] {
	const scores = new Map<string, Record<string, number>>();
	const mergedOutcomes = new Map(outcomes);
	for (const [studentId, stored] of Object.entries(results)) {
		if (stored.preEval) {
			scores.set(studentId, stored.preEval.gradeSuggestion.dimensions);
		}
		if (stored.error != null || stored.success === false) {
			mergedOutcomes.set(studentId, {
				...(mergedOutcomes.get(studentId) ?? {}),
				hadError: true,
			});
		}
	}
	return calibrateCohortScores(scores, SOIL_CONTAMINATION_ANCHORS, mergedOutcomes);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** `${submissionId}\0${dimension}` — stable dedupe key for one score cell. */
function adjustKey(submissionId: string, dimension: string): string {
	return `${submissionId}\u0000${dimension}`;
}

/**
 * Apply the hard caps to one score: every dimension is capped at 5.5 (6.0 is
 * never valid); CER on a failed-execution submission is capped at 5.0. When
 * several caps apply the tightest wins and a single adjustment is emitted.
 */
function capScore(
	submissionId: string,
	dimension: string,
	score: number,
	outcome: SubmissionExecutionOutcome | undefined,
	adjusted: Set<string>,
	adjustments: CalibrationAdjustment[],
): number {
	if (!Number.isFinite(score)) {
		return score;
	}
	const reasons: string[] = [];
	let next = score;
	if (score > MAX_VALID_SCORE) {
		next = Math.min(next, MAX_VALID_SCORE);
		reasons.push(
			`score ${score} exceeds the maximum valid score ${MAX_VALID_SCORE} — 6.0 is never awarded`,
		);
	}
	if (dimension === CER_DIMENSION && outcome?.hadError === true && score > ERROR_CER_CAP) {
		next = Math.min(next, ERROR_CER_CAP);
		reasons.push(
			`submission failed execution — ${CER_DIMENSION} is capped at ${ERROR_CER_CAP}`,
		);
	}
	if (next !== score) {
		adjustments.push({
			submissionId,
			dimension,
			oldScore: score,
			newScore: next,
			reason: reasons.join("; "),
		});
		adjusted.add(adjustKey(submissionId, dimension));
	}
	return next;
}

/** Median of one dimension across a group of submissions (undefined when none have it). */
function dimensionMedian(
	effective: ReadonlyMap<string, Readonly<Record<string, number>>>,
	ids: readonly string[],
	dimension: string,
): number | undefined {
	const values = ids
		.map((id) => effective.get(id)?.[dimension])
		.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
	return values.length > 0 ? medianOf(values) : undefined;
}

function medianOf(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Union of dimension keys present across a group (in first-seen order). */
function collectDimensions(
	effective: ReadonlyMap<string, Readonly<Record<string, number>>>,
	ids: readonly string[],
): string[] {
	const seen = new Set<string>();
	for (const id of ids) {
		for (const dimension of Object.keys(effective.get(id) ?? {})) {
			seen.add(dimension);
		}
	}
	return [...seen];
}

/**
 * Flag outliers inside a homogeneous execution cluster: when 4+ submissions
 * in the cluster share the same value for a dimension AND that value is a
 * strict majority, every dissenter is corrected to the cluster median. A
 * cluster where no value dominates (e.g. 4 vs 4) is not homogeneous — nothing
 * is flagged.
 */
function detectOutliers(
	cluster: ExecutionCluster,
	ids: readonly string[],
	dimension: string,
	effective: ReadonlyMap<string, Readonly<Record<string, number>>>,
	adjusted: Set<string>,
	adjustments: CalibrationAdjustment[],
): void {
	const entries = ids
		.map((id) => ({ id, score: effective.get(id)?.[dimension] }))
		.filter(
			(entry): entry is { id: string; score: number } =>
				typeof entry.score === "number" && Number.isFinite(entry.score),
		);
	if (entries.length === 0) {
		return;
	}

	// Mode = most frequent score; ties resolve to the higher score.
	const counts = new Map<number, number>();
	for (const { score } of entries) {
		counts.set(score, (counts.get(score) ?? 0) + 1);
	}
	let mode = -Infinity;
	let modeCount = 0;
	for (const [value, count] of counts) {
		if (count > modeCount || (count === modeCount && value > mode)) {
			mode = value;
			modeCount = count;
		}
	}

	if (modeCount < MIN_OUTLIER_CONSENSUS || modeCount <= entries.length - modeCount) {
		return;
	}

	const median = medianOf(entries.map((entry) => entry.score));
	for (const { id, score } of entries) {
		if (score === mode || adjusted.has(adjustKey(id, dimension))) {
			continue;
		}
		adjustments.push({
			submissionId: id,
			dimension,
			oldScore: score,
			newScore: median,
			reason: `score ${score} deviates from the homogeneous ${cluster} cluster value ${mode} (${modeCount} of ${entries.length} submissions) — corrected to the cluster median ${median}`,
		});
		adjusted.add(adjustKey(id, dimension));
	}
}
