/**
 * @file Shared docs-index job state — the single status contract for BOTH
 * the prebuilt download (kind "fetch") and the local embed rebuild (kind
 * "embed").
 *
 * The 2.7.0 embed runner persisted its job to `DATA_DIR/docs-index/
 * .docs-embed-job.json` so a browser refresh survives and a process crash
 * surfaces as `interrupted`. The 2.8.1 download job uses the SAME file and
 * contract — the status endpoint must answer one coherent job regardless
 * of which kind is running, and the single-flight slot already serializes
 * the two kinds.
 *
 * Live jobs are registered here (module memory) by each runner; the
 * persisted file is the cross-restart truth. `getDocsEmbedJobStatus()`
 * prefers a live job, then the persisted file (non-terminal persisted
 * state with no live owner reads as `interrupted` — crash recovery).
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { getDataDir } from "$lib/server/metadata";

export const STATE_FILENAME = ".docs-embed-job.json";

export type JobKind = "fetch" | "embed";
export type JobPhase =
	| "fetch-chunks"
	| "embed"
	| "finalize"
	| "done"
	| "failed"
	| "cancelled"
	| "interrupted";

/** Shape served by GET /api/onboarding/docs-embeddings/status (doc §4.1). */
export interface DocsEmbedJobState {
	kind: JobKind;
	phase: JobPhase;
	startedAt: number;
	/** Embedded chunk count (embed) / bytes received (fetch). */
	done: number;
	/** Total chunks expected (embed) / total bytes (fetch). */
	total: number;
	/** Sliding-window rate, texts/second (embed) / bytes/second (fetch). */
	ratePerSecond: number;
	/** Whole seconds remaining at the current rate (0 when rate is 0). */
	etaSeconds: number;
	failedBatches: number;
	/** Embedding model the job resolved at POST time (snapshot). */
	model: string;
	error: string | null;
}

/** One live job slot per kind (single-flight is enforced by the slot owner). */
interface LiveJob {
	state: DocsEmbedJobState;
	cancelled: boolean;
}

const liveJobs: Partial<Record<JobKind, LiveJob>> = {};

/** Register (or clear) the live job for a kind. */
export function setLiveJob(kind: JobKind, job: LiveJob | null): void {
	if (job === null) delete liveJobs[kind];
	else liveJobs[kind] = job;
}

/** The live job for a kind, or null. */
export function getLiveJob(kind: JobKind): LiveJob | null {
	return liveJobs[kind] ?? null;
}

/** Request cancellation of the live job for a kind (checked at boundaries). */
export function requestCancel(kind: JobKind): boolean {
	const job = liveJobs[kind];
	if (!job) return false;
	job.cancelled = true;
	return true;
}

/** Cancel whichever kind is live (the DELETE route's contract). */
export function cancelAnyDocsEmbedJob(): boolean {
	if (liveJobs.fetch) {
		liveJobs.fetch.cancelled = true;
		return true;
	}
	if (liveJobs.embed) {
		liveJobs.embed.cancelled = true;
		return true;
	}
	return false;
}

/** Test hook: drop all live jobs (never mid-job in production). */
export function __resetDocsEmbedJobsForTests(): void {
	for (const k of Object.keys(liveJobs) as JobKind[]) delete liveJobs[k];
}

export async function writeJobState(dir: string, state: DocsEmbedJobState): Promise<void> {
	try {
		await writeFile(path.join(dir, STATE_FILENAME), JSON.stringify(state, null, 1));
	} catch {
		// A failed telemetry write must never crash the job loop; the
		// in-process state stays authoritative while this process is alive.
	}
}

export async function readJobState(dir: string): Promise<DocsEmbedJobState | null> {
	try {
		return JSON.parse(
			await readFile(path.join(dir, STATE_FILENAME), "utf-8"),
		) as DocsEmbedJobState;
	} catch {
		return null;
	}
}

/**
 * GET-status core: a live job wins; otherwise the persisted state file —
 * a NON-terminal persisted state with no live owner reads as `interrupted`
 * (process died mid-job, crash recovery). Terminal phases are the job's
 * own verdict and surface verbatim. Never throws.
 */
export async function getDocsEmbedJobStatus(): Promise<DocsEmbedJobState | null> {
	if (liveJobs.fetch) return liveJobs.fetch.state;
	if (liveJobs.embed) return liveJobs.embed.state;
	const dir = getIndexDir();
	const persisted = await readJobState(dir);
	if (!persisted) return null;
	const terminal = ["done", "failed", "cancelled"];
	return terminal.includes(persisted.phase) ? persisted : { ...persisted, phase: "interrupted" };
}

function getIndexDir(): string {
	if (process.env.DOCS_INDEX_DIR) return process.env.DOCS_INDEX_DIR;
	return path.join(getDataDir(), "docs-index");
}
