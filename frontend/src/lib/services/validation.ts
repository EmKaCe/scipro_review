/**
 * @file Zod validation schemas for imported review files.
 *
 * Validates YAML and JSON imports against the v2 evaluation schema
 * and the legacy JSON format before loading them into the store.
 *
 * Uses Zod 4 (zod@4) API.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared schemas
// ---------------------------------------------------------------------------

/** Validates a non-empty string. */
const nonEmptyString = z.string().min(1);

/** Validates an ISO date string (YYYY-MM-DD or full ISO 8601). */
const dateString = z.string().min(1);

// ---------------------------------------------------------------------------
// Category feedback schema (v2 evaluation format)
// ---------------------------------------------------------------------------

/** Schema for category feedback within an evaluation. */
const categoryFeedbackSchema = z.object({
	checked: z.array(z.string()),
	comments: z.record(z.string(), z.string()).optional().default({}),
	deductions: z.record(z.string(), z.number()).optional().default({}),
	notes: z.string().optional().default(""),
});

// ---------------------------------------------------------------------------
// Evaluation schema (v2 YAML/JSON export format)
// ---------------------------------------------------------------------------

/** Schema for the v2 Evaluation export format. */
const evaluationSchema = z.object({
	student_id: nonEmptyString,
	assignment: nonEmptyString,
	reviewer: z.string().optional().default("Anonymous"),
	date: dateString.optional().default(() => new Date().toISOString().split("T")[0]),
	scores: z.record(z.string(), z.number()),
	feedback: z.record(z.string(), categoryFeedbackSchema),
	result: z
		.object({
			percentage: z.number().min(0).max(100),
			grade: z.number().min(1).max(5),
			label: z.string(),
		})
		.optional(),
	notes: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Category selections schema (session format)
// ---------------------------------------------------------------------------

/** Schema for category selections within a review session. */
const categorySelectionsSchema = z.object({
	checked_items: z.union([z.array(z.string()), z.instanceof(Set)]).transform((val) => {
		if (val instanceof Set) return val;
		return new Set(val);
	}),
	notes: z.string().optional().default(""),
	comments: z.record(z.string(), z.string()).optional().default({}),
	deductions: z.record(z.string(), z.number()).optional().default({}),
});

// ---------------------------------------------------------------------------
// Review session schema (JSON format)
// ---------------------------------------------------------------------------

/** Schema for a ReviewSession (used for JSON import and IDB storage). */
const reviewSessionSchema = z.object({
	student_id: nonEmptyString,
	assignment_id: nonEmptyString,
	mode: z.string().optional().default("student"),
	notes: z.string().optional(),
	category_selections: z.record(z.string(), categorySelectionsSchema),
	grading: z.record(z.string(), z.number()),
	generated_text: z.string().optional().default(""),
	started_at: dateString.optional().default(() => new Date().toISOString()),
	updated_at: dateString.optional().default(() => new Date().toISOString()),
});

// ---------------------------------------------------------------------------
// Validation functions
// ---------------------------------------------------------------------------

/**
 * Validate a v2 Evaluation object (from YAML or JSON import).
 *
 * Returns the validated data or a Zod error.
 */
export function validateEvaluation(data: unknown): {
	success: boolean;
	data?: Record<string, unknown>;
	errors?: z.ZodError;
} {
	const result = evaluationSchema.safeParse(data);
	if (result.success) {
		return { success: true, data: result.data as Record<string, unknown> };
	}
	return { success: false, errors: result.error };
}

/**
 * Validate a ReviewSession object (from JSON import).
 *
 * Returns the validated data or a Zod error.
 */
export function validateReviewSession(data: unknown): {
	success: boolean;
	data?: Record<string, unknown>;
	errors?: z.ZodError;
} {
	const result = reviewSessionSchema.safeParse(data);
	if (result.success) {
		return { success: true, data: result.data as Record<string, unknown> };
	}
	return { success: false, errors: result.error };
}

/**
 * Format Zod validation errors into a human-readable string.
 *
 * Returns a bulleted list of field-level error messages.
 */
export function formatValidationErrors(errors: z.ZodError): string {
	const issues = errors.issues;
	if (issues.length === 0) return "Unknown validation error";

	const lines = issues.map((issue) => {
		const path = issue.path.map((p) => String(p)).join(".");
		return `• ${path || "(root)"}: ${issue.message}`;
	});

	if (lines.length <= 5) {
		return `Validation errors:\n${lines.join("\n")}`;
	}

	return `Validation errors (${lines.length} issues):\n${lines.slice(0, 5).join("\n")}\n...and ${lines.length - 5} more`;
}
