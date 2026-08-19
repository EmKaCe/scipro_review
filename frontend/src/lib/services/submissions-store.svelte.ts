/**
 * @file Rune-based submissions store.
 *
 * Owns the dashboard list, the selected submission detail, load/error state,
 * and the status-polling loop:
 *
 *   - startPolling() polls GET /api/submissions every 2 seconds;
 *   - polling auto-stops as soon as no submission is `pending` or `executing`;
 *   - process/upload (which create in-flight work) start polling
 *     automatically; callers may also start/stop it explicitly.
 *
 * The historical sync entry points (listSubmissions/getSubmission) are kept
 * as thin wrappers over the store's current state so existing imports keep
 * working — see submissions-store.ts.
 */

import { SvelteMap } from "svelte/reactivity";

import type { SubmissionDetail, SubmissionMeta, SubmissionStatus } from "$lib/types/submissions.js";

import {
	archiveSubmission as archiveSubmissionApi,
	deleteSubmission,
	exportSubmission,
	fetchSubmission,
	fetchSubmissions,
	importTeacherYaml as importTeacherYamlApi,
	processSubmissions,
	resetSubmission as resetSubmissionApi,
	saveGrading as saveGradingApi,
	uploadSubmissions,
	type BatchProcessResponse,
	type GradingPatch,
	type SubmissionExport,
	type UploadKind,
	type UploadResponse,
} from "./submissions-api.js";

// ---------------------------------------------------------------------------
// Constants & types
// ---------------------------------------------------------------------------

/** Polling interval for in-flight batch work (D5). */
export const POLL_INTERVAL_MS = 2000;

/** Statuses that keep the polling loop alive. */
const ACTIVE_STATUSES: ReadonlySet<SubmissionStatus> = new Set(["pending", "executing"]);

