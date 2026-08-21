/**
 * @file POST /api/submissions/[id]/reset — reset grading progress.
 *
 * Clears the submission's rubric/dimensions/feedback/notes and the final
 * grade, reverting the status to "executed" (dashboard bulk Reset). Returns
 * the updated record.
 */

import { error, json } from "@sveltejs/kit";
import type { RequestEvent } from "@sveltejs/kit";

import { assignmentExists, resolveAssignmentId } from "$lib/server/assignments";
import { getSubmission, resetSubmission } from "$lib/server/metadata";

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

	const record = await resetSubmission(assignmentId, studentId);
	return json(record);
}
