/**
 * @file Rubric criteria data models loaded from YAML files.
 *
 * These types represent READ-ONLY configuration data that defines the rubric.
 * They are loaded from criteria/*.yaml and never mutated.
 *
 * @see .github/references/schemas/criteria-schema.md
 */

import type { CategorySelections } from "./session.js";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Sentiment direction of a feedback item. */
export type Sentiment = "positive" | "neutral" | "negative";

/**
 * Branded category key — a snake_case string identifying a rubric category.
 *
 * Use `parseCategoryKey()` to create from untrusted input, or
 * `categoryKeyOf()` for known-literal values.
 */
export type CategoryKey = string & { readonly __brand: "CategoryKey" };

/** Create a CategoryKey from an untrusted string. Trims whitespace. */
export function parseCategoryKey(value: string): CategoryKey {
	return value.trim() as CategoryKey;
}

/** Create a CategoryKey from a known-literal value (no validation). */
export function categoryKeyOf(value: string): CategoryKey {
	return value as unknown as CategoryKey;
}

// ---------------------------------------------------------------------------
// Sub-point
// ---------------------------------------------------------------------------

/** A single selectable checkbox item under a main point. */
export interface SubPoint {
	/** Display text shown to the grader. */
	readonly text: string;
	/** When true, selecting this item reveals a comment textarea. */
	readonly comment?: boolean;
	/** When true, selecting this item reveals a numeric deduction input. */
	readonly point_deduction?: boolean;
	/**
	 * Grading dimensions this sub-point contributes to (sub-point override;
	 * see {@link resolveSubPointDimensions} for the override??group??[] rule).
	 */
	readonly dimensions?: readonly string[];
}

// ---------------------------------------------------------------------------
// Main point
// ---------------------------------------------------------------------------

/** A group heading with its selectable sub-points. */
export interface MainPoint {
	/** Heading text. Empty string `""` for ungrouped items. */
	readonly main_point: string;
	/** Selectable checkbox items under this heading. */
	readonly sub_points: readonly SubPoint[];
	/**
	 * Default grading dimensions for all sub-points in this group (inherited
	 * unless a sub-point carries its own override — see
	 * {@link resolveSubPointDimensions}).
	 */
	readonly dimensions?: readonly string[];
}

// ---------------------------------------------------------------------------
// Category
// ---------------------------------------------------------------------------

/** A rubric category containing positive, neutral, and negative feedback. */
export interface Category {
	/** Human-readable title (e.g., "Code Formatting"). */
	readonly title: string;
	/** Whether a free-text notes textarea is shown for this category. */
	readonly additional_notes: boolean;
	/** Positive feedback groups. May be empty. */
	readonly positive: readonly MainPoint[];
	/** Neutral feedback groups. May be empty. */
	readonly neutral: readonly MainPoint[];
	/** Negative feedback groups. May be empty. */
	readonly negative: readonly MainPoint[];
}

// ---------------------------------------------------------------------------
// Criteria file
// ---------------------------------------------------------------------------

/**
 * Top-level structure of a criteria YAML file.
 *
 * Both `general.yaml` and assignment-specific files use this format.
 * The `categories` map is keyed by `CategoryKey`.
 */
export interface CriteriaFile {
	/** Rubric categories keyed by snake_case identifier. */
	readonly categories: Readonly<Record<string, Category>>;
}

// ---------------------------------------------------------------------------
// Merged rubric
// ---------------------------------------------------------------------------

/**
 * The complete rubric for an assignment, after merging general + specific.
 *
 * Categories are ordered: general first, then assignment-specific.
 */
export interface MergedRubric {
	/** Ordered categories for the selected assignment. */
	readonly categories: readonly CategoryEntry[];
}

/** A category entry in the merged rubric, pairing key with data. */
export interface CategoryEntry {
	/** Snake_case category identifier. */
	readonly key: CategoryKey;
	/** Category data. */
	readonly category: Category;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a sub-point's grading dimensions: override ?? group default ?? [].
 * Override REPLACES, never merges.
 *
 * PLAN_PHASE_BY_TOOL mirror rule — keep the two call sites in sync: a
 * client-side twin lives in criteria-editor-model.ts (resolveEditableSubPointDimensions);
 * both must implement the same override ?? group ?? [] semantics.
 */
export function resolveSubPointDimensions(
	mainPoint: MainPoint,
	subPoint: SubPoint,
): readonly string[] {
	return subPoint.dimensions ?? mainPoint.dimensions ?? [];
}

/** Checked-item counts per sentiment (P3-2, rubric tab header). */
export interface SentimentCounts {
	positive: number;
	neutral: number;
	negative: number;
}

/**
 * Count the checked rubric items per sentiment from live checkbox state.
 *
 * Checked item keys are sub-point `text` values (see CategorySelections);
 * the texts are matched against each category's positive/neutral/negative
 * groups. Live — re-derives whenever the selections change.
 */
export function rubricSentimentCounts(
	rubric: MergedRubric | null,
	categorySelections: Record<string, CategorySelections>,
): SentimentCounts {
	const counts: SentimentCounts = { positive: 0, neutral: 0, negative: 0 };
	if (!rubric) return counts;

	for (const entry of rubric.categories) {
		const selections = categorySelections[entry.key];
		if (!selections || selections.checked_items.size === 0) continue;
		for (const sentiment of ["positive", "neutral", "negative"] as const) {
			const texts = new Set<string>();
			for (const mp of entry.category[sentiment]) {
				for (const sp of mp.sub_points) texts.add(sp.text);
			}
			for (const key of selections.checked_items) {
				if (texts.has(key)) counts[sentiment]++;
			}
		}
	}
	return counts;
}

/** All sub-points in a category, across all sentiments. */
export function allSubPoints(category: Category): readonly SubPoint[] {
	return [
		...category.positive.flatMap((mp) => mp.sub_points),
		...category.neutral.flatMap((mp) => mp.sub_points),
		...category.negative.flatMap((mp) => mp.sub_points),
	];
}

/** All main points in a category for a given sentiment. */
export function mainPointsFor(category: Category, sentiment: Sentiment): readonly MainPoint[] {
	return category[sentiment];
}

/**
 * Find the rubric category whose sub-points contain the given text
 * (null when absent).
 */
export function findCategoryEntry(
	rubric: MergedRubric | null,
	subPointText: string,
): CategoryEntry | null {
	if (!rubric) return null;
	return (
		rubric.categories.find((entry) =>
			(["positive", "neutral", "negative"] as const).some((sentiment) =>
				entry.category[sentiment].some((mp) =>
					mp.sub_points.some((sp) => sp.text === subPointText),
				),
			),
		) ?? null
	);
}

/** Whether any sub-point in the category has `comment: true`. */
export function hasCommentItems(category: Category): boolean {
	return allSubPoints(category).some((sp) => sp.comment === true);
}

/** Whether any sub-point in the category has `point_deduction: true`. */
export function hasDeductionItems(category: Category): boolean {
	return allSubPoints(category).some((sp) => sp.point_deduction === true);
}
