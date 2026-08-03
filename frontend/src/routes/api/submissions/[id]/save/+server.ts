/**
 * @file POST /api/submissions/[id]/save — persist grading state.
 *
 * Body (JSON, all optional):
 *   rubric     — object mapping criterion key -> selected option key
 *   dimensions — object mapping dimension id -> slider value (number)
 *   feedback   — object mapping category key -> { checked, comments, deductions, notes }
 *   notes      — free-form string
 *
 * Merges into the record's grading state via metadata.saveGrading; the
 * submission status is left untouched. Returns the updated record.
 */

import { error, json } from "@sveltejs/kit";
import type { RequestEvent } from "@sveltejs/kit";

import { assignmentExists, resolveAssignmentId } from "$lib/server/assignments";
import { getSubmission, saveGrading } from "$lib/server/metadata";
import type { CategoryFeedback } from "$lib/types/evaluation";

export async function POST(event: RequestEvent): Promise<Response> {
	const studentId = event.params.id;
	if (!studentId) {
		throw error(400, "Missing submission id");
	}
	const assignmentId = await resolveAssignmentId(event.url.searchParams.get("assignment"));
	if (!assignmentId) {
		throw error(404, "No assignments configured");
	}
	if (!(await assignmentExists(assignmentId))) {
		throw error(404, `Assignment "${assignmentId}" not found`);
	}

	const existing = await getSubmission(assignmentId, studentId);
	if (!existing) {
		throw error(404, `Submission "${studentId}" not found in assignment "${assignmentId}"`);
	}

	let body: unknown;
	try {
		body = await event.request.json();
	} catch {
		throw error(400, "Expected a JSON body");
	}
	if (body === null || typeof body !== "object" || Array.isArray(body)) {
		throw error(400, "Expected a JSON object body");
	}
	const input = body as Record<string, unknown>;

	const grading: {
		rubric?: Record<string, string>;
		dimensions?: Record<string, number>;
		feedback?: Record<string, CategoryFeedback>;
		notes?: string;
	} = {};
	if (input.rubric !== undefined) {
		if (!isStringMap(input.rubric)) {
			throw error(400, "rubric must be an object mapping criterion keys to option keys");
		}
		grading.rubric = input.rubric as Record<string, string>;
	}
	if (input.dimensions !== undefined) {
		if (!isNumberMap(input.dimensions)) {
			throw error(400, "dimensions must be an object mapping dimension ids to numbers");
		}
		grading.dimensions = input.dimensions as Record<string, number>;
	}
	if (input.feedback !== undefined) {
		if (!isFeedbackMap(input.feedback)) {
			throw error(
				400,
				"feedback must be an object mapping category keys to { checked: string[], comments: Record<string,string>, deductions: Record<string,number>, notes: string }",
			);
		}
		grading.feedback = input.feedback as Record<string, CategoryFeedback>;
	}
	if (input.notes !== undefined) {
		if (typeof input.notes !== "string") {
			throw error(400, "notes must be a string");
		}
		grading.notes = input.notes;
	}

	const record = await saveGrading(assignmentId, studentId, grading);
	return json(record);
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function isStringMap(value: unknown): value is Record<string, string> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	return Object.values(value).every((v) => typeof v === "string");
}

function isNumberMap(value: unknown): value is Record<string, number> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	return Object.values(value).every((v) => typeof v === "number" && Number.isFinite(v));
}

function isFeedbackMap(value: unknown): boolean {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	return Object.values(value).every((entry) => {
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
			return false;
		}
		const e = entry as Record<string, unknown>;
		return (
			Array.isArray(e.checked) &&
			e.checked.every((v) => typeof v === "string") &&
			isStringMap(e.comments) &&
			isNumberMap(e.deductions) &&
			typeof e.notes === "string"
		);
	});
}
