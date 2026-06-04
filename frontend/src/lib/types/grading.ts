/**
 * @file Grading configuration, dimension keys, score inputs, and grade results.
 *
 * Config types are READ-ONLY (loaded from grading_config.yaml).
 * Input and result types are mutable (grader enters scores, app computes results).
 *
 * @see .github/references/schemas/grading-config-schema.md
 */

// ---------------------------------------------------------------------------
// Dimension keys (branded union)
// ---------------------------------------------------------------------------

/**
 * Branded dimension key — identifies a grading dimension.
 *
 * Known values: code_quality_design, code_execution_results,
 * assignment_requirements, scientific_programming, creativity.
 */
export type DimensionKey = string & { readonly __brand: "DimensionKey" };

/** Create a DimensionKey from an untrusted string. */
export function parseDimensionKey(value: string): DimensionKey {
	return value.trim() as DimensionKey;
}

/** Create a DimensionKey from a known-literal value. */
export function dimensionKeyOf(value: string): DimensionKey {
	return value as unknown as DimensionKey;
}

// ---------------------------------------------------------------------------
// Configuration (read-only)
// ---------------------------------------------------------------------------

/** A single grading dimension from the configuration. */
export interface GradeDimension {
	/** Snake_case identifier (e.g., "code_quality_design"). */
	readonly key: DimensionKey;
	/** Display label (e.g., "Code Quality & Design"). */
	readonly title: string;
	/** Maximum raw score (typically 6.0 or 4.0). */
	readonly max_points: number;
	/** Weight multiplier for percentage calculation. */
	readonly weight: number;
}

/** A grade boundary in the German grading scale. */
export interface GradeBoundary {
	/** Lower bound (inclusive) of the percentage range. */
	readonly min_percentage: number;
	/** German grade value (1.0 = best, 5.0 = fail). */
	readonly grade: number;
	/** Descriptive label (e.g., "excellent", "good"). */
	readonly label: string;
	/** US letter-grade equivalent (e.g., "A+", "B-"). */
	readonly us_equiv: string;
}

/** Full grading configuration parsed from grading_config.yaml. */
export interface GradingConfig {
	/** Ordered list of grading dimensions. */
	readonly dimensions: readonly GradeDimension[];
	/** Grade boundaries sorted by min_percentage descending. */
	readonly grade_boundaries: readonly GradeBoundary[];
}

// ---------------------------------------------------------------------------
// Score inputs (mutable — grader enters these)
// ---------------------------------------------------------------------------

/**
 * Raw scores entered by the grader for each dimension.
 *
 * Keys match `GradeDimension.key`. Values are numbers in [0, max_points].
 */
export interface GradingInputs {
	code_quality_design: number;
	code_execution_results: number;
	assignment_requirements: number;
	scientific_programming: number;
	creativity: number;
}

// ---------------------------------------------------------------------------
// Computed results (derived from inputs + config)
// ---------------------------------------------------------------------------

/** A single dimension enriched with computed scores. */
export interface DimensionResult {
	/** The dimension definition. */
	readonly dimension: GradeDimension;
	/** Raw score entered by the grader. */
	readonly score: number;
	/** Score × weight. */
	readonly weighted_score: number;
	/** Maximum possible weighted score (max_points × weight). */
	readonly weighted_max: number;
	/** Percentage for this dimension alone (0–100). */
	readonly percentage: number;
}

/** Computed grade result returned by the calculator. */
export interface GradeResult {
	/** Per-dimension breakdown. */
	readonly dimensions: readonly DimensionResult[];
	/** Sum of all weighted scores. */
	readonly total_weighted: number;
	/** Sum of all weighted maxes (= 100 for standard config). */
	readonly total_weighted_max: number;
	/** Overall percentage (0–100). */
	readonly percentage: number;
	/** German grade (1.0–5.0). */
	readonly grade: number;
	/** US letter-grade equivalent. */
	readonly label: string;
	/** US letter-grade equivalent (e.g., "A+", "B-"). */
	readonly us_equiv: string;
	/** Points needed to reach the next better grade band. Null at 1.0. */
	readonly points_to_next_grade: number | null;
	/** Points above the current grade boundary. */
	readonly points_above_boundary: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create default grading inputs with all scores set to 0. */
export function defaultGradingInputs(): GradingInputs {
	return {
		code_quality_design: 0,
		code_execution_results: 0,
		assignment_requirements: 0,
		scientific_programming: 0,
		creativity: 0,
	};
}

/** Compute the weight percentage for a dimension (for display). */
export function weightPercentage(
	dimension: GradeDimension,
	all: readonly GradeDimension[],
): number {
	const totalWeight = all.reduce((sum, d) => sum + d.max_points * d.weight, 0);
	return totalWeight > 0 ? ((dimension.max_points * dimension.weight) / totalWeight) * 100 : 0;
}
