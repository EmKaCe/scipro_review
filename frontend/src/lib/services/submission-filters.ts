/**
 * @file Canonical submission filter (single source of truth).
 *
 * Both the submissions list page and the dashboard dashboard filter the row
 * set by archived / status / confidence / search. Before this file existed
 * each site carried its own copy of the rules (`+page.svelte` `visibleIds`
 * and `submissions-dashboard.svelte` `filtered`) and they could silently
 * drift apart (BUG-012). Both sites now call {@link filterSubmissions} so the
 * semantics live in exactly one place.
 */

import type { SubmissionMeta } from "$lib/types/submissions.js";

/** Filter state shared between the submissions page and the dashboard. */
export interface SubmissionFilterOptions {
	/** Status filter: "all" or an exact submission status value. */
	statusFilter: string;
	/** Confidence filter: "all" or an exact grading-confidence value. */
	confidenceFilter: string;
	/** Case-insensitive substring matched against the student id. */
	searchQuery: string;
}

/**
 * Return the submissions matching the active archived / status / confidence /
 * search rules.
 *
 * Semantics (kept byte-identical to the original page + dashboard rules — the
 * point is dedup, not redefining filters):
 *  - archived rows are hidden unless the "archived" status filter is active;
 *  - `statusFilter !== "all"` keeps only rows with that exact status;
 *  - `confidenceFilter !== "all"` keeps only rows with that exact confidence
 *    value (rows without a stored confidence only match "all");
 *  - a non-empty `searchQuery` keeps only rows whose studentId contains it as
 *    a case-insensitive substring.
 */
export function filterSubmissions(
	submissions: readonly SubmissionMeta[],
	opts: SubmissionFilterOptions,
): SubmissionMeta[] {
	const { statusFilter, confidenceFilter, searchQuery } = opts;
	return submissions.filter((s) => {
		// Archived rows are hidden unless the "Archived" filter is active.
		if (s.status === "archived" && statusFilter !== "archived") return false;
		if (statusFilter !== "all" && s.status !== statusFilter) return false;
		// Confidence routing: rows without a stored confidence (pre-eval not
		// run, or a legacy envelope) only match the "All" filter.
		if (confidenceFilter !== "all" && s.gradingConfidence !== confidenceFilter) return false;
		if (searchQuery && !s.studentId.toLowerCase().includes(searchQuery.toLowerCase()))
			return false;
		return true;
	});
}
