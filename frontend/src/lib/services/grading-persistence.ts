/**
 * @file Serialization between live rubric selections and the persisted v2
 * feedback shape.
 *
 * The grading record stores per-category feedback in the immutable
 * `CategoryFeedback` shape (arrays — JSON-friendly). The review UI works
 * with mutable `CategorySelections` (Sets for O(1) checkbox toggling).
 * These helpers convert between the two losslessly.
 *
 * @see frontend/src/lib/types/evaluation.ts — CategoryFeedback
 * @see frontend/src/lib/types/session.ts — CategorySelections
 */

import type { CategoryFeedback } from "$lib/types/evaluation.js";
import type { CategorySelections } from "$lib/types/session.js";

/** Convert live category selections into the persisted feedback shape. */
export function selectionsToFeedback(
	selections: Record<string, CategorySelections>,
): Record<string, CategoryFeedback> {
	const out: Record<string, CategoryFeedback> = {};
	for (const [key, sel] of Object.entries(selections)) {
		out[key] = {
			checked: [...sel.checked_items],
			comments: { ...sel.comments },
			deductions: { ...sel.deductions },
			notes: sel.notes,
		};
	}
	return out;
}

/**
 * Restore category selections from a persisted feedback block.
 *
 * Only keys present in `categoryKeys` (the rubric's actual categories) are
 * restored — stale or unknown keys are dropped. Missing categories default
 * to empty selections.
 */
export function feedbackToSelections(
	feedback: Record<string, CategoryFeedback> | undefined,
	categoryKeys: readonly string[],
): Record<string, CategorySelections> {
	const out: Record<string, CategorySelections> = {};
	for (const key of categoryKeys) {
		const fb = feedback?.[key];
		out[key] = {
			checked_items: new Set(fb?.checked ?? []),
			comments: { ...(fb?.comments ?? {}) },
			deductions: { ...(fb?.deductions ?? {}) },
			notes: fb?.notes ?? "",
		};
	}
	return out;
}