/** Top-level store status shown by the dashboard. */
export type SubmissionsLoadStatus = "idle" | "loading" | "error";

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class SubmissionsStore {
	/** Dashboard list for the active assignment. */
	submissions = $state<SubmissionMeta[]>([]);
	/** Resolved assignment id (set by load/refresh responses). */
	assignmentId = $state<string | null>(null);
	/** Detail of the submission currently open in the per-submission view. */
	selected = $state<SubmissionDetail | null>(null);
	/** Load status: idle | loading | error. */
	status = $state<SubmissionsLoadStatus>("idle");
	/** Last error message (when status is "error" or a refresh failed). */
	error = $state<string | null>(null);
	/** Whether the D5 polling loop is currently running. */
	isPolling = $state(false);
	/** True while a pre-evaluation batch run is in flight (keeps the 2s list loop alive). */
	private preEvalActive = false;
	/** Fetch archived rows too (set while the "Archived" filter is active). */
	includeArchived = $state(false);

	/** Detail cache backing the sync getSubmission() wrapper. */
	private details = new SvelteMap<string, SubmissionDetail>();
	/** Active interval handle (null when not polling). */
	private timer: ReturnType<typeof setInterval> | null = null;
	/** Guards against overlapping poll ticks when a refresh is slow. */
	private pollInFlight = false;

	// -----------------------------------------------------------------------
	// Loading
	// -----------------------------------------------------------------------

	/**
	 * Load the submission list for an assignment (defaults to the current
	 * one, or the server-side default when none is set). Sets loading/error
	 * status and throws on failure.
	 *
	 * `includeArchived` fetches archived rows too (the dashboard does this
	 * while the "Archived" filter is active).
	 */
	async load(assignmentId?: string, includeArchived?: boolean): Promise<SubmissionMeta[]> {
		this.status = "loading";
		this.error = null;
		try {
			const response = await fetchSubmissions(
				assignmentId ?? this.assignmentId ?? undefined,
				includeArchived ?? this.includeArchived,
			);
			this.assignmentId = response.assignmentId;
			this.submissions = response.submissions;
			this.syncPolling();
			this.status = "idle";
			return response.submissions;
		} catch (err) {
			this.status = "error";
			this.error = toErrorMessage(err);
			throw err;
		}
	}

	/**
	 * Re-fetch the current assignment's list without flipping into the
	 * loading state (used by the polling loop and after mutations). Failed
	 * refreshes keep the last good data and only record the error.
	 */
	async refresh(): Promise<void> {
		try {
			const response = await fetchSubmissions(
				this.assignmentId ?? undefined,
				this.includeArchived,
			);
			this.assignmentId = response.assignmentId;
			this.submissions = response.submissions;
			this.error = null;
		} catch (err) {
			this.error = toErrorMessage(err);
		}
	}

	// -----------------------------------------------------------------------
	// Polling (D5)
	// -----------------------------------------------------------------------

	/**
	 * Start polling GET /api/submissions every 2 seconds. No-op while already
	 * polling. The loop auto-stops after a tick that finds no `pending` or
	 * `executing` submissions.
	 */
	startPolling(): void {
		if (this.timer !== null) {
			return;
		}
		this.isPolling = true;
		this.timer = setInterval(() => {
			void this.poll();
		}, POLL_INTERVAL_MS);
	}

	/** Stop the polling loop (no-op when not polling). */
	stopPolling(): void {
		if (this.timer !== null) {
			clearInterval(this.timer);
			this.timer = null;
		}
		this.isPolling = false;
	}

	/** True while any submission is pending or executing. */
	get hasActiveWork(): boolean {
		return this.submissions.some((s) => ACTIVE_STATUSES.has(s.status));
	}

	/** One polling tick: refresh, then stop when nothing is in flight. */
	private async poll(): Promise<void> {
		if (this.pollInFlight) {
			return;
		}
		this.pollInFlight = true;
		try {
			await this.refresh();
		} finally {
			this.pollInFlight = false;
		}
		this.syncPolling();
	}

	/**
	 * Mark whether a pre-evaluation batch run is in flight. Keeps the 2s list
	 * polling loop alive during a pre-eval run so dashboard rows update live
	 * mid-run (BUG-020) — the pre-evaluate path produces no pending/executing
	 * rows, so row-status polling alone would never keep the loop going.
	 */
	setPreEvalActive(active: boolean): void {
		if (this.preEvalActive === active) {
			return;
		}
		this.preEvalActive = active;
		this.syncPolling();
	}

	/**
	 * Align the polling loop with the current list: start when there is
	 * in-flight work (or an active pre-eval run), stop when everything settled.
	 */
	private syncPolling(): void {
		if (this.hasActiveWork || this.preEvalActive) {
			this.startPolling();
		} else {
			this.stopPolling();
		}
	}

	// -----------------------------------------------------------------------
	// Detail access
	// -----------------------------------------------------------------------

	/** Cached detail for a submission, or null when not loaded yet. */
	getDetail(id: string): SubmissionDetail | null {
		return this.details.get(id) ?? null;
	}

	/**
	 * Load and select a single submission's detail. The detail record's
	 * assignment is adopted as the store's active assignment — a deep link
	 * to `/submissions/[id]` (bookmark/refresh/share) must resolve the
	 * submission's OWN assignment even when it is not the default one, so
	 * save/export/import/grade/reset/delete from the detail page target the
	 * right batch.
	 */
	async select(id: string): Promise<SubmissionDetail> {
		const detail = await fetchSubmission(id, this.assignmentId ?? undefined);
		this.details.set(id, detail);
		this.selected = detail;
		if (detail.assignmentId) {
			this.assignmentId = detail.assignmentId;
		}
		this.applyRecord(detail);
		return detail;
	}

	// -----------------------------------------------------------------------
	// Mutations
	// -----------------------------------------------------------------------

	/**
	 * Upload files to the current assignment (multipart, optional per-file
	 * kind overrides), refresh the list, and start polling while the new
	 * pending records settle.
	 */
	async upload(files: File[], kinds?: Record<string, UploadKind>): Promise<UploadResponse> {
		const assignmentId = this.requireAssignment();
		const response = await uploadSubmissions(files, assignmentId, kinds);
		await this.refresh();
		this.syncPolling();
		return response;
	}

	/**
	 * Upload several files in a SINGLE request, then ONE list refresh + ONE
	 * polling sync. The server's POST /api/submissions/upload accepts any
	 * number of files in one multipart request, so per-file looped uploads
	 * (N × upload → N refreshes) are collapsed here (BUG-018).
	 *
	 * @param entries Files to upload; `kind` is an optional per-file override
	 *   (omit it to let the server auto-detect, matching the old behavior).
	 */
	async uploadMany(
		entries: { file: File; kind?: UploadKind }[],
	): Promise<UploadResponse> {
		const assignmentId = this.requireAssignment();
		const files = entries.map((e) => e.file);
		const kinds: Record<string, UploadKind> = {};
		for (const e of entries) {
			if (e.kind !== undefined) kinds[e.file.name] = e.kind;
		}
		// No overrides → omit the "kinds" field entirely (matches the single
		// upload() wire contract); otherwise send the override map.
		const hasOverrides = Object.keys(kinds).length > 0;
		const response = await uploadSubmissions(files, assignmentId, hasOverrides ? kinds : undefined);
		await this.refresh();
		this.syncPolling();
		return response;
	}

	/** Batch-process submissions (all pending, or the given ids). */
	async process(ids?: string[]): Promise<BatchProcessResponse> {
		const response = await processSubmissions(ids, this.assignmentId ?? undefined);
		await this.refresh();
		this.syncPolling();
		return response;
	}

	/** Persist grading state and merge the updated record into the list. */
	async saveGrading(id: string, grading: GradingPatch): Promise<SubmissionMeta> {
		const record = await saveGradingApi(id, grading, this.assignmentId ?? undefined);
		this.applyRecord(record);
		return record;
	}

	/**
	 * Import a teacher-YAML grading document for one submission and merge the
	 * updated record into the list + detail cache.
	 */
	async importTeacherYaml(id: string, yamlText: string): Promise<SubmissionMeta> {
		const record = await importTeacherYamlApi(id, yamlText, this.assignmentId ?? undefined);
		this.applyRecord(record);
		return record;
	}

	/** Archive (soft-hide) or restore a submission, then refresh the list. */
	async archive(id: string, action: "archive" | "restore" = "archive"): Promise<SubmissionMeta> {
		const record = await archiveSubmissionApi(id, this.requireAssignment(), action);
		this.applyRecord(record);
		await this.refresh();
		return record;
	}

	/** Archive/restore several submissions, then refresh the list once. */
	async archiveMany(ids: string[], action: "archive" | "restore" = "archive"): Promise<void> {
		const assignmentId = this.requireAssignment();
		for (const id of ids) {
			await archiveSubmissionApi(id, assignmentId, action);
		}
		await this.refresh();
	}

	/** Permanently delete a submission, then refresh the list. */
	async delete(id: string): Promise<void> {
		await deleteSubmission(id, this.assignmentId ?? undefined);
		this.details.delete(id);
		if (this.selected?.id === id) {
			this.selected = null;
		}
		await this.refresh();
	}

	/** Permanently delete several submissions, then refresh the list once. */
	async deleteMany(ids: string[]): Promise<void> {
		for (const id of ids) {
			await deleteSubmission(id, this.assignmentId ?? undefined);
			this.details.delete(id);
			if (this.selected?.id === id) {
				this.selected = null;
			}
		}
		await this.refresh();
	}

	/** Reset grading progress for several submissions (status -> "executed"). */
	async resetMany(ids: string[]): Promise<void> {
		for (const id of ids) {
			const record = await resetSubmissionApi(id, this.assignmentId ?? undefined);
			this.applyRecord(record);
		}
		await this.refresh();
	}

	/** Download the grading YAML for one submission (student copy by default). */
	async export(id: string, kind: "student" | "teacher" = "student"): Promise<SubmissionExport> {
		return exportSubmission(id, this.assignmentId ?? undefined, kind);
	}

	// -----------------------------------------------------------------------
	// Internals
	// -----------------------------------------------------------------------

	/** The upload endpoint requires an assignment — fail loudly when absent. */
	private requireAssignment(): string {
		if (this.assignmentId === null) {
			throw new Error("No assignment selected — call load() before uploading");
		}
		return this.assignmentId;
	}

	/**
	 * Merge an updated record into the list (replace by id, else append) and
	 * keep the detail cache + selected view in sync.
	 */
	private applyRecord(record: SubmissionMeta): void {
		const index = this.submissions.findIndex((s) => s.id === record.id);
		if (index === -1) {
			this.submissions = [...this.submissions, record];
		} else {
			this.submissions = [
				...this.submissions.slice(0, index),
				record,
				...this.submissions.slice(index + 1),
			];
		}

		const detail = this.details.get(record.id);
		if (detail) {
			const updated = { ...detail, ...record };
			this.details.set(record.id, updated);
			if (this.selected?.id === record.id) {
				this.selected = updated;
			}
		}
	}
}

/** Singleton store shared by the dashboard and per-submission views. */
export const submissionsStore = new SubmissionsStore();

// ---------------------------------------------------------------------------
// Legacy sync wrappers (kept for existing imports)
// ---------------------------------------------------------------------------

/** Snapshot of the currently loaded submissions. */
export function listSubmissions(): SubmissionMeta[] {
	return [...submissionsStore.submissions];
}

/** Cached detail for one submission, or null when not loaded. */
export function getSubmission(id: string): SubmissionDetail | null {
	return submissionsStore.getDetail(id);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toErrorMessage(err: unknown): string {
	if (err instanceof Error) {
		return err.message;
	}
	return String(err);
}
