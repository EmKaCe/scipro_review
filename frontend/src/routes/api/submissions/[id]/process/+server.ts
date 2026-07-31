/**
 * @file POST /api/submissions/[id]/process — execute one submission.
 *
 * Resolves the record in the assignment metadata (assignment from
 * `?assignment=` or the first enabled one), runs pending/error/executed/
 * graded records through the executor's /execute, and stores the full
 * execution result (cells included) in results.json. Status transitions:
 * -> executing -> executed | error. Executor failures mark the record
 * "error" and return 500 with the detail.
 */

import { error, json } from "@sveltejs/kit";
import type { RequestEvent } from "@sveltejs/kit";

import {
	assignmentExists,
	getAssignmentById,
	resolveAssignmentId,
} from "$lib/server/assignments";
import { getExecutorClient } from "$lib/server/executor-client";
import { getSubmission, updateStatus, upsertSubmission } from "$lib/server/metadata";
import { deriveCellSummary, setResult } from "$lib/server/results-store";

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

	const record = await getSubmission(assignmentId, studentId);
	if (!record) {
		throw error(404, `Submission "${studentId}" not found in assignment "${assignmentId}"`);
	}
	if (record.status === "executing") {
		throw error(409, `Submission "${studentId}" is already executing`);
	}

	const assignment = await getAssignmentById(assignmentId);
	const assignmentContext = assignment?.title ?? null;

	try {
		await updateStatus(assignmentId, studentId, "executing");
		const result = await getExecutorClient().executeNotebook({
			notebookPath: record.notebookPath,
			assignmentContext,
		});

		await updateStatus(assignmentId, studentId, "executed");
		await setResult(assignmentId, studentId, { ...result, error: null });
		const updated = await upsertSubmission(assignmentId, studentId, {
			cellSummary: deriveCellSummary(result),
			error: null,
		});

		return json({ ...result, record: updated });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		try {
			await updateStatus(assignmentId, studentId, "error");
			await upsertSubmission(assignmentId, studentId, { error: message });
		} catch {
			// record may already be in the error state — keep the original error
		}
		throw error(500, `Execution failed: ${message}`);
	}
}
