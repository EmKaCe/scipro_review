/**
 * @file POST /api/submissions/[id]/archive — archive or restore a submission.
 *
 * Body (JSON):
 *   action  — "archive" (default) | "restore"
 *
 * Archive:  soft-removes the submission from the active batch — it is hidden
 *           from the default dashboard list, Process All, and plagiarism
 *           checks, but the notebook + grading stay on disk and the record
 *           remembers its pre-archive status.
 * Restore:  returns the submission to the active batch with its pre-archive
 *           status (or the explicit `status` target when given).
 *
 * Query param:
 *   assignment? — target assignment (default: first enabled assignment)
 */

import { error, json } from "@sveltejs/kit";
import type { RequestEvent } from "@sveltejs/kit";

import { assignmentExists, resolveAssignmentId } from "$lib/server/assignments";
import { archiveSubmission, getSubmission, restoreSubmission } from "$lib/server/metadata";
import { setStudentPairReviewStatus } from "$lib/server/plagiarism/cache";
import type { SubmissionStatus } from "$lib/types/submissions";

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

	let body: Record<string, unknown> = {};
	try {
		const parsed: unknown = await event.request.json();
		if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
			body = parsed as Record<string, unknown>;
		}
	} catch {
		// Empty/invalid body → default action "archive".
	}

	const action = body.action === "restore" ? "restore" : "archive";
	let status: SubmissionStatus | undefined;
	if (typeof body.status === "string" && body.status !== "") {
		status = body.status as SubmissionStatus;
	}

	const record =
		action === "restore"
			? await restoreSubmission(assignmentId, studentId, status)
			: await archiveSubmission(assignmentId, studentId);

	// Archive → the student's plagiarism pairs stop blocking other exports
	// (marked ignored). Restore → back to unreviewed so the guard applies
	// again. Best-effort: no cache or no pairs is fine.
	await setStudentPairReviewStatus(
		assignmentId,
		studentId,
		action === "restore" ? "unreviewed" : "ignored",
	).catch(() => {
		// cache read/write failures must not fail the archive itself
	});

	return json(record);
}
