/**
 * @file GET /api/submissions/[id]/export — download the grading YAML.
 *
 * Serializes the submission record + grading state via export-service.ts
 * and returns it as a Content-Disposition attachment named
 * <studentId>.yaml. Export works in any status (partial grading exports
 * are allowed); graded records carry the full state.
 */

import { error } from "@sveltejs/kit";
import type { RequestEvent } from "@sveltejs/kit";

import { assignmentExists, getAssignmentById, resolveAssignmentId } from "$lib/server/assignments";
import { buildGradingYaml } from "$lib/server/export-service";
import { getSubmission } from "$lib/server/metadata";

export async function GET(event: RequestEvent): Promise<Response> {
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

	const record = await getSubmission(assignmentId, studentId);
	if (!record) {
		throw error(404, `Submission "${studentId}" not found in assignment "${assignmentId}"`);
	}

	const assignment = await getAssignmentById(assignmentId);
	const yamlText = buildGradingYaml(record, { assignmentTitle: assignment?.title });

	return new Response(yamlText, {
		headers: {
			"Content-Type": "application/yaml; charset=utf-8",
			"Content-Disposition": `attachment; filename="${record.studentId}.yaml"`,
		},
	});
}
