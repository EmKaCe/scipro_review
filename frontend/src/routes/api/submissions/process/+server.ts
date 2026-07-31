/**
 * @file POST /api/submissions/process — batch-execute pending submissions.
 *
 * Body (JSON):
 *   assignmentId? — target assignment (default: first enabled assignment)
 *   ids?          — optional subset of student ids; only pending submissions
 *                   in the subset are executed. Unknown ids -> 404.
 *
 * Pipeline: selected records transition pending -> executing, the executor's
 * /execute/batch runs them, then each record becomes executed | error. A
 * per-submission entry is written to results.json (batch responses carry no
 * cell data — entries have cells: [] until a single [id]/process run). If
 * the executor itself fails (connection/timeout/5xx), every selected record
 * is marked error and the route returns 500 with the detail.
 */

import { error, json } from "@sveltejs/kit";
import type { RequestEvent } from "@sveltejs/kit";

import { assignmentExists, resolveAssignmentId } from "$lib/server/assignments";
import { getExecutorClient, type BatchExecutionResult } from "$lib/server/executor-client";
import { listSubmissions, updateStatus, upsertSubmission } from "$lib/server/metadata";
import {
	deriveCellSummary,
	setResult,
	type StoredExecutionResult,
} from "$lib/server/results-store";

const EMPTY_PREPROCESSING = {
	cellsModified: 0,
	totalEdits: 0,
	editTypes: {},
	llmPreprocessing: "skipped",
	llmAnalysis: false,
} as const;

export async function POST(event: RequestEvent): Promise<Response> {
	let body: Record<string, unknown>;
	try {
		body = (await event.request.json()) as Record<string, unknown>;
	} catch {
		throw error(400, "Expected a JSON body");
	}
	if (body === null || typeof body !== "object" || Array.isArray(body)) {
		throw error(400, "Expected a JSON object body");
	}

	const assignmentId = await resolveAssignmentId(
		typeof body.assignmentId === "string" ? body.assignmentId : null,
	);
	if (!assignmentId) {
		throw error(404, "No assignments configured");
	}
	if (!(await assignmentExists(assignmentId))) {
		throw error(404, `Assignment "${assignmentId}" not found`);
	}

	const records = await listSubmissions(assignmentId);
	let targets = records.filter((r) => r.status === "pending");

	const ids = body.ids;
	if (Array.isArray(ids) && ids.length > 0) {
		const idSet = new Set(ids.filter((id): id is string => typeof id === "string"));
		const unknown = [...idSet].filter((id) => !records.some((r) => r.id === id));
		if (unknown.length > 0) {
			throw error(404, `Submissions not found: ${unknown.join(", ")}`);
		}
		targets = targets.filter((r) => idSet.has(r.id));
	}

	if (targets.length === 0) {
		return json({
			assignmentId,
			submitted: 0,
			succeeded: 0,
			failed: 0,
			totalDurationSeconds: 0,
			results: [],
		});
	}

	// pending -> executing for everything we are about to run.
	for (const target of targets) {
		await updateStatus(assignmentId, target.id, "executing");
	}

	let batch: BatchExecutionResult;
	try {
		batch = await getExecutorClient().executeBatch({
			notebooks: targets.map((t) => ({ notebookPath: t.notebookPath })),
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		for (const target of targets) {
			await updateStatus(assignmentId, target.id, "error");
			await upsertSubmission(assignmentId, target.id, { error: message });
		}
		throw error(500, `Batch execution failed: ${message}`);
	}

	const byPath = new Map(targets.map((t) => [t.notebookPath, t.id]));
	const results = [];

	for (const item of batch.results) {
		const studentId = byPath.get(item.notebookPath);
		if (!studentId) {
			continue; // executor returned an unknown notebook — ignore
		}

		if (item.success) {
			await updateStatus(assignmentId, studentId, "executed");
			const stored: StoredExecutionResult = {
				success: true,
				notebookPath: item.notebookPath,
				cells: [],
				totalCells: item.totalCells,
				executedCells: item.executedCells,
				errorCells: item.errorCells,
				durationSeconds: item.durationSeconds,
				preprocessing: EMPTY_PREPROCESSING,
				modifiedFiles: [],
			};
			await setResult(assignmentId, studentId, stored);
			await upsertSubmission(assignmentId, studentId, {
				cellSummary: deriveCellSummary(stored),
				error: null,
			});
			results.push({ studentId, success: true, error: null });
		} else {
			const message = item.error ?? "Execution failed";
			await updateStatus(assignmentId, studentId, "error");
			await upsertSubmission(assignmentId, studentId, { error: message });
			await setResult(assignmentId, studentId, {
				success: false,
				notebookPath: item.notebookPath,
				cells: [],
				totalCells: item.totalCells,
				executedCells: item.executedCells,
				errorCells: item.errorCells,
				durationSeconds: item.durationSeconds,
				preprocessing: EMPTY_PREPROCESSING,
				modifiedFiles: [],
				error: message,
			});
			results.push({ studentId, success: false, error: message });
		}
	}

	return json({
		assignmentId,
		submitted: targets.length,
		succeeded: results.filter((r) => r.success).length,
		failed: results.filter((r) => !r.success).length,
		totalDurationSeconds: batch.totalDurationSeconds,
		results,
	});
}
