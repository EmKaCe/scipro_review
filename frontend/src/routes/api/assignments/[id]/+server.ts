/**
 * @file PUT/DELETE /api/assignments/[id] — update or delete one assignment.
 *
 * PUT    — partial update: body { title?, enabled?, criteria_files?,
 *          dimensions? }; absent keys keep their current values. 200 with the
 *          updated summary, 404 when the id is unknown, 400 on invalid input.
 * DELETE — remove the entry from the registry. 409 when the assignment has
 *          submissions (data/submissions/<id>/ exists), otherwise 204.
 *
 * Environment: DATA_DIR (default ./data). Server-only ($lib/server deps).
 */

import { error, json } from "@sveltejs/kit";
import type { RequestEvent } from "@sveltejs/kit";

import {
	AssignmentWriteError,
	deleteAssignment,
	toAssignmentSummary,
	updateAssignment,
	type AssignmentUpdateInput,
} from "$lib/server/assignments-writer";

/** PUT /api/assignments/[id] — partially update an assignment. */
export async function PUT(event: RequestEvent): Promise<Response> {
	const id = event.params.id ?? "";
	if (id === "") {
		throw error(400, "Missing assignment id");
	}

	let input: AssignmentUpdateInput;
	try {
		input = (await event.request.json()) as AssignmentUpdateInput;
	} catch {
		throw error(400, "Expected a JSON body");
	}

	try {
		const updated = await updateAssignment(id, input);
		return json(toAssignmentSummary(updated));
	} catch (err) {
		throw toHttpError(err);
	}
}

/** DELETE /api/assignments/[id] — remove an assignment (409 with submissions). */
export async function DELETE(event: RequestEvent): Promise<Response> {
	const id = event.params.id ?? "";
	if (id === "") {
		throw error(400, "Missing assignment id");
	}

	try {
		await deleteAssignment(id);
		return new Response(null, { status: 204 });
	} catch (err) {
		throw toHttpError(err);
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Map a writer error to a SvelteKit HttpError (message lives in body.message). */
function toHttpError(err: unknown): never {
	if (err instanceof AssignmentWriteError) {
		throw error(err.status, err.message);
	}
	throw error(500, (err as Error).message);
}
