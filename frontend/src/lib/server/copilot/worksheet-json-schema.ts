/**
 * @file Phase 2b worksheet OUTPUT schema — Zod validation for the JSON the
 * model returns for each worksheet batch call.
 *
 * The worksheet batch calls keep the markdown worksheet as INPUT (the visible
 * un-checked negatives are context the model needs), but the OUTPUT is JSON
 * instead of filled markdown. This schema is the contract for that output:
 *
 *   {
 *     "categories": {
 *       "<categoryKey>": {
 *         "overall": "GOOD" | "OKAY" | "POOR" | "N/A",
 *         "checked": [
 *           { "item": "<exact rubric sub-point text>",
 *             "evidence": "<1-sentence citation of a pre-analysis fact>" }
 *         ],
 *         "notes": "<1-3 sentences for the teacher>"
 *       }
 *     }
 *   }
 *
 * Validation rules enforced at parse time:
 *   1. overall "N/A" ⇒ the checked array MUST be empty (length 0)
 *   2. No duplicate item strings within one category's checked array
 *   3. Both item and evidence must be non-empty strings
 *   4. notes must be a non-empty string
 *
 * Standalone module — no server-only imports, safe to unit test directly.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/** One checked rubric item plus its evidence citation. */
export const worksheetCheckedItemSchema = z.object({
	/** Exact sub-point text from the rubric, copied verbatim. */
	item: z.string().trim().min(1, "checked item text must be a non-empty string"),
	/** One-sentence citation of a specific, verifiable pre-analysis fact. */
	evidence: z.string().trim().min(1, "evidence must be a non-empty string"),
});

/** One category's worksheet verdict. */
export const worksheetCategoryResultSchema = z.object({
	/** Overall quality verdict for the category. */
	overall: z.enum(["GOOD", "OKAY", "POOR", "N/A"]),
	/** Sub-points checked for this category (empty for N/A). */
	checked: z.array(worksheetCheckedItemSchema),
	/** 1-3 sentences of teacher-facing notes, grounded in evidence. */
	notes: z.string().trim().min(1, "notes must be a non-empty string"),
});

/**
 * The full worksheet batch output: a record of category keys to category
 * results. Cross-field rules (N/A ⇒ empty checked, no duplicate items) are
 * enforced with a superRefine pass so a single safeParse catches them.
 */
export const worksheetBatchSchema = z
	.object({
		categories: z.record(z.string(), worksheetCategoryResultSchema),
	})
	.superRefine((data, ctx) => {
		for (const [key, category] of Object.entries(data.categories)) {
			// Rule 1: an N/A category has no checked items by definition —
			// checking items while declaring the category not applicable is
			// a direct contradiction.
			if (category.overall === "N/A" && category.checked.length > 0) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["categories", key, "checked"],
					message: `category "${key}" is N/A but lists ${category.checked.length} checked item(s) — N/A categories must have an empty checked array`,
				});
			}
			// Rule 2: no duplicate item strings in one category's checked
			// array (the same rubric sub-point checked twice is noise).
			const seen = new Set<string>();
			for (const checked of category.checked) {
				if (seen.has(checked.item)) {
					ctx.addIssue({
						code: z.ZodIssueCode.custom,
						path: ["categories", key, "checked"],
						message: `duplicate checked item in category "${key}": "${checked.item}"`,
					});
				}
				seen.add(checked.item);
			}
		}
	});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One checked rubric item plus its evidence citation. */
export type WorksheetCheckedItem = z.infer<typeof worksheetCheckedItemSchema>;

/** One category's worksheet verdict. */
export type WorksheetCategoryResult = z.infer<typeof worksheetCategoryResultSchema>;

/** The full worksheet batch output (validated shape). */
export type WorksheetBatchOutput = z.infer<typeof worksheetBatchSchema>;
