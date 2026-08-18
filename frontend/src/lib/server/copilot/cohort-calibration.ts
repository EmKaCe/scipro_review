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
 * targets. The reference anchor values (resolved from the assignment's
 * scoring config — `data/scoring/<id>.yaml` `reference_anchors`) are FACTS
 * used only to identify the reference-fit cluster; they are never
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
import type { ExecutedCell } from "$lib/server/executor-client";

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

/**
 * Outlier detection needs 4+ submissions sharing one value to call a
 * cluster homogeneous. Also the minimum successful cohort for the batch
 * pre-evaluate route's post-run calibration step — a smaller run cannot
 * form a homogeneous cluster and is skipped, not crashed.
 */
export const MIN_OUTLIER_CONSENSUS = 4;

/**
 * Fit-metric patterns — canonical forms mirror post-process.ts `matchR2` /
 * `matchRmse` so cohort clustering and evidence notes read the same output.
 * R²: "R^2 = 0.941", "R2: 0.94", "R²=0.941" (first capture group is the value).
 */
export const FIT_R2_PATTERN = /\bR\s*(?:\^2|²|2)\s*[=:]\s*([\d.]+)/i;
/** RMSE: "RMSE = 42.58" or "RMSE (42.58 mg/kg)" (first capture group is the value). */
export const FIT_RMSE_PATTERN = /\bRMSE\s*[=:]\s*([\d.]+)/i;
export const FIT_RMSE_PAREN_PATTERN = /\bRMSE\s*\(\s*([\d.]+)/i;
/** Explicit parameter bounds in a curve_fit call, e.g. `bounds=(0, np.inf)`. */
export const BOUNDS_CODE_PATTERN = /bounds\s*=/i;

/** Compiled fit-metric pattern set (config-preferred, code-fallback). */
export interface FitMetricPatterns {
	r2: RegExp;
	rmse: RegExp;
	rmseParen: RegExp;
	bounds: RegExp;
}

/**
 * Build the fit-metric pattern set from a scoring config (evidence_patterns
 * `fit_metrics_r2` / `fit_metrics_rmse` / `fit_metrics_rmse_paren` /
 * `bounds_assignment`). Falls back to the code constants when the config or
 * a pattern is absent.
 */
export function fitMetricPatternsFromConfig(
	config: { evidencePatterns: ReadonlyMap<string, { regexes: RegExp[] }> } | null | undefined,
): FitMetricPatterns {
	return {
		r2: config?.evidencePatterns.get("fit_metrics_r2")?.regexes[0] ?? FIT_R2_PATTERN,
		rmse: config?.evidencePatterns.get("fit_metrics_rmse")?.regexes[0] ?? FIT_RMSE_PATTERN,
		rmseParen:
			config?.evidencePatterns.get("fit_metrics_rmse_paren")?.regexes[0] ??
			FIT_RMSE_PAREN_PATTERN,
		bounds: config?.evidencePatterns.get("bounds_assignment")?.regexes[0] ?? BOUNDS_CODE_PATTERN,
	};
}

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
	anchors: ReferenceAnchors,
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
 * @param anchors reference solution facts; defaults to the assignment's
 *   scoring config (`data/scoring/<id>.yaml` `reference_anchors`, compiled
 *   by scoring-config.ts). Facts only — used for clustering,
 *   never as score targets.
 * @param outcomes per-submission execution outcomes (R², RMSE, bounds,
 *   error flag) extracted from executed cell outputs; absent outcomes are
 *   treated as `no_metrics`.
 * @returns calibration adjustments, sorted by submissionId then dimension.
 *   Empty when every score is already consistent.
 */
export function calibrateCohortScores(
	scoresBySubmission: ReadonlyMap<string, Readonly<Record<string, number>>>,
	anchors: ReferenceAnchors,
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
 *
 * @param anchors reference solution facts. REQUIRED (no default): the caller
 *   resolves them from the assignment's scoring config
 *   (data/scoring/<id>.yaml). `null`/undefined → the core receives no anchors
 *   and runs uncalibrated clustering (nothing is flagged without a
 *   reference-fit band). This is deliberate: an assignment without a scoring
 *   config must NEVER inherit another assignment's anchor facts.
 */
export function calibrateCohortFromResults(
	results: ResultsFile,
	outcomes: ReadonlyMap<string, SubmissionExecutionOutcome> = new Map(),
	anchors: ReferenceAnchors | null | undefined = null,
): CalibrationAdjustment[] {
	// No anchors → no reference-fit band → nothing to calibrate against.
	// The caller (runCohortCalibration) skips before reaching here when the
	// scoring config has no anchors; this guard keeps the pure adapter safe
	// for direct callers too (design: an assignment without anchors must
	// never inherit another assignment's facts).
	if (!anchors) {
		return [];
	}
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
	return calibrateCohortScores(scores, anchors, mergedOutcomes);
}

/**
 * Extract per-submission fit metrics from stored executed-cell output.
 *
 * Reads each stored submission's executed cells (`results[sid].cells`, each
 * `{ type, source, output, ... }`), joins the output text of code cells, and
 * parses R²/RMSE with the same canonical patterns post-process.ts uses
 * (see {@link FIT_R2_PATTERN} / {@link FIT_RMSE_PATTERN}). A submission is
 * flagged `bounded` when any code cell source contains explicit parameter
 * bounds (e.g. `bounds=` in a `curve_fit` call).
 *
 * When a scoring config is passed, its compiled `fit_metrics_*` /
 * `bounds_assignment` evidence patterns are used instead of the code
 * constants (single source for the canonical forms, design row 2k).
 *
 * Pure: never mutates `results`. Keys are only present for submissions that
 * exist in the results file; metric fields are absent when not computed.
 *
 * @param results results.json contents — a map keyed by studentId.
 * @param scoringConfig optional scoring config for fit-metric patterns.
 * @returns submissionId → {@link SubmissionExecutionOutcome} for every
 *   stored submission (empty outcome objects for metric-less ones).
 */
export function extractFitMetricsFromResults(
	results: ResultsFile,
	scoringConfig?: { evidencePatterns: ReadonlyMap<string, { regexes: RegExp[] }> } | null,
): Map<string, SubmissionExecutionOutcome> {
	const patterns = fitMetricPatternsFromConfig(scoringConfig);
	const outcomes = new Map<string, SubmissionExecutionOutcome>();
	for (const [submissionId, stored] of Object.entries(results)) {
		outcomes.set(submissionId, extractFitMetricsFromCells(stored.cells ?? [], patterns));
	}
	return outcomes;
}

/**
 * Pure: apply {@link CalibrationAdjustment}s to a scores map by setting
 * `scores[submissionId][dimension] = newScore` for each adjustment, starting
 * from a copy of the input. The input map is never mutated; a new map is
 * returned. Adjustments for submissions absent from `scores` are skipped.
 *
 * @param scores submissionId → dimension scores (the input is NOT mutated).
 * @param adjustments suggested corrections; applied in order, so later
 *   adjustments for the same (submissionId, dimension) pair win.
 * @returns a new map with the adjusted scores applied.
 */
export function applyCalibrationAdjustments(
	scores: Record<string, Record<string, number>>,
	adjustments: CalibrationAdjustment[],
): Record<string, Record<string, number>> {
	const next: Record<string, Record<string, number>> = {};
	for (const [submissionId, dimensions] of Object.entries(scores)) {
		next[submissionId] = { ...dimensions };
	}
	for (const { submissionId, dimension, newScore } of adjustments) {
		const dimensions = next[submissionId];
		if (!dimensions) {
			continue;
		}
		dimensions[dimension] = newScore;
	}
	return next;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** `${submissionId}\0${dimension}` — stable dedupe key for one score cell. */
function adjustKey(submissionId: string, dimension: string): string {
	return `${submissionId}\u0000${dimension}`;
}

/**
 * Parse one stored submission's executed cells into an
 * {@link SubmissionExecutionOutcome}: R²/RMSE come from the joined output
 * text of code cells (same patterns as post-process.ts); `bounded` is true
 * when any code cell source contains explicit parameter bounds (e.g.
 * `bounds=` in a `curve_fit` call). Pure — never mutates `cells`.
 */
function extractFitMetricsFromCells(
	cells: readonly ExecutedCell[],
	patterns: FitMetricPatterns = {
		r2: FIT_R2_PATTERN,
		rmse: FIT_RMSE_PATTERN,
		rmseParen: FIT_RMSE_PAREN_PATTERN,
		bounds: BOUNDS_CODE_PATTERN,
	},
): SubmissionExecutionOutcome {
	const codeCells = cells.filter((cell) => cell.type === "code");
	const outputText = codeCells.map((cell) => cell.output ?? "").join("\n");
	const codeSource = codeCells.map((cell) => cell.source ?? "").join("\n");

	const outcome: SubmissionExecutionOutcome = {};
	const r2 = outputText.match(patterns.r2)?.[1];
	const rmse =
		outputText.match(patterns.rmse)?.[1] ?? outputText.match(patterns.rmseParen)?.[1];
	if (r2 !== undefined) {
		outcome.rSquared = Number.parseFloat(r2);
	}
	if (rmse !== undefined) {
		outcome.rmse = Number.parseFloat(rmse);
	}
	if (patterns.bounds.test(codeSource)) {
		outcome.bounded = true;
	}
	return outcome;
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

	// Only flag when dissenters exist on BOTH sides of the mode. A one-sided
	// distribution (all dissenters above or all below) means the mode is a
	// systematic bias, not a consensus — correcting toward it amplifies the
	// bias. Observed 2026-08-17: after the fit-quality fix, the LLM's
	// scientific_programming scores clustered at 3 (under-score bias) while
	// the correct 4.5-5.5 scores were the dissenters; the old logic dragged
	// the correct scores DOWN to the cluster median, making the gate worse
	// (mean Δ 0.66 → 1.39).
	let below = 0;
	let above = 0;
	for (const { score } of entries) {
		if (score < mode) below++;
		else if (score > mode) above++;
	}
	if (below === 0 || above === 0) {
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
