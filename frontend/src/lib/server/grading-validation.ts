/**
 * @file Shared grading validation helpers.
 *
 * The save route and the teacher-YAML import service both validate grading
 * payloads; these guards live here so the shapes stay in sync.
 *
 * This module runs only on the SvelteKit server (`$lib/server/`).
 */

/** True when value is a plain object mapping string keys to string values. */
export function isStringMap(value: unknown): value is Record<string, string> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	return Object.values(value).every((v) => typeof v === "string");
}

/** True when value is a plain object mapping string keys to finite numbers. */
export function isNumberMap(value: unknown): value is Record<string, number> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	return Object.values(value).every((v) => typeof v === "number" && Number.isFinite(v));
}

/**
 * True when value is an object mapping category keys to v2 CategoryFeedback
 * entries ({ checked: string[], comments: Record<string,string>,
 * deductions: Record<string,number>, notes: string }).
 */
/**
 * Validate a grading-config payload (dimensions + grade_boundaries) against
 * the shape the grade calculator consumes. Returns an error message string,
 * or null when the payload is valid.
 *
 * Used by PUT /api/config/grading (the authoritative guard) so a save with a
 * missing key, empty title, non-positive max_points/weight, or out-of-range
 * min_percentage surfaces as a 400 instead of writing a broken config.
 */
export function validateGradingConfig(value: unknown): string | null {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return "grading config must be an object with 'dimensions' and 'grade_boundaries' arrays";
	}
	const cfg = value as Record<string, unknown>;
	if (!Array.isArray(cfg.dimensions)) {
		return "grading config is missing the 'dimensions' array";
	}
	if (!Array.isArray(cfg.grade_boundaries)) {
		return "grading config is missing the 'grade_boundaries' array";
	}
	if (cfg.dimensions.length === 0) {
		return "grading config needs at least one dimension";
	}
	if (cfg.grade_boundaries.length === 0) {
		return "grading config needs at least one grade boundary";
	}
	const seen = new Set<string>();
	for (const d of cfg.dimensions) {
		if (d === null || typeof d !== "object" || Array.isArray(d)) {
			return "each dimension must be an object with key/title/max_points/weight";
		}
		const dim = d as Record<string, unknown>;
		if (typeof dim.key !== "string" || dim.key.trim().length === 0) {
			return "each dimension needs a non-empty 'key'";
		}
		// Duplicate keys would produce a malformed config (the editor keys its
		// rows by `dim.key`) and corrupt scoring — reject up front.
		const keyNorm = dim.key.trim().toLowerCase();
		if (seen.has(keyNorm)) {
			return `duplicate dimension '${dim.key}'`;
		}
		seen.add(keyNorm);
		if (typeof dim.title !== "string" || dim.title.trim().length === 0) {
			return `dimension '${dim.key}' needs a non-empty 'title'`;
		}
		if (typeof dim.max_points !== "number" || !Number.isFinite(dim.max_points) || dim.max_points <= 0) {
			return `dimension '${dim.key}' needs a positive numeric 'max_points'`;
		}
		if (typeof dim.weight !== "number" || !Number.isFinite(dim.weight) || dim.weight <= 0) {
			return `dimension '${dim.key}' needs a positive numeric 'weight'`;
		}
	}
	for (const b of cfg.grade_boundaries) {
		if (b === null || typeof b !== "object" || Array.isArray(b)) {
			return "each grade boundary must be an object with min_percentage/grade/label/us_equiv";
		}
		const gb = b as Record<string, unknown>;
		if (
			typeof gb.min_percentage !== "number" ||
			!Number.isFinite(gb.min_percentage) ||
			gb.min_percentage < 0 ||
			gb.min_percentage > 100
		) {
			return "each grade boundary needs a numeric 'min_percentage' in 0..100";
		}
		if (typeof gb.grade !== "number" || !Number.isFinite(gb.grade)) {
			return "each grade boundary needs a numeric 'grade'";
		}
		if (typeof gb.label !== "string" || gb.label.trim().length === 0) {
			return "each grade boundary needs a non-empty 'label'";
		}
		if (typeof gb.us_equiv !== "string" || gb.us_equiv.trim().length === 0) {
			return "each grade boundary needs a non-empty 'us_equiv'";
		}
	}
	return null;
}

export function isFeedbackMap(value: unknown): boolean {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	return Object.values(value).every((entry) => {
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
			return false;
		}
		const e = entry as Record<string, unknown>;
		return (
			Array.isArray(e.checked) &&
			e.checked.every((v) => typeof v === "string") &&
			isStringMap(e.comments) &&
			isNumberMap(e.deductions) &&
			typeof e.notes === "string"
		);
	});
}
