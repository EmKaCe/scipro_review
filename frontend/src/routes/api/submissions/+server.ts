/**
 * @file GET /api/submissions — list submissions for the active assignment.
 *
 * The assignment is taken from the `?assignment=` query param; when omitted,
 * the first enabled assignment from data/assignments.yaml is used. Records
 * come from the batch metadata.json; records without a stored cellSummary
 * are enriched from results.json (e.g. "12 cells, 2 errors").
 *
 * Archived submissions are excluded unless `?includeArchived=1` is given —
 * the dashboard loads them only while the "Archived" filter is active.
 */

import { error, json } from "@sveltejs/kit";
import type { RequestEvent } from "@sveltejs/kit";

import { assignmentExists, resolveAssignmentId } from "$lib/server/assignments";
import { listSubmissions } from "$lib/server/metadata";
import { deriveCellSummary, readResults } from "$lib/server/results-store";

export async function GET(event: RequestEvent): Promise<Response> {
	const assignmentId = await resolveAssignmentId(event.url.searchParams.get("assignment"));
	if (!assignmentId) {
		throw error(404, "No assignments configured");
	}
	if (!(await assignmentExists(assignmentId))) {
		throw error(404, `Assignment "${assignmentId}" not found`);
	}

	const includeArchived = event.url.searchParams.get("includeArchived") === "1";
	const records = await listSubmissions(assignmentId);
	const results = await readResults(assignmentId);

	const submissions = records
		.filter((record) => includeArchived || record.status !== "archived")
		.map((record) => {
			if (record.cellSummary === undefined) {
				const summary = deriveCellSummary(results[record.id]);
				if (summary !== undefined) {
					return { ...record, cellSummary: summary };
				}
			}
			return record;
		});

	return json({ assignmentId, submissions });
}
