/**
 * @file Live progress of the current batch pre-evaluation run.
 *
 * POST /api/submissions/pre-evaluate writes its per-submission progress
 * here as it loops; GET /api/submissions/pre-evaluate/status reads it. The
 * dashboard polls the status endpoint every 2s while a run is in flight, so
 * it can show the done/total count and keep the Pre-evaluate All button
 * disabled without parsing the response client-side.
 *
 * This mirrors the batch-process progress module (process-progress.ts) but
 * is intentionally a separate job type: pre-evaluation has no autofix
 * tallies, and sharing one record would let a process run and a pre-eval run
 * clobber each other's progress.
 *
 * In-memory server state (single Node process in dev and Docker). A browser
 * refresh mid-run loses the poll but the running batch keeps updating the
 * submission statuses, which the dashboard also reflects after a reload.
 */

export interface PreEvalProgress {
	/** True while a batch pre-evaluation run is in flight. */
	running: boolean;
	assignmentId: string | null;
	/** Epoch ms when the run started. */
	startedAt: number | null;
	/** Student id of the submission most recently started (concurrency 2). */
	currentStudentId: string | null;
	/** Epoch ms when that submission's pre-evaluation started. */
	currentStartedAt: number | null;
	/** Submissions settled (pre-evaluated or failed). */
	done: number;
	/** Total submissions targeted by the run. */
	total: number;
}

const IDLE: PreEvalProgress = {
	running: false,
	assignmentId: null,
	startedAt: null,
	currentStudentId: null,
	currentStartedAt: null,
	done: 0,
	total: 0,
};

let state: PreEvalProgress = { ...IDLE };

/**
 * Atomically claim the run slot: check-and-set in one synchronous step.
 * There is no `await` between the check and the assignment, so two requests
 * that both raced past a route's earlier `getPreEvalRun()` fast-path cannot
 * both start a run — the second one throws here. The route converts the
 * throw into a 409.
 *
 * Throws when a run is already in flight.
 */
export function beginPreEvalRun(assignmentId: string, total: number): void {
	if (state.running) {
		throw new Error("A pre-evaluation run is already in progress");
	}
	state = {
		...IDLE,
		running: true,
		assignmentId,
		startedAt: Date.now(),
		total,
	};
}

export function updatePreEvalRun(patch: Partial<PreEvalProgress>): void {
	state = { ...state, ...patch };
}

export function endPreEvalRun(): void {
	// Keep the final tallies (done/total) so the UI can show the completed
	// run summary; running flips to false.
	state = { ...state, running: false, currentStudentId: null, currentStartedAt: null };
}

export function getPreEvalRun(): PreEvalProgress {
	return { ...state };
}

/** Reset all progress (used by tests to isolate cases). */
export function resetPreEvalRun(): void {
	state = { ...IDLE };
}
