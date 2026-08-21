/**
 * @file Live progress of the current batch process run.
 *
 * POST /api/submissions/process writes its per-notebook progress here as it
 * loops; GET /api/submissions/process/status reads it. The dashboard polls
 * the status endpoint every 2s while a batch runs, so it can show the
 * current notebook, per-notebook + total elapsed time, and auto-fix counts
 * without parsing log output client-side.
 *
 * In-memory server state (single Node process in dev and Docker). A browser
 * refresh mid-run loses the poll but the running batch keeps updating the
 * submission statuses, which the dashboard also polls.
 */

import { createBatchProgressStore, type BatchProgressBase } from "./batch-progress";

export interface ProcessProgress extends BatchProgressBase {
	/** Automatic autofix re-runs attempted across the whole run. */
	autofixAttempts: number;
	/** Autofix re-runs that finished without an error. */
	autofixSucceeded: number;
}

const store = createBatchProgressStore<ProcessProgress>({
	running: false,
	assignmentId: null,
	startedAt: null,
	currentStudentId: null,
	currentStartedAt: null,
	done: 0,
	total: 0,
	autofixAttempts: 0,
	autofixSucceeded: 0,
});

export function beginProcessRun(assignmentId: string, total: number): void {
	store.begin({ assignmentId, total });
}

export function updateProcessRun(patch: Partial<ProcessProgress>): void {
	store.update(patch);
}

export function endProcessRun(): void {
	store.end();
}

export function getProcessRun(): ProcessProgress {
	return store.get();
}

/** Reset all progress (used by tests to isolate cases). */
export function resetProcessRun(): void {
	store.reset();
}
