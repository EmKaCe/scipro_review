/**
 * @file POST /api/submissions/[id]/autofix — suggest a fix for one failed
 *       cell of a submission (Phase 3c.1).
 *
 * Proxies the executor's /autofix endpoint (KI Connect). The teacher stays
 * in control: the suggestion is returned read-only and the UI only copies
 * it into the notes after the teacher edits it (P3-3, human-writes-final).
 *
 * Body (JSON):
 *   cellIndex  — 0-based index of the failing cell
 *   cellSource — the failing cell's source (as executed)
 *   cellError  — error message from the failed execution
 *   traceback? — optional traceback lines
 *
 * Query param:
 *   assignment? — target assignment (default: first enabled assignment)
 *
 * Response: the executor's AutoFixResponse shape (skipped, suggestion,
 * explanation, confidence, fix_type, patched_source, syntax_valid).
 * The executor answers 200 with skipped:true when KI Connect is
 * unavailable, so this route only fails on transport errors.
 */

import { error, json } from "@sveltejs/kit";
import type { RequestEvent } from "@sveltejs/kit";

import { assignmentExists, resolveAssignmentId } from "$lib/server/assignments";
import { getExecutorClient } from "$lib/server/executor-client";
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

	if (typeof input.cellSource !== "string" || input.cellSource === "") {
		throw error(400, "cellSource must be a non-empty string");
	}
	if (typeof input.cellError !== "string" || input.cellError === "") {
		throw error(400, "cellError must be a non-empty string");
	}
	let cellIndex: number | undefined;
	if (input.cellIndex !== undefined) {
		if (typeof input.cellIndex !== "number" || !Number.isInteger(input.cellIndex)) {
			throw error(400, "cellIndex must be an integer");
		}
		cellIndex = input.cellIndex;
	}
	let traceback: string[] | null = null;
	if (input.traceback !== undefined) {
		if (
			!Array.isArray(input.traceback) ||
			!input.traceback.every((line) => typeof line === "string")
		) {
			throw error(400, "traceback must be an array of strings");
		}
		traceback = input.traceback as string[];
	}

	const suggestion = await getExecutorClient().suggestAutofix({
		cellSource: input.cellSource,
		cellError: input.cellError,
		cellIndex,
		traceback,
		assignmentId,
	});
	return json(suggestion);
}
