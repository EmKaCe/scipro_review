/**
 * @file Regression tests for the B1 review-route wiring defect.
 *
 * B1 (product-sound release, known symptom): `/review/[id]/evaluation` shows
 * "No evaluation to preview" — and the store was being handed a STUDENT id
 * (e.g. `2026SS_00`) where `setAssignment()` expects an ASSIGNMENT id
 * (e.g. `soil_contamination`). The pages must never feed a non-assignment id
 * into `setAssignment`; otherwise `getCriteriaForAssignment` fails
 * ("Assignment not found: 2026SS_00"), the rubric never loads, and the page
 * falls into a misleading empty state with a spurious error toast.
 *
 * Live probe (ADAPTER=static dev, 2026-08-19): navigating to
 * `/review/2026SS_00/evaluation` printed
 * `[criteria-loader] Assignment not found: 2026SS_00` and the empty-state
 * "No evaluation to preview" — confirmed below in the `resolveReviewAssignmentId`
 * decision that both review pages now gate on.
 */
import { describe, it, expect } from "vitest";
import {
	resolveReviewAssignmentId,
	isUnknownReviewAssignmentId,
} from "$lib/utils/review-route.js";

// Enabled assignment registry as loaded by the review store (RubricStore.init
// filters `enabled`). Soil is the only enabled assignment in the repo.
const ASSIGNMENTS = [{ id: "soil_contamination" }, { id: "atom_interaction" }];

describe("resolveReviewAssignmentId — B1 wiring gate", () => {
	it("returns the param when it is a valid assignment id", () => {
		expect(resolveReviewAssignmentId("soil_contamination", ASSIGNMENTS)).toBe(
			"soil_contamination",
		);
	});

	it("returns the param for any enabled assignment id", () => {
		expect(resolveReviewAssignmentId("atom_interaction", ASSIGNMENTS)).toBe("atom_interaction");
	});

	it("returns null for a STUDENT id (the B1 defect): a student id must never feed setAssignment", () => {
		// 2026SS_00 is a student/submission id, NOT an assignment id.
		expect(resolveReviewAssignmentId("2026SS_00", ASSIGNMENTS)).toBeNull();
	});

	it("returns null for an arbitrary unknown id", () => {
		expect(resolveReviewAssignmentId("no_such_assignment", ASSIGNMENTS)).toBeNull();
	});

	it("returns null for empty/undefined param", () => {
		expect(resolveReviewAssignmentId("", ASSIGNMENTS)).toBeNull();
		expect(resolveReviewAssignmentId(undefined, ASSIGNMENTS)).toBeNull();
	});

	it("returns null when the registry is empty", () => {
		expect(resolveReviewAssignmentId("soil_contamination", [])).toBeNull();
	});

	it("a disabled assignment not present in the enabled registry is treated as unknown", () => {
		expect(resolveReviewAssignmentId("molecular_dynamics", ASSIGNMENTS)).toBeNull();
	});
});

describe("isUnknownReviewAssignmentId — honest empty-state message", () => {
	it("flags a student id once the registry is loaded (drives the 'Evaluation not available' message)", () => {
		expect(isUnknownReviewAssignmentId("2026SS_00", ASSIGNMENTS, true)).toBe(true);
	});

	it("does not flag a valid assignment id", () => {
		expect(isUnknownReviewAssignmentId("soil_contamination", ASSIGNMENTS, true)).toBe(false);
	});

	it("does not flag before the registry has loaded", () => {
		expect(isUnknownReviewAssignmentId("2026SS_00", ASSIGNMENTS, false)).toBe(false);
	});

	it("does not flag an empty param", () => {
		expect(isUnknownReviewAssignmentId("", ASSIGNMENTS, true)).toBe(false);
	});
});
