/**
 * @file Rune-based plagiarism store.
 *
 * Owns the cached plagiarism comparison for the active assignment:
 *
 *   - load()      — GET /api/plagiarism/results (404 → no result yet)
 *   - run()       — POST /api/plagiarism/check (re-run)
 *   - setStatus() — PATCH a pair's review status, persists server-side
 *
 * Review state is per-pair (P3-1): `unreviewed` is the default; Accept /
 * Dismiss / Ignore resolve a pair; the badge counts unreviewed pairs.
 * The store is shared by the dashboard modal and the per-submission
 * Plagiarism tab so both views stay in sync.
 */

import {
	ApiError,
	checkPlagiarism,
	fetchPlagiarismResults,
	pairReviewStatus,
	setPairReviewStatus,
	type PairReviewStatus,
	type PlagiarismCheckOptions,
	type PlagiarismPair,
	type PlagiarismResult,
} from "./submissions-api.js";

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class PlagiarismStore {
	/** Cached comparison for the active assignment (null when none yet). */
	result = $state<PlagiarismResult | null>(null);
	/** Resolved assignment id (set by load/run responses). */
	assignmentId = $state<string | null>(null);
	/** Load status: idle | loading | error. */
	status = $state<"idle" | "loading" | "error">("idle");
	/** Last error message (when status is "error" or a refresh failed). */
	error = $state<string | null>(null);
	/** True while a check is running. */
	isChecking = $state(false);

	/**
	 * Monotonic sequence for load() responses. Each load() bumps it and
	 * captures its own token; a response whose token is stale (a slower
	 * load for a PREVIOUS assignment resolved after a newer one) is
	 * dropped so `result`/`assignmentId` never show the wrong assignment's
	 * pairs (BUG-019 — rapid assignment switching).
	 */
	private loadSeq = 0;

	/**
	 * Load the cached result for an assignment (404 → null, not an error).
	 * Late responses from a superseded assignment are discarded.
	 */
	async load(assignmentId?: string): Promise<PlagiarismResult | null> {
		const seq = ++this.loadSeq;
		const target = assignmentId ?? this.assignmentId ?? undefined;
		this.status = "loading";
		this.error = null;
		try {
			const result = await fetchPlagiarismResults(target);
			if (seq !== this.loadSeq) return null; // superseded — drop
			this.result = result;
			this.assignmentId = result.assignmentId;
			this.status = "idle";
			return result;
		} catch (err) {
			if (seq !== this.loadSeq) return null; // superseded — drop
			if (err instanceof ApiError && err.status === 404) {
				// No check has been run for this assignment yet.
				this.result = null;
				this.assignmentId = null;
				this.status = "idle";
				return null;
			}
			this.status = "error";
			this.error = toErrorMessage(err);
			throw err;
		}
	}

	/** Run the plagiarism check (structural + optional semantic pass). */
	async run(assignmentId?: string, options?: PlagiarismCheckOptions): Promise<PlagiarismResult> {
		this.isChecking = true;
		this.error = null;
		try {
			const result = await checkPlagiarism(
				assignmentId ?? this.assignmentId ?? undefined,
				options,
			);
			this.result = result;
			this.assignmentId = result.assignmentId;
			this.status = "idle";
			return result;
		} catch (err) {
			this.status = "error";
			this.error = toErrorMessage(err);
			throw err;
		} finally {
			this.isChecking = false;
		}
	}

	/** Resolve one pair (Accept / Dismiss / Ignore) and persist server-side. */
	async setStatus(
		studentA: string,
		studentB: string,
		reviewStatus: PairReviewStatus,
		assignmentId?: string,
	): Promise<PlagiarismResult> {
		const result = await setPairReviewStatus(
			studentA,
			studentB,
			reviewStatus,
			assignmentId ?? this.assignmentId ?? undefined,
		);
		this.result = result;
		this.assignmentId = result.assignmentId;
		this.error = null;
		return result;
	}

	/** Mark every remaining unreviewed pair as ignored (export guard). */
	async ignoreAllUnreviewed(assignmentId?: string): Promise<void> {
		const result = this.result;
		if (!result) return;
		const pending = result.pairs.filter((p) => pairReviewStatus(p) === "unreviewed");
		for (const pair of pending) {
			await this.setStatus(pair.studentA, pair.studentB, "ignored", assignmentId);
		}
	}

	/** Number of unreviewed pairs (whole assignment, or only pairs involving
	 *  `studentId` when given — the per-submission badge). */
	unreviewedCount(studentId?: string): number {
		return this.countByStatus("unreviewed", studentId);
	}

	/** Count pairs by review status (optionally scoped to one submission). */
	countByStatus(status: PairReviewStatus, studentId?: string): number {
		const result = this.result;
		if (!result) return 0;
		return result.pairs.filter(
			(p) =>
				pairReviewStatus(p) === status &&
				(studentId === undefined || p.studentA === studentId || p.studentB === studentId),
		).length;
	}

	/** Pairs involving `studentId` (the per-submission Plagiarism tab). */
	pairsFor(studentId: string): PlagiarismPair[] {
		const result = this.result;
		if (!result) return [];
		return result.pairs.filter((p) => p.studentA === studentId || p.studentB === studentId);
	}

	/** Clear in-memory state (assignment switch). */
	reset(): void {
		this.result = null;
		this.assignmentId = null;
		this.status = "idle";
		this.error = null;
		this.isChecking = false;
	}
}

/** Singleton store shared by the dashboard modal and per-submission tab. */
export const plagiarismStore = new PlagiarismStore();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toErrorMessage(err: unknown): string {
	if (err instanceof Error) {
		return err.message;
	}
	return String(err);
}
