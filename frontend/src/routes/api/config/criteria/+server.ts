/**
 * @file GET /api/config/criteria — merged rubric for one assignment, read
 * from the data directory (DATA_DIR, default ./data).
 *
 * Teacher-mode counterpart to $lib/services/criteria-loader.ts: instead of
 * fetching the static copy of the criteria YAML over HTTP, the assignment is
 * looked up in the server registry (enabled or not) and its criteria files
 * are parsed directly from disk.
 *
 * Errors are loud on purpose: an unknown assignment or missing criteria file
 * is a 404, a corrupt criteria YAML is a 500 — never a silent empty rubric.
 */

import { error, json } from "@sveltejs/kit";
import type { RequestEvent } from "@sveltejs/kit";

import { getAssignmentById } from "$lib/server/assignments";
import { loadCriteriaForAssignment } from "$lib/server/criteria";

export async function GET(event: RequestEvent): Promise<Response> {
	const assignmentId = event.url.searchParams.get("assignment");
	if (!assignmentId || !assignmentId.trim()) {
		throw error(400, "Missing required query parameter: assignment");
	}

	const assignment = await getAssignmentById(assignmentId);
	if (!assignment) {
		throw error(404, `Assignment not found: ${assignmentId}`);
	}

	let rubric;
	try {
		rubric = await loadCriteriaForAssignment(assignment.criteria_files);
	} catch (err) {
		throw error(500, err instanceof Error ? err.message : String(err));
	}

	if (rubric.categories.length === 0) {
		throw error(404, `No criteria files found for assignment: ${assignmentId}`);
	}

	return json({ rubric });
}
