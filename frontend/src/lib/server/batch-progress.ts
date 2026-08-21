/**
 * @file Shared in-memory batch-progress store for the process and
 * pre-evaluation routes.
 *
 * Both batch endpoints follow the same pattern: a POST starts a run and
 * writes per-item progress here as it loops; a GET /status endpoint reads
 * it, and the dashboard polls while a run is in flight. The state is
 * in-memory (single Node process in dev and Docker) — a browser refresh
 * mid-run loses the poll, but the running batch keeps updating submission
 * statuses, which the dashboard also polls.
 */

export interface BatchProgressBase {
	/** True while a batch run is in flight. */
	running: boolean;
	assignmentId: string | null;
	/** Epoch ms when the run started. */
	startedAt: number | null;
	/** Student id of the item currently being processed. */
	currentStudentId: string | null;
	/** Epoch ms when the current item started. */
	currentStartedAt: number | null;
	/** Items settled (executed or errored). */
	done: number;
	/** Total items targeted by the run. */
	total: number;
}

interface BatchProgressStoreOptions {
	/**
	 * When set, begin() throws this message if a run is already in flight —
	 * an atomic check-and-set so a concurrent claim fails instead of
	 * silently overwriting the running batch's progress.
	 */
	conflictMessage?: string;
}

export function createBatchProgressStore<T extends BatchProgressBase>(
	idle: T,
	options: BatchProgressStoreOptions = {},
) {
	let state: T = { ...idle };

	return {
		/** Claim the run slot: reset to idle, then mark running with the given fields. */
		begin(run: Pick<T, "assignmentId" | "total">): void {
			if (options.conflictMessage && state.running) {
				throw new Error(options.conflictMessage);
			}
			state = { ...idle, ...run, running: true, startedAt: Date.now() };
		},
		update(patch: Partial<T>): void {
			state = { ...state, ...patch };
		},
		/**
		 * Keep the final tallies (done/total/...) so the UI can show the
		 * completed run summary; running flips to false and the current-item
		 * fields clear.
		 */
		end(): void {
			state = { ...state, running: false, currentStudentId: null, currentStartedAt: null };
		},
		get(): T {
			return { ...state };
		},
		/** Reset all progress (used by tests to isolate cases). */
		reset(): void {
			state = { ...idle };
		},
	};
}
