/**
 * @file Server-side trigger for the PREBUILT offline docs-index download.
 *
 * POST /api/onboarding/docs-index calls this. It runs
 * scripts/fetch-docs-index.mjs in --public mode — plain HTTPS download of the
 * public release assets; NO API key, NO gh CLI, and NEVER build-docs-index —
 * with --out pointing at <DATA_DIR>/docs-index (or $DOCS_INDEX_DIR).
 *
 * The script stages into .fetch-staging/ inside the target dir and renames
 * into place only after the SHA-256 manifest check passes, so a failed
 * download never leaves a torn index.
 *
 * Since 2.8.1 the download is a TRACKED JOB like the embed rebuild: the
 * script emits `[fetch-docs-index] progress <asset> <received> <total>`
 * lines on stdout, this module parses them into the shared
 * DocsEmbedJobState contract (kind "fetch", done/total = bytes), persists
 * the state file, and the POST returns immediately — the frontend polls
 * GET /api/onboarding/docs-embeddings/status for real progress (MB, rate,
 * ETA) and can cancel via DELETE. Single-flight is shared with the embed
 * rebuild through claimJobSlot/releaseJobSlot (409 on contention).
 *
 * Two entry points:
 *   - startDocsIndexDownload() — NON-BLOCKING: spawns the child, registers
 *     the job, returns as soon as the child is up. Used by the 2.8.1
 *     docs-embeddings POST (the card polls status for progress).
 *   - downloadDocsIndex() — BLOCKING legacy wrapper (the /api/onboarding/
 *     docs-index route): awaits the child's completion and returns the
 *     captured output, preserving the pre-2.8.1 contract.
 */

import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getDataDir } from "$lib/server/metadata";
import {
	cancelAnyDocsEmbedJob,
	getDocsEmbedJobStatus,
	getLiveJob,
	setLiveJob,
	writeJobState,
	type DocsEmbedJobState,
} from "./docs-embed-job-state";

/** fetch-docs-index.mjs relative to this module (src/lib/server → scripts/).
 * Resolution must VERIFY existence: the adapter-node chunk layout puts this
 * module at build/server/chunks/**, where ../../../scripts points at
 * build/scripts (missing) — silently returning it made the child fail with a
 * bare MODULE_NOT_FOUND (clean-slate 2.7.0 runbook finding). Existence-check
 * every candidate; fall back to process.cwd(). */
async function resolveFetchScript(): Promise<string> {
	const candidates = [
		path.resolve(process.cwd(), "scripts/fetch-docs-index.mjs"),
		path.resolve(process.cwd(), "frontend/scripts/fetch-docs-index.mjs"),
		(() => {
			try {
				return fileURLToPath(
					new URL("../../../scripts/fetch-docs-index.mjs", import.meta.url),
				);
			} catch {
				return "";
			}
		})(),
	];
	for (const c of candidates) {
		if (!c) continue;
		try {
			await access(c);
			return c;
		} catch {
			/* try next */
		}
	}
	return candidates[0]!;
}
const INDEX_FILENAME = "docs-index.json";

export interface DocsIndexDownloadResult {
	ok: true;
	/** True when the index was already present — nothing was downloaded. */
	alreadyPresent: boolean;
	/** Captured script stdout (progress log); may be empty. */
	output: string;
}

/** Thrown when another download is already in flight → HTTP 409. */
export class DocsIndexDownloadInProgressError extends Error {
	constructor() {
		super("A docs-index download is already in progress.");
		this.name = "DocsIndexDownloadInProgressError";
	}
}

/** Thrown when the fetch script exits non-zero → HTTP 500 with exit detail. */
export class DocsIndexDownloadFailedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DocsIndexDownloadFailedError";
	}
}

/** Target dir, mirroring docs-rag.getIndexPath() / onboarding status resolution. */
function getDocsIndexDir(): string {
	if (process.env.DOCS_INDEX_DIR) return process.env.DOCS_INDEX_DIR;
	return path.join(getDataDir(), "docs-index");
}

async function indexExists(dir: string): Promise<boolean> {
	try {
		await access(path.join(dir, INDEX_FILENAME));
		return true;
	} catch {
		return false;
	}
}

/**
 * Single-flight job slot, SHARED between the docs-index download (mode A)
 * and the 2.7.0 embed-rebuild job (option B) — claimJobSlot/tryRelease.
 */
let slotOwner: string | null = null;

/** Claim the single docs-index mutation slot. Throws when already held. */
export function claimJobSlot(owner: string): void {
	if (slotOwner !== null) {
		throw new Error(`A docs-index job (${slotOwner}) is already in progress.`);
	}
	slotOwner = owner;
}

/** Release the slot (idempotent for the given owner). */
export function releaseJobSlot(owner: string): void {
	if (slotOwner === owner) slotOwner = null;
}

/** Test hook: force-release the slot (never mid-job in production). */
export function __resetJobSlotForTests(): void {
	slotOwner = null;
}

/** Test hook: drop the in-flight guard + child (never mid-job in production). */
export function __resetDocsIndexDownloadForTests(): void {
	inFlight = null;
	activeChild = null;
}

/** Legacy in-flight promise guard for downloadDocsIndex — mirrors slotOwner. */
let inFlight: Promise<DocsIndexDownloadResult> | null = null;

/** The live child process, so cancel can kill it (checked at close). */
let activeChild: ReturnType<typeof spawn> | null = null;

