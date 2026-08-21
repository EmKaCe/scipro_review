/**
 * @file In-memory ring buffer of pre-evaluation pipeline log entries.
 *
 * Pre-evaluation runs inside the SvelteKit server process (POST
 * /api/submissions/pre-evaluate), so its per-submission activity cannot go
 * through the executor's log ring buffer the way notebook execution does.
 * This module mirrors that buffer on the server side: the route appends one
 * entry per processed row (grade scores, marker count, rubric selection
 * count, success/fail), and GET /api/submissions/pre-evaluate/logs reads it
 * back for the dashboard's pipeline log panel.
 *
 * Entries are tagged `source: "pre-eval"` so the panel can distinguish them
 * from executor entries and filter them. Like the executor buffer, this is
 * in-memory (single Node process in dev and Docker); a restart clears it.
 */

/** One pre-evaluation pipeline log line (wire shape, GET …/pre-evaluate/logs). */
export interface PreEvalLogEntry {
	/** Monotonic id within the pre-eval buffer (unique across sources when prefixed). */
	id: number;
	/** Epoch seconds when the row settled. */
	ts: number;
	level: string;
	logger: string;
	/** Always "pre-eval" — the panel's source filter keys on this. */
	source: "pre-eval";
	/** Submission the entry refers to. */
	submissionId: string;
	/** Human-readable summary of the row outcome. */
	message: string;
	/** Suggested grade scores, dimension id -> points (empty on failure). */
	grades: Record<string, number>;
	/** Number of cell comparison markers produced (0 when none/no key). */
	markerCount: number;
	/** Number of rubric sub-point selections produced (0 when none). */
	selectionCount: number;
	/**
	 * The rubric sub-point selections themselves (categoryKey + optionKey),
	 * so the log panel can render the actual list in the expanded row.
	 */
	rubricSelections?: { categoryKey: string; optionKey: string }[];
	/** True when the row pre-evaluated successfully. */
	ok: boolean;
}

/** GET /api/submissions/pre-evaluate/logs response. */
export interface PreEvalLogsResponse {
	entries: PreEvalLogEntry[];
	truncated: boolean;
}

/** Ring buffer capacity — matches the executor's default fetch window. */
const BUFFER_CAPACITY = 500;

let entries: PreEvalLogEntry[] = [];
let nextId = 1;

/**
 * Append one pre-evaluation log line and return the stored entry (id/ts
 * assigned here). The buffer keeps the newest BUFFER_CAPACITY entries;
 * overflow drops the oldest, and `truncated` reflects that.
 */
export function appendPreEvalLog(
	entry: Omit<PreEvalLogEntry, "id" | "ts" | "source">,
): PreEvalLogEntry {
	const stored: PreEvalLogEntry = {
		...entry,
		id: nextId,
		ts: Math.floor(Date.now() / 1000),
		source: "pre-eval",
	};
	nextId += 1;
	entries = [...entries, stored];
	if (entries.length > BUFFER_CAPACITY) {
		entries = entries.slice(entries.length - BUFFER_CAPACITY);
	}
	return stored;
}

/** Newest-first snapshot of the buffer (oldest → newest after reversing). */
export function getPreEvalLogs(limit = 200): PreEvalLogsResponse {
	const clamped = Number.isFinite(limit) ? Math.max(1, Math.min(limit, 1000)) : 200;
	const slice = entries.slice(-clamped);
	return {
		entries: [...slice],
		truncated: entries.length > slice.length,
	};
}

/** Reset the buffer (used by tests to isolate cases). */
export function resetPreEvalLogs(): void {
	entries = [];
	nextId = 1;
}
