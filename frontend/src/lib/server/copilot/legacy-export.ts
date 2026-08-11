/**
 * @file Convert pre-evaluation results into Karl-form grading JSON.
 *
 * Karl's peer-review form (karlkirschner.github.io/scipro_assignments_grading)
 * populates elements via `document.getElementById(key)`: a grading JSON
 * uploaded to the form must use Karl's exact element IDs as keys, and every
 * value must be the string the form expects ("checked" for checkboxes, the
 * score string for grading sliders, free text for textareas). A single
 * mismatched key is silently ignored by the form — never emitted.
 *
 * This module turns a pre-evaluation result (dimension scores, rubric
 * selections, additional notes) into that flat JSON:
 *   - 5 grading slider keys, e.g. "codequality-grading": "4.5"
 *   - N checkbox keys built via buildKarlId(...) → "checked"
 *   - one textarea key per category that has notes (prefix + "-textarea",
 *     incl. "general-textarea" for general_feedback)
 *   - one "evaluation-textbox" summary (grade, weighted %, key findings)
 *
 * The grade applies Karl's weighted formula
 *   weighted = CQD×4 + CER×4 + AR×4 + SP×4 + CR×1  (max 100)
 * and maps it to the grade scale required by the pre-eval spec (≥95 → 1.0,
 * ≥90 → 1.3, ≥85 → 1.7, ≥80 → 2.0, ≥75 → 2.3, ≥70 → 2.7, below 70 → 3.0).
 * Note: data/grading_config.yaml carries a finer-grained boundary table for
 * the app's own grade display; the export deliberately uses the simpler
 * Karl-form scale above.
 *
 * This module runs only on the SvelteKit server (`$lib/server/`).
 */

import { loadCriteriaFile } from "$lib/server/criteria";
import { buildKarlId } from "$lib/server/criteria/legacy-catalog";
import type { Category, Sentiment } from "$lib/types/criteria";

// ---------------------------------------------------------------------------
// Dimension mapping
// ---------------------------------------------------------------------------

/** Internal dimension key → Karl form slider element ID. */
const KARL_SLIDER_KEYS: Readonly<Record<string, string>> = {
	code_quality_design: "codequality-grading",
	code_execution_results: "codeexecution-grading",
	assignment_requirements: "assignmentrequirements-grading",
	scientific_programming: "scientific-grading",
	creativity: "creativity-grading",
};

/** Weight of each dimension in Karl's weighted grade formula (×4 ×4 ×4 ×4 ×1). */
const DIMENSION_WEIGHTS: Readonly<Record<string, number>> = {
	code_quality_design: 4,
	code_execution_results: 4,
	assignment_requirements: 4,
	scientific_programming: 4,
	creativity: 1,
};

/** Human-readable dimension titles (from data/grading_config.yaml) for the summary. */
const DIMENSION_LABELS: Readonly<Record<string, string>> = {
	code_quality_design: "Code Quality & Design",
	code_execution_results: "Code Execution & Results",
	assignment_requirements: "Assignment Requirements",
	scientific_programming: "Scientific Programming",
	creativity: "Creativity",
};

/** Sentiment sections searched in order (first match wins). */
const SENTIMENTS: readonly Sentiment[] = ["positive", "neutral", "negative"];

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

/** One checked rubric item: the category and the sub-point text (optionKey). */
export interface KarlRubricSelection {
	/** Internal category key, e.g. "code_formatting". */
	categoryKey: string;
	/** Sub-point text as it appears verbatim in the criteria YAML. */
	optionKey: string;
}

/** Options for {@link generateKarlJson}. */
export interface GenerateKarlJsonOptions {
	/** Student ID, e.g. "2026SS_00" (included in the summary). */
	submissionId: string;
	/** Dimension scores keyed by internal dimension key (creativity max 4, others max 6). */
	dimensions: Record<string, number>;
	/** Checked rubric items (may be empty). */
	rubricSelections: readonly KarlRubricSelection[];
	/** Free-text notes per category key (may be empty). */
	additionalNotes: Record<string, string>;
	/** Criteria YAML paths from the assignment registry, e.g. ["data/criteria/general.yaml"]. */
	criteriaFiles: readonly string[];
}

