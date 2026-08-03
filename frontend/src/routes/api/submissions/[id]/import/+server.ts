/**
 * @file POST /api/submissions/[id]/import — apply a teacher-YAML grading document.
 *
 * Body (JSON envelope, NOT multipart):
 *   yaml — the teacher-YAML document string (as produced by the export
 *          route's kind=teacher / buildGradingYaml)
 *
 * Resolves the assignment via ?assignment= (same pattern as save/+server.ts),
 * requires the submission to exist, then parses the YAML (ImportError -> 400
 * with its message) and applies it via applyTeacherYaml. Returns the updated
 * submission record.
 */

import { error, json } from "@sveltejs/kit";
import type { RequestEvent } from "@sveltejs/kit";

import { assignmentExists, resolveAssignmentId } from "$lib/server/assignments";
import { applyTeacherYaml, ImportError, parseTeacherYaml } from "$lib/server/import-service";
import { getSubmission } from "$lib/server/metadata";

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

	const yaml = input.yaml;
	if (typeof yaml !== "string" || yaml.trim() === "") {
		throw error(400, "yaml must be a non-empty string");
	}

	let parsed;
	try {
		parsed = parseTeacherYaml(yaml);
	} catch (err) {
		if (err instanceof ImportError) {
			throw error(400, err.message);
		}
		throw err;
	}

	const record = await applyTeacherYaml(assignmentId, studentId, parsed);
	return json(record);
}
