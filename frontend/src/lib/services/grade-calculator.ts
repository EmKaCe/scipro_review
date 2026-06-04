/**
 * @file Grade calculator — converts raw dimension scores to weighted percentages
 * and German grades (1.0–5.0 scale).
 *
 * @see .github/references/schemas/grading-config-schema.md
 */

import type {
	GradingConfig,
	GradingInputs,
	GradeResult,
	DimensionResult,
	GradeBoundary,
} from "../types/grading.js";

// ---------------------------------------------------------------------------
// Grade calculation
// ---------------------------------------------------------------------------

/**
 * Calculate the weighted grade result from raw dimension scores.
 *
 * Formula: percentage = (Σ(score_i × weight_i) / Σ(max_i × weight_i)) × 100
 *
 * @param inputs - Raw scores for each dimension (0 to max_points)
 * @param config - Grading configuration with dimensions and boundaries
 * @param deductions - Total point deductions to subtract from the percentage (default: 0)
 * @returns Full grade result with per-dimension breakdown
 */
export function calculateGrade(
	inputs: GradingInputs,
	config: GradingConfig,
	deductions: number = 0,
): GradeResult {
	const dimensions: DimensionResult[] = config.dimensions.map((dim) => {
		const score = Math.max(
			0,
			Math.min(inputs[dim.key as keyof GradingInputs] ?? 0, dim.max_points),
		);
		const weighted_score = score * dim.weight;
		const weighted_max = dim.max_points * dim.weight;
		const percentage = weighted_max > 0 ? (score / dim.max_points) * 100 : 0;

		return {
			dimension: dim,
			score,
			weighted_score,
			weighted_max,
			percentage,
		};
	});

	const total_weighted = dimensions.reduce((sum, d) => sum + d.weighted_score, 0);
	const total_weighted_max = dimensions.reduce((sum, d) => sum + d.weighted_max, 0);

	// Apply deductions to the raw percentage
	const raw_percentage = total_weighted_max > 0 ? (total_weighted / total_weighted_max) * 100 : 0;
	const percentage = Math.max(0, raw_percentage - deductions);

	// Find the matching grade boundary
	const boundary = getGradeBoundary(percentage, config.grade_boundaries);

	// Calculate points to next grade and points above current boundary
	const nextBoundary = getNextBoundary(percentage, config.grade_boundaries);
	const points_to_next_grade = nextBoundary ? nextBoundary.min_percentage - percentage : null;
	const points_above_boundary = percentage - boundary.min_percentage;

	return {
		dimensions,
		total_weighted,
		total_weighted_max,
		percentage,
		grade: boundary.grade,
		label: boundary.label,
		us_equiv: boundary.us_equiv,
		points_to_next_grade,
		points_above_boundary,
	};
}

// ---------------------------------------------------------------------------
// Grade boundary lookup
// ---------------------------------------------------------------------------

/**
 * Find the grade boundary for a given percentage.
 *
 * Boundaries are sorted by min_percentage descending.
 * The first boundary with min_percentage <= percentage is the match.
 *
 * @param percentage - Weighted percentage (0–100)
 * @param boundaries - Grade boundaries sorted by min_percentage descending
 * @returns The matching grade boundary, or the lowest (5.0 F) if none match
 */
export function getGradeBoundary(
	percentage: number,
	boundaries: readonly GradeBoundary[],
): GradeBoundary {
	for (const boundary of boundaries) {
		if (percentage >= boundary.min_percentage) {
			return boundary;
		}
	}
	// Fallback to the lowest boundary (5.0 F)
	return boundaries[boundaries.length - 1];
}

/**
 * Find the next better grade boundary above the current percentage.
 *
 * Returns the boundary with the smallest min_percentage that is still
 * greater than the current percentage (i.e., the closest boundary above).
 *
 * @param percentage - Weighted percentage (0–100)
 * @param boundaries - Grade boundaries sorted by min_percentage descending
 * @returns The next better boundary, or null if already at the top
 */
function getNextBoundary(
	percentage: number,
	boundaries: readonly GradeBoundary[],
): GradeBoundary | null {
	// Find the boundary with the smallest min_percentage that is still > percentage
	let nextBoundary: GradeBoundary | null = null;
	for (const boundary of boundaries) {
		if (boundary.min_percentage > percentage) {
			if (nextBoundary === null || boundary.min_percentage < nextBoundary.min_percentage) {
				nextBoundary = boundary;
			}
		}
	}
	return nextBoundary;
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/**
 * Create default grading inputs with all scores set to 0.
 *
 * @param config - Grading configuration (used to determine dimension keys)
 * @returns GradingInputs with all dimensions set to 0
 */
export function defaultGradingInputsFromConfig(config: GradingConfig): GradingInputs {
	const inputs: Record<string, number> = {};
	for (const dim of config.dimensions) {
		inputs[dim.key as string] = 0;
	}
	return inputs as unknown as GradingInputs;
}