// ---------------------------------------------------------------------------
// Weighted grade formula
// ---------------------------------------------------------------------------

/**
 * Karl's weighted score: CQD×4 + CER×4 + AR×4 + SP×4 + CR×1, capped at 100.
 *
 * With the grading config's maxima (6/6/6/6/4) the formula's natural maximum
 * is exactly 100; the clamp only guards out-of-range input.
 */
export function weightedPercentage(dimensions: Record<string, number>): number {
	let total = 0;
	for (const [key, weight] of Object.entries(DIMENSION_WEIGHTS)) {
		total += (dimensions[key] ?? 0) * weight;
	}
	return Math.min(100, Math.max(0, total));
}

/** Map a weighted percentage to the grade scale used for the Karl export. */
export function karlGrade(weighted: number): number {
	if (weighted >= 95) return 1.0;
	if (weighted >= 90) return 1.3;
	if (weighted >= 85) return 1.7;
	if (weighted >= 80) return 2.0;
	if (weighted >= 75) return 2.3;
	if (weighted >= 70) return 2.7;
	return 3.0;
}

// ---------------------------------------------------------------------------
// Criteria loading & lookup
// ---------------------------------------------------------------------------

/** Load and merge all criteria files into a single category map (later files win). */
async function loadCategoryIndex(
	criteriaFiles: readonly string[],
): Promise<Record<string, Category>> {
	const index: Record<string, Category> = {};
	for (const filePath of criteriaFiles) {
		const file = await loadCriteriaFile(filePath);
		if (!file) continue;
		for (const [key, category] of Object.entries(file.categories)) {
			index[key] = category;
		}
	}
	return index;
}

/** Match a sub-point text to its sentiment and main-point group (first match wins). */
function findSentimentAndMainPointInCategory(
	category: Category,
	optionKey: string,
): { sentiment: Sentiment; mainPoint: string } | null {
	for (const sentiment of SENTIMENTS) {
		for (const mainPoint of category[sentiment]) {
			if (mainPoint.sub_points.some((sp) => sp.text === optionKey)) {
				return { sentiment, mainPoint: mainPoint.main_point };
			}
		}
	}
	return null;
}

/**
 * Load the criteria files and find which sentiment and main-point group
 * contains the given sub-point text (optionKey).
 *
 * Returns null when the category or the sub-point text is not found.
 */
export async function findSentimentAndMainPoint(
	criteriaFiles: readonly string[],
	categoryKey: string,
	optionKey: string,
): Promise<{ sentiment: Sentiment; mainPoint: string } | null> {
	const index = await loadCategoryIndex(criteriaFiles);
	const category = index[categoryKey];
	if (!category) return null;
	return findSentimentAndMainPointInCategory(category, optionKey);
}

// ---------------------------------------------------------------------------
// Karl prefix (derived via buildKarlId)
// ---------------------------------------------------------------------------

const MAIN_POINT_SENTINEL = "__main_point__";
const SUB_POINT_SENTINEL = "__sub_point__";

/**
 * Derive the Karl element-ID prefix for a category key using only
 * buildKarlId — the category→prefix mapping itself is internal to
 * legacy-catalog. buildKarlId returns "prefix-sentiment-mainPoint-subPoint",
 * so stripping the known suffix of a sentinel call yields the prefix.
 */
function karlPrefixFor(categoryKey: string): string {
	const id = buildKarlId(categoryKey, "positive", MAIN_POINT_SENTINEL, SUB_POINT_SENTINEL);
	const suffix = `-positive-${MAIN_POINT_SENTINEL}-${SUB_POINT_SENTINEL}`;
	if (!id.endsWith(suffix)) {
		throw new Error(
			`legacy-catalog produced unexpected ID "${id}" — cannot derive prefix for "${categoryKey}"`,
		);
	}
	return id.slice(0, -suffix.length);
}

