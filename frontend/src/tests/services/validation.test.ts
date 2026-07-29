/**
 * @file Unit tests for validation.ts
 *
 * Tests Zod schema validation for v2 Evaluation and ReviewSession formats,
 * and the formatValidationErrors helper.
 */
import { describe, it, expect } from "vitest";
import {
	validateEvaluation,
	validateReviewSession,
	formatValidationErrors,
} from "$lib/services/validation";

// ---------------------------------------------------------------------------
// validateEvaluation (v2 YAML/JSON format)
// ---------------------------------------------------------------------------

describe("validateEvaluation", () => {
	const validEvaluation = {
		student_id: "2026SS_42",
		assignment: "atom_interaction",
		reviewer: "Dr. Smith",
		date: "2026-01-15",
		scores: {
			code_quality_design: 4,
			code_execution_results: 5,
			assignment_requirements: 3,
			scientific_programming: 4,
			creativity: 2,
		},
		feedback: {
			code_quality: {
				checked: ["did_well"],
				comments: { did_well: "Nice work" },
				deductions: {},
				notes: "",
			},
		},
		result: {
			percentage: 75,
			grade: 2.3,
			label: "good",
		},
	};

	it("validates a correct v2 evaluation object", () => {
		const result = validateEvaluation(validEvaluation);
		expect(result.success).toBe(true);
		expect(result.data).toBeDefined();
		expect(result.data!.student_id).toBe("2026SS_42");
	});

	it("validates without optional fields (reviewer, date, result)", () => {
		const minimal = {
			student_id: "2026SS_42",
			assignment: "atom_interaction",
			scores: { code_quality_design: 4 },
			feedback: {},
		};
		const result = validateEvaluation(minimal);
		expect(result.success).toBe(true);
		// Defaults should be applied
		expect(result.data!.reviewer).toBe("Anonymous");
	});

	it("rejects missing student_id", () => {
		const invalid = { ...validEvaluation, student_id: "" };
		const result = validateEvaluation(invalid);
		expect(result.success).toBe(false);
		expect(result.errors).toBeDefined();
	});

	it("rejects missing assignment", () => {
		const invalid = { ...validEvaluation, assignment: "" };
		const result = validateEvaluation(invalid);
		expect(result.success).toBe(false);
	});

	it("rejects non-object input", () => {
		const result = validateEvaluation("not an object");
		expect(result.success).toBe(false);
	});

	it("rejects null input", () => {
		const result = validateEvaluation(null);
		expect(result.success).toBe(false);
	});

	it("validates feedback with checked arrays", () => {
		const withChecked = {
			...validEvaluation,
			feedback: {
				code_quality: {
					checked: ["item1", "item2"],
					comments: {},
					deductions: {},
					notes: "",
				},
			},
		};
		const result = validateEvaluation(withChecked);
		expect(result.success).toBe(true);
	});

	it("validates feedback with deductions", () => {
		const withDeductions = {
			...validEvaluation,
			feedback: {
				code_quality: {
					checked: ["needs_work"],
					comments: {},
					deductions: { needs_work: 3 },
					notes: "",
				},
			},
		};
		const result = validateEvaluation(withDeductions);
		expect(result.success).toBe(true);
	});

	it("rejects invalid scores (non-numeric)", () => {
		const invalid = {
			...validEvaluation,
			scores: { code_quality_design: "not a number" },
		};
		const result = validateEvaluation(invalid);
		expect(result.success).toBe(false);
	});

	it("rejects invalid result percentage (out of range)", () => {
		const invalid = {
			...validEvaluation,
			result: { percentage: 150, grade: 1.0, label: "excellent" },
		};
		const result = validateEvaluation(invalid);
		expect(result.success).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// validateReviewSession (JSON format)
// ---------------------------------------------------------------------------

describe("validateReviewSession", () => {
	const validSession = {
		student_id: "2026SS_42",
		assignment_id: "atom_interaction",
		mode: "student",
		category_selections: {
			code_quality: {
				checked_items: ["did_well"],
				notes: "",
				comments: {},
				deductions: {},
			},
		},
		grading: {
			code_quality_design: 4,
			creativity: 2,
		},
		generated_text: "",
		started_at: "2026-01-01T00:00:00.000Z",
		updated_at: "2026-01-02T00:00:00.000Z",
	};

	it("validates a correct review session", () => {
		const result = validateReviewSession(validSession);
		expect(result.success).toBe(true);
		expect(result.data).toBeDefined();
	});

	it("converts checked_items array to Set", () => {
		const result = validateReviewSession(validSession);
		expect(result.success).toBe(true);
		const sel = result.data!.category_selections as Record<
			string,
			{ checked_items: Set<string> }
		>;
		expect(sel.code_quality.checked_items).toBeInstanceOf(Set);
		expect(sel.code_quality.checked_items.has("did_well")).toBe(true);
	});

	it("defaults mode to 'student' when missing", () => {
		const { mode: _mode, ...withoutMode } = validSession;
		const result = validateReviewSession(withoutMode);
		expect(result.success).toBe(true);
		expect(result.data!.mode).toBe("student");
	});

	it("defaults generated_text to empty string when missing", () => {
		const { generated_text: _text, ...withoutText } = validSession;
		const result = validateReviewSession(withoutText);
		expect(result.success).toBe(true);
		expect(result.data!.generated_text).toBe("");
	});

	it("rejects missing student_id", () => {
		const invalid = { ...validSession, student_id: "" };
		const result = validateReviewSession(invalid);
		expect(result.success).toBe(false);
	});

	it("rejects missing assignment_id", () => {
		const invalid = { ...validSession, assignment_id: "" };
		const result = validateReviewSession(invalid);
		expect(result.success).toBe(false);
	});

	it("accepts any string value for mode (backward compat)", () => {
		const withCustom = { ...validSession, mode: "anything" };
		const result = validateReviewSession(withCustom);
		expect(result.success).toBe(true);
		expect(result.data!.mode).toBe("anything");
	});

	it("accepts Set as checked_items", () => {
		const withSet = {
			...validSession,
			category_selections: {
				code_quality: {
					checked_items: new Set(["did_well"]),
					notes: "",
					comments: {},
					deductions: {},
				},
			},
		};
		const result = validateReviewSession(withSet);
		expect(result.success).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// formatValidationErrors
// ---------------------------------------------------------------------------

describe("formatValidationErrors", () => {
	it("formats a single error", () => {
		const errors = {
			issues: [
				{
					path: ["student_id"],
					message: "Expected string, received number",
				},
			],
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
		} as any;
		const formatted = formatValidationErrors(errors);
		expect(formatted).toContain("student_id");
		expect(formatted).toContain("Expected string, received number");
	});

	it("formats multiple errors", () => {
		const errors = {
			issues: [
				{ path: ["student_id"], message: "Required" },
				{ path: ["assignment"], message: "Required" },
			],
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
		} as any;
		const formatted = formatValidationErrors(errors);
		expect(formatted).toContain("student_id");
		expect(formatted).toContain("assignment");
	});

	it("truncates when more than 5 errors", () => {
		const issues = Array.from({ length: 8 }, (_, i) => ({
			path: [`field_${i}`],
			message: `Error ${i}`,
		}));
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const errors = { issues } as any;
		const formatted = formatValidationErrors(errors);
		expect(formatted).toContain("3 more");
		expect(formatted).toContain("8 issues");
	});

	it("handles empty issues array", () => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const errors = { issues: [] } as any;
		const formatted = formatValidationErrors(errors);
		expect(formatted).toContain("Unknown validation error");
	});
});
