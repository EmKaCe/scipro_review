/**
 * @file Rubric criteria data models loaded from YAML files.
 *
 * These types represent READ-ONLY configuration data that defines the rubric.
 * They are loaded from criteria/*.yaml and never mutated.
 *
 * @see .github/references/schemas/criteria-schema.md
 */

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

/** Whether any sub-point in the category has `comment: true`. */
export function hasCommentItems(category: Category): boolean {
	return allSubPoints(category).some((sp) => sp.comment === true);
}

/** Whether any sub-point in the category has `point_deduction: true`. */
export function hasDeductionItems(category: Category): boolean {
	return allSubPoints(category).some((sp) => sp.point_deduction === true);
}
