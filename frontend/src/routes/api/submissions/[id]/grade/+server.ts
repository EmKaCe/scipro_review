/**
 * @file POST /api/submissions/[id]/grade — finalize the grade.
 *
 * Body (JSON):
 *   teacherGrade — finite number (points deducted or score)
 *
 * Validates the teacherGrade, enforces the status transition to "graded"
 * (only executed / pre-evaluated records may be graded — 409 otherwise) and
 * persists the grade. Returns the updated record.
 */

import { error, json } from "@sveltejs/kit";
import type { RequestEvent } from "@sveltejs/kit";

import { assignmentExists, resolveAssignmentId } from "$lib/server/assignments";
import { getSubmission, MetadataError, updateStatus, upsertSubmission } from "$lib/server/metadata";

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

	const teacherGrade = (body as Record<string, unknown>).teacherGrade;
	if (typeof teacherGrade !== "number" || !Number.isFinite(teacherGrade)) {
		throw error(400, "teacherGrade must be a finite number");
	}

	try {
		await updateStatus(assignmentId, studentId, "graded");
	} catch (err) {
		if (err instanceof MetadataError) {
			throw error(409, err.message);
		}
		throw err;
	}

	const record = await upsertSubmission(assignmentId, studentId, { teacherGrade });
	return json(record);
}