// ---------------------------------------------------------------------------
// Evaluation summary
// ---------------------------------------------------------------------------

/** Build the "evaluation-textbox" summary paragraph (grade, weighted %, key findings). */
function buildEvaluationTextbox(opts: {
	submissionId: string;
	grade: number;
	weighted: number;
	dimensions: Record<string, number>;
	rubricSelections: readonly KarlRubricSelection[];
	additionalNotes: Record<string, string>;
}): string {
	const dimensionSummary = Object.entries(KARL_SLIDER_KEYS)
		.map(
			([dimKey]) =>
				`${DIMENSION_LABELS[dimKey] ?? dimKey} ${(opts.dimensions[dimKey] ?? 0).toFixed(1)}`,
		)
		.join(", ");

	const lines = [
		`Submission ${opts.submissionId}: Grade ${opts.grade.toFixed(1)} (${opts.weighted.toFixed(1)}% weighted).`,
		`Dimensions: ${dimensionSummary}.`,
		`Rubric: ${opts.rubricSelections.length} item(s) checked.`,
	];

	if (opts.rubricSelections.length > 0) {
		const counts = new Map<string, number>();
		for (const selection of opts.rubricSelections) {
			counts.set(selection.categoryKey, (counts.get(selection.categoryKey) ?? 0) + 1);
		}
		lines.push(
			`Checked: ${[...counts.entries()].map(([key, n]) => `${key} (${n})`).join(", ")}.`,
		);
	}

	const notes = Object.entries(opts.additionalNotes);
	if (notes.length > 0) {
		lines.push("Key findings:");
		for (const [categoryKey, note] of notes) {
			lines.push(`- ${categoryKey}: ${note}`);
		}
	}

	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Convert pre-evaluation results into the flat Karl-form JSON object.
 *
 * Every key is either a Karl element ID (checkbox via buildKarlId, slider,
 * textarea, evaluation-textbox) and every value is the string Karl's form
 * expects. Throws when a rubric selection cannot be matched to the criteria
 * YAML or references an unknown category — failing loudly beats emitting a
 * key the form would silently drop.
 */
export async function generateKarlJson(
	options: GenerateKarlJsonOptions,
): Promise<Record<string, string>> {
	const { submissionId, dimensions, rubricSelections, additionalNotes, criteriaFiles } = options;

	const weighted = weightedPercentage(dimensions);
	const grade = karlGrade(weighted);

	const output: Record<string, string> = {};

	// 5 grading slider keys — always emitted, values as score strings.
	for (const [dimKey, karlKey] of Object.entries(KARL_SLIDER_KEYS)) {
		output[karlKey] = (dimensions[dimKey] ?? 0).toFixed(1);
	}

	// Checkbox keys for rubric selections.
	const categoryIndex = await loadCategoryIndex(criteriaFiles);
	for (const selection of rubricSelections) {
		const category = categoryIndex[selection.categoryKey];
		if (!category) {
			throw new Error(
				`Rubric selection references unknown category "${selection.categoryKey}" — not found in the criteria files`,
			);
		}
		const match = findSentimentAndMainPointInCategory(category, selection.optionKey);
		if (!match) {
			throw new Error(
				`Rubric option "${selection.optionKey}" not found in category "${selection.categoryKey}"`,
			);
		}
		const id = buildKarlId(
			selection.categoryKey,
			match.sentiment,
			match.mainPoint,
			selection.optionKey,
		);
		output[id] = "checked";
	}

	// Textarea keys for categories that carry notes (general_feedback → "general-textarea").
	for (const [categoryKey, note] of Object.entries(additionalNotes)) {
		output[`${karlPrefixFor(categoryKey)}-textarea`] = note;
	}

	// Summary textarea.
	output["evaluation-textbox"] = buildEvaluationTextbox({
		submissionId,
		grade,
		weighted,
		dimensions,
		rubricSelections,
		additionalNotes,
	});

	return output;
}
