/**
 * @file POST /api/submissions/pre-evaluate — batch pre-evaluation (Phase 4c).
 *
 * Query param:
 *   assignment? — target assignment (default: first enabled assignment)
 *
 * Targets every submission whose status is `executed` or `error` — i.e.
 * rows with a stored execution result the pre-evaluation service can read.
 * Pending (never executed) and graded/archived rows are left untouched.
 *
 * Pipeline: each target gets ONE KI Connect pre-evaluation call
 * (preEvaluateSubmission), the envelope is persisted via setPreEvaluation
 * (results.json), and the row is marked `pre-evaluated` (the lifecycle step
 * the dashboard's filter/status chip already expect). Rows are processed
 * with bounded concurrency (2) and per-row failures never abort the loop —
 * the row is reported with ok:false and its error message, and keeps its
 * prior status so the teacher can retry.
 *
 * The route refuses to start while a pre-evaluation run is already in
 * flight (409) — one global run at a time, mirroring the batch-process
 * route's single-run model. Progress is written to pre-eval-progress.ts and
 * polled by the dashboard via GET /api/submissions/pre-evaluate/status.
 */

import { error, json } from "@sveltejs/kit";
import type { RequestEvent } from "@sveltejs/kit";

import { assignmentExists, resolveAssignmentId } from "$lib/server/assignments";
import { preEvaluateSubmission } from "$lib/server/copilot/pre-evaluation";
import { listSubmissions, updateStatus } from "$lib/server/metadata";
import {
	beginPreEvalRun,
	endPreEvalRun,
	getPreEvalRun,
	updatePreEvalRun,
} from "$lib/server/pre-eval-progress";
import { setPreEvaluation } from "$lib/server/results-store";

/** Bounded concurrency for the KI Connect calls (2 in flight max). */
const CONCURRENCY = 2;

/**
 * Serializes the read-modify-write persist steps (results.json + metadata.json).
 * The KI Connect calls run concurrently, but the two stores are single-file
 * maps — parallel writers would clobber each other's updates (and collide on
 * the same-ms temp file). A per-process promise chain keeps the persist +
 * status-flip section atomic while the slow LLM calls stay in flight.
 */
let persistChain: Promise<void> = Promise.resolve();

function withPersistLock<T>(fn: () => Promise<T>): Promise<T> {
	const run = persistChain.then(fn, fn);
	persistChain = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

/** One per-submission outcome row in the response. */
interface PreEvaluateRow {
	studentId: string;
	ok: boolean;
	/** Set when the row failed; failures never abort the loop. */
	error: string | null;
}

export async function POST(event: RequestEvent): Promise<Response> {
	const assignmentId = await resolveAssignmentId(event.url.searchParams.get("assignment"));
	if (!assignmentId) {
		throw error(404, "No assignments configured");
	}
	if (!(await assignmentExists(assignmentId))) {
		throw error(404, `Assignment "${assignmentId}" not found`);
	}

	// One global run at a time: refuse while another pre-evaluation is in
	// flight (the dashboard disables the button, but a second tab could
	// still race in here).
	if (getPreEvalRun().running) {
		throw error(409, "A pre-evaluation run is already in progress");
	}

	const records = await listSubmissions(assignmentId);
	// Targets: rows with a stored execution result the service can read.
	// Pending rows have no executed cells yet; graded/pre-evaluated rows are
	// outside the batch scope (the teacher can re-run per submission).
	const targets = records.filter((r) => r.status === "executed" || r.status === "error");

	if (targets.length === 0) {
		return json({
			assignmentId,
			submitted: 0,
			succeeded: 0,
			failed: 0,
			results: [],
		});
	}

	const results: PreEvaluateRow[] = [];
	const startedAt = Date.now();

	beginPreEvalRun(assignmentId, targets.length);
	try {
		await runWithConcurrency(targets, CONCURRENCY, async (target) => {
			updatePreEvalRun({
				currentStudentId: target.id,
				currentStartedAt: Date.now(),
			});
			try {
				const envelope = await preEvaluateSubmission({
					submissionId: target.id,
					assignmentId,
				});
				// Persist + status flip are atomic (single-file stores); the
				// LLM call above already ran outside the lock.
				await withPersistLock(async () => {
					await setPreEvaluation(assignmentId, target.id, {
						...envelope,
						evaluatedAt: new Date().toISOString(),
					});
					// Lifecycle step: executed|error -> pre-evaluated. The
					// transition map predates the pre-evaluation route, so
					// both hops are force-enabled here — the statuses are
					// exactly what the dashboard filter/status chip expect.
					await updateStatus(assignmentId, target.id, "pre-evaluated", { force: true });
					results.push({ studentId: target.id, ok: true, error: null });
				});
			} catch (err) {
				results.push({
					studentId: target.id,
					ok: false,
					error: err instanceof Error ? err.message : String(err),
				});
			}
			updatePreEvalRun({ done: results.length });
		});
	} finally {
		endPreEvalRun();
	}

	const totalDurationSeconds = (Date.now() - startedAt) / 1000;

	// Concurrency makes the push order nondeterministic — sort the summary
	// by studentId so the API shape is stable.
	results.sort((a, b) => a.studentId.localeCompare(b.studentId));

	return json({
		assignmentId,
		submitted: targets.length,
		succeeded: results.filter((r) => r.ok).length,
		failed: results.filter((r) => !r.ok).length,
		totalDurationSeconds,
		results,
	});
}

/**
 * Run `worker` over every item with at most `limit` workers in flight.
 * The worker itself is responsible for per-item error isolation — a
 * rejection here would abort the whole batch.
 */
async function runWithConcurrency<T>(
	items: T[],
	limit: number,
	worker: (item: T) => Promise<void>,
): Promise<void> {
	let index = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (index < items.length) {
			const item = items[index]!;
			index += 1;
			await worker(item);
		}
	});
	await Promise.all(workers);
}
