/**
 * @file Session state types representing an in-progress review.
 *
 * These types are MUTABLE — they represent the grader's live selections
 * before the review is finalized and exported as an Evaluation.
 *
 * Contrast with types/evaluation.ts which represents the immutable output.
 *
 * @see .github/references/schemas/typescript-schema.md
 */

import type { CategoryKey } from "./criteria.js";
import type { GradingInputs } from "./grading.js";

// ---------------------------------------------------------------------------
// Category selection state
// ---------------------------------------------------------------------------

/**
 * Selection state for a single rubric category.
 *
 * Uses Set<string> for O(1) lookup when toggling checkboxes.
 * The strings are sub-point `text` values.
 */
export interface CategorySelections {
	/** Set of checked sub-point texts. */
	checked_items: Set<string>;
	/** Free-text additional notes. */
	notes: string;
	/** Inline comments keyed by sub-point text. */
	comments: Record<string, string>;
	/** Point deductions keyed by sub-point text. */
	deductions: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Review session
// ---------------------------------------------------------------------------

/**
 * Complete in-progress review session.
 *
 * This is the mutable working state that gets persisted to IndexedDB
 * on every change. When finalized, it's converted to an immutable Evaluation.
 */
export interface ReviewSession {
	/** Student identifier. */
	student_id: string;
	/** Assignment key. */
	assignment_id: string;
	/** Review mode (for backward compatibility with persisted sessions). */
	mode: string;
	/** Per-category selections keyed by category key. */
	category_selections: Record<CategoryKey, CategorySelections>;
	/** Raw scores for each grading dimension. */
	grading: GradingInputs;
	/** Generated evaluation text (Markdown). */
	generated_text: string;
	/** Free-text feedback notes (top-level, teacher-written; optional). */
	notes?: string;
	/** ISO timestamp when the session was started. */
	started_at: string;
	/** ISO timestamp of the last update. */
	updated_at: string;
}

// ---------------------------------------------------------------------------
// Conversion: Session → Evaluation
// ---------------------------------------------------------------------------

/**
 * Convert category selections to category feedback (immutable output).
 *
 * This is called when the grader finalizes the review.
 */
export function categorySelectionsToFeedback(selections: CategorySelections): {
	checked: string[];
	comments: Record<string, string>;
	deductions: Record<string, number>;
	notes: string;
} {
	return {
		checked: [...selections.checked_items],
		comments: { ...selections.comments },
		deductions: { ...selections.deductions },
		notes: selections.notes,
	};
}