/** Parse one `[fetch-docs-index] progress <asset> <received> <total>` line. */
function parseProgressLine(line: string): { received: number; total: number } | null {
	const m = /^\[fetch-docs-index\] progress \S+ (\d+) (\d+)$/.exec(line.trim());
	if (!m) return null;
	const received = Number(m[1]);
	const total = Number(m[2]);
	if (!Number.isFinite(received) || !Number.isFinite(total) || total <= 0) return null;
	return { received, total };
}

/**
 * Spawn the fetch child and track it as a job. Resolves when the child
 * closes (the blocking legacy path awaits this; the non-blocking path
 * returns before it settles). Releases the shared slot on completion.
 */
async function spawnFetchChild(dir: string): Promise<DocsIndexDownloadResult> {
	const state: DocsEmbedJobState = {
		kind: "fetch",
		phase: "fetch-chunks",
		startedAt: Date.now(),
		done: 0,
		total: 0,
		ratePerSecond: 0,
		etaSeconds: 0,
		failedBatches: 0,
		model: "prebuilt",
		error: null,
	};
	setLiveJob("fetch", { state, cancelled: false });
	void writeJobState(dir, state);

	const script = await resolveFetchScript();
	const child = spawn(process.execPath, [script, "--public", "--out", dir], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	activeChild = child;
	let stdout = "";
	let stderr = "";
	let lastTick = 0;
	child.stdout?.on("data", (chunk: Buffer) => {
		const text = chunk.toString();
		stdout += text;
		for (const line of text.split("\n")) {
			const p = parseProgressLine(line);
			if (!p) continue;
			state.done = p.received;
			state.total = p.total;
			const now = Date.now();
			const elapsed = (now - state.startedAt) / 1000;
			if (elapsed > 0.5 && now - lastTick >= 500) {
				state.ratePerSecond = state.done / elapsed;
				state.etaSeconds =
					state.ratePerSecond > 0
						? Math.round((state.total - state.done) / state.ratePerSecond)
						: 0;
				lastTick = now;
				void writeJobState(dir, state);
			}
		}
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});

	const run = (async (): Promise<DocsIndexDownloadResult> => {
		try {
			const code = await new Promise<number | null>((resolve, reject) => {
				child.once("close", resolve);
				child.once("error", reject);
			});
			activeChild = null;
			if (code !== 0) {
				const cancelled = getLiveJob("fetch")?.cancelled === true;
				if (cancelled) {
					state.error = "Docs-index download cancelled.";
					state.phase = "cancelled";
					await writeJobState(dir, state);
					setLiveJob("fetch", null);
					return { ok: true, alreadyPresent: false, output: stdout };
				}
				const tail = (stderr || stdout).trim().split("\n").slice(-6).join("\n");
				state.error = `docs-index fetch exited with code ${code}${tail ? `: ${tail}` : ""}`;
				state.phase = "failed";
				await writeJobState(dir, state);
				setLiveJob("fetch", null);
				throw new DocsIndexDownloadFailedError(state.error);
			}
			state.phase = "done";
			state.done = state.total;
			await writeJobState(dir, state);
			setLiveJob("fetch", null);
			return { ok: true, alreadyPresent: false, output: stdout };
		} finally {
			releaseJobSlot("docs-index-download");
		}
	})();
	return run;
}

/**
 * NON-BLOCKING start: spawns the fetch child, registers the job, returns as
 * soon as the child is up. The frontend polls GET
 * /api/onboarding/docs-embeddings/status for progress and cancels via DELETE.
 */
export async function startDocsIndexDownload(): Promise<{ ok: true; alreadyPresent: boolean }> {
	const dir = getDocsIndexDir();
	if (await indexExists(dir)) {
		return { ok: true, alreadyPresent: true };
	}
	if (inFlight) {
		throw new DocsIndexDownloadInProgressError();
	}
	claimJobSlot("docs-index-download");
	const run = spawnFetchChild(dir);
	inFlight = run;
	// Clean the guard on completion; swallow the rejection here — the
	// blocking legacy path (downloadDocsIndex) and the status contract
	// surface failures, this fire-and-forget cleanup must not.
	void run.finally(() => {
		if (inFlight === run) inFlight = null;
	}).catch(() => {});
	return { ok: true, alreadyPresent: false };
}

/**
 * BLOCKING legacy wrapper (the /api/onboarding/docs-index route): starts the
 * download and awaits completion, returning the captured output. Preserves
 * the pre-2.8.1 contract for that route.
 */
export async function downloadDocsIndex(): Promise<DocsIndexDownloadResult> {
	const started = await startDocsIndexDownload();
	if (started.alreadyPresent) {
		return { ok: true, alreadyPresent: true, output: "" };
	}
	const run = inFlight;
	if (!run) {
		return { ok: true, alreadyPresent: false, output: "" };
	}
	return run;
}

/** Cancel the running download job: kill the child, mark the state cancelled. */
export function cancelDocsIndexDownload(): boolean {
	const cancelled = cancelAnyDocsEmbedJob();
	if (cancelled && activeChild) {
		// The child's close handler observes the non-zero exit and writes
		// the failed state — but a user-initiated cancel must read as
		// "cancelled", not "failed". The close handler checks the flag.
		activeChild.kill("SIGTERM");
	}
	return cancelled;
}

/** Status for the download job — shared contract (delegates). */
export function getDocsIndexDownloadStatus(): Promise<DocsEmbedJobState | null> {
	return getDocsEmbedJobStatus();
}
