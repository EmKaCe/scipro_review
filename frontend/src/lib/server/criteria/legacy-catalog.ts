/**
 * @file Mapping from internal rubric category keys to the legacy grading form's element-ID
 * prefixes, plus buildLegacyId() — the helper that assembles full legacy form element
 * IDs for rubric checkboxes.
 *
 * the downstream peer-review grading form (karlkirschner.github.io/scipro_assignments_grading) builds
 * checkbox IDs at runtime (functions/generate.js line 96):
 *   id = category + "-" + sentiment + "-" + mainPoint + "-" + subPoint
 * where `category` is the camelCase prefix below and sentiment/mainPoint/
 * subPoint are preserved VERBATIM — spaces, typos, punctuation, and double
 * spaces are all part of the ID. This module runs only on the SvelteKit
 * server (`$lib/server/`).
 */

/**
 * Internal snake_case rubric category key → the legacy form's camelCase element-ID
 * prefix. Exactly 14 entries; provenance: the downstream form's criteria JSONs
 * (general.json, scipy_sklearn_soil.json, user_function.json,
 * plotting_data.json) via the generate.js ID rule.
 */
export const LEGACY_CATEGORY_PREFIXES: Readonly<Record<string, string>> = {
	code_formatting: "codeFormatting",
	coding_concept: "codingConcept",
	jupyter_notebooks: "jupyterNotebooks",
	academic_scholarship: "academicScholarship",
	following_instructions: "followingInstructions",
	general_feedback: "general",
	pandas: "Pandas",
	numpy: "NumPy",
	scipy: "SciPy",
	sklearn: "sklearn",
	genai: "GenAI",
	user_defined_functions: "userDefinedFunctions",
	function_calling: "callingFunction",
	plotting_visualization: "plotting",
};

/** The 14 internal category keys supported by the mapping above. */
export type LegacyCategoryKey = keyof typeof LEGACY_CATEGORY_PREFIXES;

/**
 * Assemble a legacy form element ID for a rubric checkbox.
 *
 * Format: `legacyPrefix + "-" + sentiment + "-" + mainPoint + "-" + subPoint`
 * (generate.js line 96), where legacyPrefix is looked up from
 * LEGACY_CATEGORY_PREFIXES.
 *
 * Raw text is preserved verbatim — NO cleaning, NO normalization. Spaces,
 * typos, and punctuation are all part of the ID, so the generated key
 * matches the form's `getElementById()` lookup exactly.
 *
 * Throws for an unknown category key so a typo fails loudly instead of
 * emitting a silently-broken ID that the legacy grading form would reject on upload.
 */
export function buildLegacyId(
	categoryKey: string,
	sentiment: string,
	mainPoint: string,
	subPoint: string,
): string {
	const prefix = LEGACY_CATEGORY_PREFIXES[categoryKey];
	if (prefix === undefined) {
		throw new Error(`Unknown rubric category key: "${categoryKey}"`);
	}
	return `${prefix}-${sentiment}-${mainPoint}-${subPoint}`;
}
