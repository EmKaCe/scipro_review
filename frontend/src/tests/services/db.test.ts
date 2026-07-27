/**
 * @file Unit tests for db.ts
 *
 * Tests IndexedDB CRUD operations, auto-save, listing, and bulk operations.
 * Uses fake-indexeddb to simulate IndexedDB in Node.js/jsdom.
 *
 * Note: We use clearAllReviews() + clearCurrentSession() for cleanup
 * instead of deleting the database, because the idb library caches
 * the database connection and deleting while connected causes timeouts.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, beforeEach } from "vitest";
import {
	saveCurrentSession,
	loadCurrentSession,
	clearCurrentSession,
	saveReview,
	loadReview,
	deleteReview,
	listReviews,
	listSemesters,
	exportAll,
	importAll,
	clearAllReviews,
} from "$lib/services/db";
import type { ReviewSession } from "$lib/types/session";
import type { GradingConfig } from "$lib/types/grading";
import { categoryKeyOf } from "$lib/types/criteria";
import { dimensionKeyOf } from "$lib/types/grading";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TEST_CONFIG: GradingConfig = {
	dimensions: [
		{
			key: dimensionKeyOf("code_quality_design"),
			title: "Code Quality & Design",
			max_points: 6,
			weight: 4,
		},
		{ key: dimensionKeyOf("creativity"), title: "Creativity", max_points: 4, weight: 1 },
	],
	grade_boundaries: [
		{ min_percentage: 95, grade: 1.0, label: "excellent", us_equiv: "A+" },
		{ min_percentage: 50, grade: 4.0, label: "sufficient", us_equiv: "D" },
		{ min_percentage: 0, grade: 5.0, label: "fail", us_equiv: "F" },
	],
};

function makeSession(overrides?: Partial<ReviewSession>): ReviewSession {
	return {
		student_id: "2026SS_42",
		assignment_id: "atom_interaction",
		mode: "student",
		category_selections: {
			[categoryKeyOf("code_quality")]: {
				checked_items: new Set(["did_well"]),
				notes: "",
				comments: {},
				deductions: {},
			},
		} as Record<string, any>,
		grading: {
			code_quality_design: 4,
			code_execution_results: 5,
			assignment_requirements: 3,
			scientific_programming: 4,
			creativity: 2,
		} as unknown as import("$lib/types/grading").GradingInputs,
		generated_text: "",
		started_at: "2026-01-01T00:00:00.000Z",
		updated_at: "2026-01-02T00:00:00.000Z",
		...overrides,
	};
}

// Clear all data between tests (don't delete the DB — idb caches connections)
beforeEach(async () => {
	await clearAllReviews().catch(() => {});
	await clearCurrentSession().catch(() => {});
});

// ---------------------------------------------------------------------------
// Auto-save (current session)
// ---------------------------------------------------------------------------

describe("saveCurrentSession / loadCurrentSession", () => {
	it("saves and loads the current session", async () => {
		const session = makeSession();
		await saveCurrentSession(session);
		const loaded = await loadCurrentSession();
		expect(loaded).not.toBeNull();
		expect(loaded!.student_id).toBe("2026SS_42");
		expect(loaded!.assignment_id).toBe("atom_interaction");
	});

	it("overwrites the previous current session on re-save", async () => {
		const session1 = makeSession({ student_id: "2026SS_01" });
		await saveCurrentSession(session1);

		const session2 = makeSession({ student_id: "2026SS_02" });
		await saveCurrentSession(session2);

		const loaded = await loadCurrentSession();
		expect(loaded!.student_id).toBe("2026SS_02");
	});

	it("returns null when no current session exists", async () => {
		const loaded = await loadCurrentSession();
		expect(loaded).toBeNull();
	});
});

describe("clearCurrentSession", () => {
	it("clears the current session", async () => {
		const session = makeSession();
		await saveCurrentSession(session);
		await clearCurrentSession();
		const loaded = await loadCurrentSession();
		expect(loaded).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Review CRUD
// ---------------------------------------------------------------------------

describe("saveReview / loadReview", () => {
	it("saves a review and loads it by ID", async () => {
		const session = makeSession();
		const id = await saveReview(session);
		expect(id).toBeTruthy();

		const loaded = await loadReview(id);
		expect(loaded).not.toBeNull();
		expect(loaded!.student_id).toBe("2026SS_42");
	});

	it("generates a unique ID for each review", async () => {
		const session = makeSession();
		const id1 = await saveReview(session);
		const id2 = await saveReview(session);
		expect(id1).not.toBe(id2);
	});

	it("updates an existing review when existingId is provided", async () => {
		const session = makeSession({ student_id: "2026SS_01" });
		const id = await saveReview(session);

		const updated = makeSession({ student_id: "2026SS_02" });
		await saveReview(updated, id);

		const loaded = await loadReview(id);
		expect(loaded!.student_id).toBe("2026SS_02");
	});

	it("returns null when loading a non-existent ID", async () => {
		const loaded = await loadReview("nonexistent-id");
		expect(loaded).toBeNull();
	});

	it("preserves Set in category_selections through IDB round-trip", async () => {
		const session = makeSession();
		const id = await saveReview(session);
		const loaded = await loadReview(id);
		const checkedItems = (loaded!.category_selections as Record<string, any>)["code_quality"]
			.checked_items;
		expect(checkedItems).toBeInstanceOf(Set);
		expect(checkedItems.has("did_well")).toBe(true);
	});
});

describe("deleteReview", () => {
	it("deletes a review by ID", async () => {
		const session = makeSession();
		const id = await saveReview(session);
		const deleted = await deleteReview(id);
		expect(deleted).toBe(true);

		const loaded = await loadReview(id);
		expect(loaded).toBeNull();
	});

	it("returns false when deleting a non-existent review", async () => {
		const deleted = await deleteReview("nonexistent-id");
		expect(deleted).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Review listing
// ---------------------------------------------------------------------------

describe("listReviews", () => {
	it("returns an empty array when no reviews exist", async () => {
		const reviews = await listReviews();
		expect(reviews).toEqual([]);
	});

	it("lists saved reviews sorted by updated_at descending", async () => {
		const session1 = makeSession({ student_id: "2026SS_01" });
		const session2 = makeSession({ student_id: "2026SS_02" });
		await saveReview(session1);
		await saveReview(session2);

		const reviews = await listReviews();
		expect(reviews.length).toBeGreaterThanOrEqual(2);
		// Sorted by updated_at descending
		for (let i = 1; i < reviews.length; i++) {
			expect(reviews[i - 1].updated_at >= reviews[i].updated_at).toBe(true);
		}
	});

	it("excludes the __current__ sentinel from listing", async () => {
		await saveCurrentSession(makeSession());
		const reviews = await listReviews();
		const hasCurrent = reviews.some((r) => r.id === "__current__");
		expect(hasCurrent).toBe(false);
	});

	it("filters by semester when provided", async () => {
		const session1 = makeSession({ student_id: "2026SS_01" });
		const session2 = makeSession({ student_id: "2025WS_01" });
		await saveReview(session1);
		await saveReview(session2);

		const reviews = await listReviews("2026SS");
		expect(reviews.every((r) => r.semester === "2026SS")).toBe(true);
	});

	it("computes grade when gradingConfig is provided", async () => {
		const session = makeSession();
		await saveReview(session);

		const reviews = await listReviews(undefined, TEST_CONFIG);
		expect(reviews.length).toBeGreaterThan(0);
		expect(reviews[0].grade).toBeDefined();
		expect(reviews[0].label).toBeDefined();
		expect(reviews[0].us_equiv).toBeDefined();
	});

	it("returns grade 0 when no gradingConfig provided", async () => {
		const session = makeSession();
		await saveReview(session);

		const reviews = await listReviews();
		expect(reviews[0].grade).toBe(0);
		expect(reviews[0].label).toBe("");
		expect(reviews[0].us_equiv).toBe("");
	});
});

describe("listSemesters", () => {
	it("returns distinct semesters sorted in reverse order", async () => {
		const session1 = makeSession({ student_id: "2026SS_01" });
		const session2 = makeSession({ student_id: "2025WS_01" });
		await saveReview(session1);
		await saveReview(session2);

		const semesters = await listSemesters();
		expect(semesters).toContain("2026SS");
		expect(semesters).toContain("2025WS");
		// Sorted in reverse (newest first)
		expect(semesters.indexOf("2026SS")).toBeLessThan(semesters.indexOf("2025WS"));
	});

	it("returns empty array when no reviews exist", async () => {
		const semesters = await listSemesters();
		expect(semesters).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Bulk operations
// ---------------------------------------------------------------------------

describe("exportAll / importAll", () => {
	it("exports all reviews excluding __current__", async () => {
		await saveReview(makeSession({ student_id: "2026SS_01" }));
		await saveReview(makeSession({ student_id: "2026SS_02" }));
		await saveCurrentSession(makeSession({ student_id: "2026SS_03" }));

		const exported = await exportAll();
		expect(exported.reviews.length).toBe(2);
		expect(exported.exported_at).toBeTruthy();
	});

	it("imports reviews from a bulk export", async () => {
		await saveReview(makeSession({ student_id: "2026SS_01" }));
		const exported = await exportAll();

		// Clear and re-import
		await clearAllReviews();
		const result = await importAll(exported);
		expect(result.imported).toBe(1);
	});
});

describe("clearAllReviews", () => {
	it("clears all reviews including the current session", async () => {
		await saveReview(makeSession());
		await saveCurrentSession(makeSession());

		await clearAllReviews();

		const reviews = await listReviews();
		expect(reviews).toEqual([]);
		const current = await loadCurrentSession();
		expect(current).toBeNull();
	});
});
