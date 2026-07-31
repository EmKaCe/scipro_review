/**
 * @file GET /api/plagiarism/results — return the cached plagiarism
 *       comparison for an assignment.
 *
 * Query params:
 *   assignmentId? — target assignment (default: first enabled assignment)
 *
 * 404 when no check has been run (or the cache was cleared) — the caller
 * should POST /api/plagiarism/check first.
 */

import { error, json } from "@sveltejs/kit";
import type { RequestEvent } from "@sveltejs/kit";

import { assignmentExists, resolveAssignmentId } from "$lib/server/assignments";
import { readPlagiarismResult } from "$lib/server/plagiarism/cache";

export async function GET(event: RequestEvent): Promise<Response> {
	const explicit = event.url.searchParams.get("assignmentId");
	const assignmentId = await resolveAssignmentId(explicit);
	if (!assignmentId) {
		throw error(404, "No assignments configured");
	}
	if (!(await assignmentExists(assignmentId))) {
		throw error(404, `Assignment "${assignmentId}" not found`);
	}

	const result = await readPlagiarismResult(assignmentId);
	if (!result) {
		throw error(
			404,
			`No plagiarism results for "${assignmentId}" — run POST /api/plagiarism/check first`,
		);
	}
	return json(result);
}
