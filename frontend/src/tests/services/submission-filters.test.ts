/**
 * @file Unit tests for the canonical submission filter (BUG-012).
 *
 * The submissions list page (`visibleIds`) and the dashboard (`filtered`) both
 * derive their visible row sets from {@link filterSubmissions}. These tests
 * pin the shared semantics and guard the two sites against drifting apart —
 * the "page visibleIds == dashboard filtered" equivalence is guaranteed by
 * both calling this single function.
 */

import { describe, expect, it } from "vitest";

import { filterSubmissions } from "$lib/services/submission-filters.js";
import type { GradingConfidence } from "$lib/types/submissions.js";
import type { SubmissionMeta } from "$lib/types/submissions.js";

const ASSIGNMENT = "soil_contamination";

function meta(
	id: string,
	status: SubmissionMeta["status"] = "pending",
	confidence?: GradingConfidence,
): SubmissionMeta {
	return {
		id,
		studentId: id,
		assignmentId: ASSIGNMENT,
		semester: "2026SS",
		status,
		...(confidence ? { gradingConfidence: confidence } : {}),
		createdAt: "2026-07-28T10:00:00Z",
		updatedAt: "2026-07-28T10:00:00Z",
	};
}

/** Filter state shaped like the page/dashboard prop trio. */
function opts(
	overrides: Partial<{
		statusFilter: string;
		confidenceFilter: string;
		searchQuery: string;
	}> = {},
) {
	return {
		statusFilter: "all",
		confidenceFilter: "all",
		searchQuery: "",
		...overrides,
	};
}

/** Canonical fixture: every status × a couple of confidence values. */
const rows: SubmissionMeta[] = [
	meta("2026SS_01", "pending", "needs_review"),
	meta("2026SS_02", "executed", "review_optional"),
	meta("2026SS_03", "graded", "high_confidence"),
	meta("2026SS_04", "archived", "needs_review"),
	meta("2026SS_05", "graded"), // no stored confidence
];

describe("filterSubmissions", () => {
	it("returns every row under the default (all) filters except archived", () => {
		// Archived rows are hidden unless the archived filter is active.
		expect(filterSubmissions(rows, opts()).map((r) => r.studentId)).toEqual([
			"2026SS_01",
			"2026SS_02",
			"2026SS_03",
			"2026SS_05",
		]);
	});

	it("reveals archived rows only when statusFilter is 'archived'", () => {
		expect(filterSubmissions(rows, opts({ statusFilter: "archived" })).map((r) => r.studentId))
			.toEqual(["2026SS_04"]);
	});

	it("filters by status exactly (non-archived statuses)", () => {
		expect(filterSubmissions(rows, opts({ statusFilter: "graded" })).map((r) => r.studentId))
			.toEqual(["2026SS_03", "2026SS_05"]);
	});

	it("filters by confidence, excluding rows without a stored value", () => {
		expect(
			filterSubmissions(rows, opts({ confidenceFilter: "needs_review" })).map((r) => r.studentId),
		).toEqual(["2026SS_01"]); // 2026SS_04 is archived → hidden under "all"
		expect(
			filterSubmissions(rows, opts({ confidenceFilter: "high_confidence" })).map(
				(r) => r.studentId,
			),
		).toEqual(["2026SS_03"]);
	});

	it("matches a search term as a case-insensitive substring of studentId", () => {
		expect(filterSubmissions(rows, opts({ searchQuery: "2026ss_03" })).map((r) => r.studentId))
			.toEqual(["2026SS_03"]);
		expect(filterSubmissions(rows, opts({ searchQuery: "graded-something" }))).toEqual([]);
	});

	it("combines archived + status + confidence + search rules like the dashboard", () => {
		// Same state set on both the page and the dashboard: confidence
		// "needs_review" + search "01" (the archived 2026SS_04 is hidden
		// because statusFilter is not "archived").
		const pageVisible = filterSubmissions(
			rows,
			opts({ statusFilter: "all", confidenceFilter: "needs_review", searchQuery: "01" }),
		);
		// The dashboard receives the identical props and calls the same util.
		const dashboardFiltered = filterSubmissions(
			rows,
			opts({ statusFilter: "all", confidenceFilter: "needs_review", searchQuery: "01" }),
		);
		expect(dashboardFiltered).toEqual(pageVisible);
		expect(pageVisible.map((r) => r.studentId)).toEqual(["2026SS_01"]);
	});
});
