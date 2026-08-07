/**
 * @file POST /api/submissions/process — batch-execute runnable submissions.
 *
 * Body (JSON):
 *   assignmentId? — target assignment (default: first enabled assignment)
 *   ids?          — optional subset of student ids; only runnable submissions
 *                   in the subset are executed. Unknown ids -> 404.
 *
 * Runnable = pending (first run) or error (retry after a failed run).
 * Executing/executed/graded are left untouched by the batch path.
 *
 * Pipeline: each target is executed one at a time (per-notebook executor
 * call) and its record transitions executing -> executed | error as it
 * finishes. Per-row updates mean the dashboard's 2s polling shows live
 * progress (rows flip one by one) instead of waiting for one monolithic
 * batch call. Timeouts come from data/settings.yaml (request + per-cell),
 * so slower machines can be accommodated without a restart. One notebook
 * failing does not abort the others — each row records its own error and
 * the loop continues.
 */

import { error, json } from "@sveltejs/kit";
import type { RequestEvent } from "@sveltejs/kit";

import { assignmentExists, resolveAssignmentId } from "$lib/server/assignments";
import { getExecutorClient } from "$lib/server/executor-client";
import { listSubmissions, updateStatus, upsertSubmission } from "$lib/server/metadata";
import { beginProcessRun, endProcessRun, updateProcessRun } from "$lib/server/process-progress";
import {
	deriveCellSummary,
	setResult,
	type StoredExecutionResult,
} from "$lib/server/results-store";
import { loadSettings } from "$lib/server/settings";

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
	// Runnable targets: pending (first run) and error (retry after a failed
	// run). Executing/executed/graded are left untouched by the batch path.
	let targets = records.filter((r) => r.status === "pending" || r.status === "error");

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

	const client = getExecutorClient();
	const settings = await loadSettings();
	const results: Array<{ studentId: string; success: boolean; error: string | null }> = [];
	const startedAt = Date.now();
	let autofixAttempts = 0;
	let autofixSucceeded = 0;

	beginProcessRun(assignmentId, targets.length);
	try {
		for (const target of targets) {
			// pending/error -> executing so the dashboard shows the run in progress.
			await updateStatus(assignmentId, target.id, "executing");
			updateProcessRun({
				currentStudentId: target.id,
				currentStartedAt: Date.now(),
			});

			try {
				const execution = await client.executeNotebook(
					{
						notebookPath: target.notebookPath,
						// assignmentContext intentionally omitted — the per-submission
						// route supplies it; a batch run stays deterministic.
					},
					undefined,
					// A batch row gets the per-notebook budget (settings), not the
					// tighter single-request default — slower machines need it.
					{ requestTimeoutMs: settings.executor.notebookTimeoutMs },
				);
				const duration = execution.durationSeconds;
				autofixAttempts += execution.autofix.attempts;
				autofixSucceeded += execution.autofix.succeeded;

				if (execution.success) {
					await updateStatus(assignmentId, target.id, "executed");
					const stored: StoredExecutionResult = {
						success: true,
						notebookPath: target.notebookPath,
						cells: execution.cells,
						totalCells: execution.totalCells,
						executedCells: execution.executedCells,
						errorCells: execution.errorCells,
						durationSeconds: duration,
						preprocessing: execution.preprocessing ?? EMPTY_PREPROCESSING,
						modifiedFiles: execution.modifiedFiles ?? [],
						autofix: execution.autofix,
					};
					await setResult(assignmentId, target.id, stored);
					await upsertSubmission(assignmentId, target.id, {
						cellSummary: deriveCellSummary(stored),
						error: null,
					});
					results.push({ studentId: target.id, success: true, error: null });
				} else {
					const message = firstCellError(execution.cells) ?? "Execution failed";
					await updateStatus(assignmentId, target.id, "error");
					await upsertSubmission(assignmentId, target.id, { error: message });
					await setResult(assignmentId, target.id, {
						success: false,
						notebookPath: target.notebookPath,
						cells: execution.cells,
						totalCells: execution.totalCells,
						executedCells: execution.executedCells,
						errorCells: execution.errorCells,
						durationSeconds: duration,
						preprocessing: execution.preprocessing ?? EMPTY_PREPROCESSING,
						modifiedFiles: execution.modifiedFiles ?? [],
						error: message,
						autofix: execution.autofix,
					});
					results.push({ studentId: target.id, success: false, error: message });
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				await updateStatus(assignmentId, target.id, "error");
				await upsertSubmission(assignmentId, target.id, { error: message });
				results.push({ studentId: target.id, success: false, error: message });
			}
			updateProcessRun({
				done: results.length,
				autofixAttempts,
				autofixSucceeded,
			});
		}
	} finally {
		endProcessRun();
	}

	const totalDurationSeconds = (Date.now() - startedAt) / 1000;

	return json({
		assignmentId,
		submitted: targets.length,
		succeeded: results.filter((r) => r.success).length,
		failed: results.filter((r) => !r.success).length,
		totalDurationSeconds,
		autofixAttempts,
		autofixSucceeded,
		results,
	});
}

/** First cell-level error message, or null when all cells executed. */
function firstCellError(cells: unknown[]): string | null {
	for (const cell of cells) {
		const error = (cell as { error?: string | null }).error;
		if (typeof error === "string" && error.length > 0) return error;
	}
	return null;
}
