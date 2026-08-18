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
import {
	loadCohortNorms,
	overTickFromStored,
} from "$lib/server/copilot/over-tick";

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
	// Over-tick guard (review-diff workflow): the committed cohort norm for
	// this assignment, loaded once per request. Absent norms (assignment
	// without a committed norm) degrade to no flags — the guard is a
	// best-effort affordance, never a hard dependency.
	const norms = await loadCohortNorms(assignmentId).catch(() => null);

	const submissions = records
		.filter((record) => includeArchived || record.status !== "archived")
		.map((record) => {
			const stored = results[record.id];
			const enriched: Record<string, unknown> = { ...record };
			if (record.cellSummary === undefined) {
				const summary = deriveCellSummary(stored);
				if (summary !== undefined) {
					enriched.cellSummary = summary;
				}
			}
			// Badge affordance: a verified clean auto-fix exists for this
			// submission AND the fixed execution is stored (old-engine
			// results carry succeeded=1 without fixedCells — no toggle, so
			// no badge). The original still shows its errors — this flag
			// points the teacher at the original↔fixed toggle.
			enriched.autofixAvailable =
				stored?.autofix?.succeeded === 1 && (stored?.fixedCells?.length ?? 0) > 0;
			// Confidence routing (Step 8): the deterministic confidence is
			// part of the persisted pre-eval envelope — surface it on the
			// list row so the dashboard can filter/prioritize reviews.
			// Absent for rows pre-evaluation has not run on yet.
			enriched.gradingConfidence = stored?.preEval?.gradingConfidence;
			// Over-tick guard (Signal B): categories where the pipeline
			// checked more items than the cohort norm tolerates — the
			// dashboard badge. Same enrichment path as gradingConfidence.
			if (norms) {
				const overTick = overTickFromStored(stored, norms);
				if (overTick && overTick.overTickCategories.length > 0) {
					enriched.overTickCategories = overTick.overTickCategories;
				}
			}
			return enriched;
		});

	return json({ assignmentId, submissions });
}
