/**
 * @file Mapping from internal rubric category keys to Karl's form element-ID
 * prefixes, plus buildKarlId() — the helper that assembles full Karl element
 * IDs for rubric checkboxes.
 *
 * Karl's form (karlkirschner.github.io/scipro_assignments_grading) builds
 * checkbox IDs at runtime (functions/generate.js line 96):
 *   id = category + "-" + sentiment + "-" + mainPoint + "-" + subPoint
 * where `category` is the camelCase prefix below and sentiment/mainPoint/
 * subPoint are preserved VERBATIM — spaces, typos, punctuation, and double
 * spaces are all part of the ID. This module runs only on the SvelteKit
 * server (`$lib/server/`).
 */

/**
 * Internal snake_case rubric category key → Karl's camelCase element-ID
 * prefix. Exactly 14 entries; provenance: Karl's criteria JSONs
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
export type KarlCategoryKey = keyof typeof LEGACY_CATEGORY_PREFIXES;

/**
 * Assemble a Karl form element ID for a rubric checkbox.
 *
 * Format: `karlPrefix + "-" + sentiment + "-" + mainPoint + "-" + subPoint`
 * (generate.js line 96), where karlPrefix is looked up from
 * LEGACY_CATEGORY_PREFIXES.
 *
 * Raw text is preserved verbatim — NO cleaning, NO normalization. Spaces,
 * typos, and punctuation are all part of the ID, so the generated key
 * matches the form's `getElementById()` lookup exactly.
 *
 * Throws for an unknown category key so a typo fails loudly instead of
 * emitting a silently-broken ID that Karl's form would reject on upload.
 */
export function buildKarlId(
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
