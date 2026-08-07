/**
 * @file Live progress of the current batch process run.
 *
 * POST /api/submissions/process writes its per-notebook progress here as it
 * loops; GET /api/submissions/process/status reads it. The dashboard polls
 * the status endpoint every 2s while a batch runs, so it can show the
 * current notebook, per-notebook + total elapsed time, and auto-fix counts
 * without parsing log output client-side.
 *
 * This is in-memory server state (single Node process in dev and Docker).
 * A browser refresh mid-run loses the poll but the running batch keeps
 * updating the submission statuses, which the dashboard also polls.
 */

export interface ProcessProgress {
	/** True while a batch process run is in flight. */
	running: boolean;
	assignmentId: string | null;
	/** Epoch ms when the run started. */
	startedAt: number | null;
	/** Student id of the notebook currently being executed. */
	currentStudentId: string | null;
	/** Epoch ms when the current notebook started executing. */
	currentStartedAt: number | null;
	/** Notebooks settled (executed or error). */
	done: number;
	/** Total notebooks targeted by the run. */
	total: number;
	/** Automatic autofix re-runs attempted across the whole run. */
	autofixAttempts: number;
	/** Autofix re-runs that finished without an error. */
	autofixSucceeded: number;
}

const IDLE: ProcessProgress = {
	running: false,
	assignmentId: null,
	startedAt: null,
	currentStudentId: null,
	currentStartedAt: null,
	done: 0,
	total: 0,
	autofixAttempts: 0,
	autofixSucceeded: 0,
};

let state: ProcessProgress = { ...IDLE };

export function beginProcessRun(assignmentId: string, total: number): void {
	state = {
		...IDLE,
		running: true,
		assignmentId,
		startedAt: Date.now(),
		total,
	};
}

export function updateProcessRun(patch: Partial<ProcessProgress>): void {
	state = { ...state, ...patch };
}

export function endProcessRun(): void {
	// Keep the final tallies (done/total/autofix) so the UI can show the
	// completed run summary; running flips to false.
	state = { ...state, running: false, currentStudentId: null, currentStartedAt: null };
}

export function getProcessRun(): ProcessProgress {
	return { ...state };
}

/** Reset all progress (used by tests to isolate cases). */
export function resetProcessRun(): void {
	state = { ...IDLE };
}
