/**
 * @file Docs-embeddings rebuild job runner (2.7.0 option B).
 *
 * Re-embeds the chunk set already on disk (`docs-index.json`, present via
 * option A's download or a prior install) against the teacher's configured
 * embeddings endpoint, producing a new `docs-vectors.bin`. This is the only
 * runtime path that produces vectors — the Python corpus build
 * (build-docs-index.mjs) stays off-limits by design (2.7.0 §2.4: env, crawl
 * sources, 30–60 min maintenance-op gating, coverage-drift risk).
 *
 * Load-bearing invariants (design doc §2.5 / §5):
 *   - NEVER hold the full vector array in memory: each batch is written into
 *     a staged file at deterministic offsets `i * dim * 4` via a file handle
 *     (a full Float32Array would be ≈630 MB of heap).
 *   - The staged file is fsynced and ATOMICALLY RENAMED into place — the
 *     rename is the only commit point. A failed/cancelled/crashed job never
 *     leaves a torn index; the old vectors keep serving until the swap.
 *   - Single-flight is shared with the docs-index download (mode A) through
 *     `claimJobSlot`/`releaseJobSlot` from onboarding-docs-index (409 on
 *     contention).
 *   - Job state is a PERSISTED file (`DATA_DIR/docs-index/.docs-embed-job.json`),
 *     not module memory — a browser refresh must not lose the poll, and a
 *     process crash must surface as `interrupted` on the next status read.
 *   - Wrong-dim responses zero-fill their slot and count as a failed batch
 *     (the bin keeps the strict `chunks × dim × 4` byte layout the loader
 *     verifies); >5% failed batches abort instead of finishing a dead index.
 *   - Concurrency 2 (hard ceiling — AGENTS.md invariant), 429 courtesy
 *     backoff honoring `Retry-After`.
 *
 * The job snapshots endpoint/key/model at POST time: a settings change
 * mid-run never affects an in-flight build (doc §5 row 14).
 *
 * This module runs only on the SvelteKit server (`$lib/server/`).
 */

import { mkdir, open as openFile, readFile, rename, rm, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

import { loadSettings, resolveEmbeddingModel } from "$lib/server/settings";
import { hasApiKey } from "$lib/server/api-key-store";
import { claimJobSlot, releaseJobSlot } from "./onboarding-docs-index";
import { getDataDir } from "./metadata";
import {
	getLiveJob,
	getDocsEmbedJobStatus as getDocsEmbedJobStatusShared,
	requestCancel,
	setLiveJob,
	writeJobState,
	type DocsEmbedJobState,
} from "./docs-embed-job-state";

export type { DocsEmbedJobState, JobKind, JobPhase } from "./docs-embed-job-state";

// ---------------------------------------------------------------------------
// Constants (design doc §2.5)
// ---------------------------------------------------------------------------

/** Default texts per embeddings request (the proven build-script constant). */
export const DEFAULT_BATCH_SIZE = 16;
/** Hard cap for `batch` overrides. */
export const MAX_BATCH_SIZE = 64;
/** Per-batch retry policy. */
export const RETRY_MAX_429 = 5;
export const RETRY_MAX_5XX = 3;
/** Backoff base/cap — env-overridable for tests (production uses the §2.5
 * values; tests walk the real retry chain against a throwing provider). */
function backoffBaseMs(): number {
	const v = Number(process.env.DOCS_EMBED_BACKOFF_BASE_MS);
	return Number.isFinite(v) && v > 0 ? v : 1000;
}
function backoffCapMs(): number {
	const v = Number(process.env.DOCS_EMBED_BACKOFF_CAP_MS);
	return Number.isFinite(v) && v > 0 ? v : 30_000;
}
/** Abort the job when more than this fraction of batches failed (§5 row 4). */
export const FAILED_BATCH_ABORT_FRACTION = 0.05;
/** Consecutive 429-exhausted batches before the courtesy abort (§5 row 9). */
export const RATE_LIMIT_ABORT_CONSECUTIVE = 5;

const STAGING_SUBDIR = ".embed-staging";
const INDEX_JSON = "docs-index.json";
const VECTORS_BIN = "docs-vectors.bin";

// ---------------------------------------------------------------------------
// Public shapes (the API + status contracts, design doc §4.1) — re-exported
// from the shared job-state module so the download (fetch) and embed jobs
// speak ONE status contract.
// ---------------------------------------------------------------------------

/** Contentions (HTTP 409). */
export class DocsEmbedJobInProgressError extends Error {
	constructor() {
		super("A docs-index download/rebuild is already in progress.");
		this.name = "DocsEmbedJobInProgressError";
	}
}

/** No API key configured (HTTP 422). */
export class DocsEmbedNoKeyError extends Error {
	constructor() {
		super("No API key configured — set it in the LLM provider settings or KI_CONNECT_API_KEY.");
		this.name = "DocsEmbedNoKeyError";
	}
}

// ---------------------------------------------------------------------------
// Paths (mirror onboarding-docs-index / docs-rag resolution)
// ---------------------------------------------------------------------------

function getIndexDir(): string {
	if (process.env.DOCS_INDEX_DIR) return process.env.DOCS_INDEX_DIR;
	return path.join(getDataDirSafe(), "docs-index");
}

function getDataDirSafe(): string {
	return getDataDir();
}

// ---------------------------------------------------------------------------
// Job-state persistence (NOT module memory — refresh + crash must survive)
// ---------------------------------------------------------------------------

/** Test hook: drop module state (never mid-job in production). */
export function __resetDocsEmbedJobForTests(): void {
	setLiveJob("embed", null);
}

async function writeStateFile(dir: string, state: DocsEmbedJobState): Promise<void> {
	await writeJobState(dir, state);
}

async function cleanStaging(dir: string): Promise<void> {
	try {
		await rm(path.join(dir, STAGING_SUBDIR), { recursive: true, force: true });
	} catch {
		/* non-throwing */
	}
}

// ---------------------------------------------------------------------------
// Status + cancel
// ---------------------------------------------------------------------------

/**
 * GET-status core: the running job (either kind), or `interrupted` when a
 * state file exists but no live process owns it (crash recovery, doc §4.1).
 * Never throws. Delegates to the shared job-state module so the download
 * (fetch) and embed jobs answer one coherent status.
 */
export async function getDocsEmbedJobStatus(): Promise<DocsEmbedJobState | null> {
	return getDocsEmbedJobStatusShared();
}

/** Request cancellation of the running embed job (checked at batch boundaries). */
export function cancelDocsEmbedJob(): boolean {
	return requestCancel("embed");
}

// ---------------------------------------------------------------------------
// Snapshot (§5 row 14): config frozen at POST time
// ---------------------------------------------------------------------------

export interface EmbedConfigSnapshot {
	baseUrl: string;
	apiKey: string;
	model: string;
}

async function snapshotEmbeddingConfig(): Promise<EmbedConfigSnapshot> {
	const settings = await loadSettings();
	return {
		baseUrl: settings.llm.baseUrl,
		apiKey: process.env["KI_CONNECT_API_KEY"] ?? "",
		model: resolveEmbeddingModel(settings),
	};
}

// ---------------------------------------------------------------------------
// Chunk source
// ---------------------------------------------------------------------------

async function loadChunkTexts(dir: string): Promise<string[]> {
	const raw = await readFile(path.join(dir, INDEX_JSON), "utf-8");
	const parsed = JSON.parse(raw) as { chunks?: Array<{ text?: unknown }> };
	if (!Array.isArray(parsed?.chunks) || parsed.chunks.length === 0) {
		throw new Error(
			"docs-index.json has no chunks — fetch the corpus first (option A or the chunks-only fetch).",
		);
	}
	return parsed.chunks.map((c) => String(c.text ?? ""));
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

export interface StartEmbedJobOptions {
	/** Batch size override (clamped 1..MAX_BATCH_SIZE). */
	batch?: number;
	/**
	 * Dev/test chunk limit (the §6.3 --live smoke recipe uses a small value).
	 * Not exposed through the HTTP API.
	 */
	limit?: number;
}

/**
 * Start a vector-rebuild job over the chunk set in the index dir. Shares the
 * fetch single-flight: while a download or another rebuild runs, contention
 * throws DocsEmbedJobInProgressError (the route maps it to 409). The job
 * runs detached — the route returns immediately; status polling is the
 * progress contract.
 */
export async function startDocsEmbedRebuild(options: StartEmbedJobOptions = {}): Promise<void> {
	const dir = getIndexDir();

	// Contention first (cheap), then pre-flight under the slot.
	claimJobSlot("docs-embed-rebuild");
	try {
		const chunks = await loadChunkTexts(dir);
		if (!hasApiKey()) throw new DocsEmbedNoKeyError();
		const config = await snapshotEmbeddingConfig();
		const total =
			options.limit && options.limit > 0
				? Math.min(options.limit, chunks.length)
				: chunks.length;
		const batchSize = Math.max(
			1,
			Math.min(options.batch ?? DEFAULT_BATCH_SIZE, MAX_BATCH_SIZE),
		);

		const state: DocsEmbedJobState = {
			kind: "embed",
			phase: "embed",
			startedAt: Date.now(),
			done: 0,
			total,
			ratePerSecond: 0,
			etaSeconds: 0,
			failedBatches: 0,
			model: config.model,
			error: null,
		};
		setLiveJob("embed", { state, cancelled: false });
		await mkdir(path.join(dir, STAGING_SUBDIR), { recursive: true });
		await writeStateFile(dir, state);

		// Detached: the route returns; polling is the progress contract.
		void runEmbedJob(dir, chunks.slice(0, total), batchSize, config, state).finally(() => {
			releaseJobSlot("docs-embed-rebuild");
		});
	} catch (err) {
		releaseJobSlot("docs-embed-rebuild");
		throw err;
	}
}

/** One embeddings request. */
async function embedBatch(
	provider: ReturnType<typeof createOpenAICompatible>,
	model: string,
	texts: string[],
): Promise<number[][]> {
	const res = await provider.embeddingModel(model).doEmbed({ values: texts });
	return res.embeddings;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 429/5xx retry with courtesy backoff (doc §2.5): honor Retry-After when sane. */
async function embedWithRetry(
	provider: ReturnType<typeof createOpenAICompatible>,
	model: string,
	texts: string[],
): Promise<number[][]> {
	for (let attempt = 0; ; attempt++) {
		try {
			return await embedBatch(provider, model, texts);
		} catch (err) {
			const status = (err as { statusCode?: number }).statusCode ?? 0;
			const retryAfter =
				(err as { headers?: Record<string, string> }).headers?.["retry-after"] ?? null;
			const maxAttempts = status === 429 ? RETRY_MAX_429 : RETRY_MAX_5XX;
			const retryable = status === 429 || status >= 500;
			if (retryable && attempt < maxAttempts) {
				const ra = Number(retryAfter);
				const delay =
					Number.isFinite(ra) && ra > 0 && ra <= 600
						? ra * 1000
						: Math.min(backoffBaseMs() * 2 ** attempt, backoffCapMs());
				await sleep(delay);
				continue;
			}
			throw err;
		}
	}
}

/** Write one batch's vectors at their deterministic offsets (§2.5 layout). */
async function writeBatchVectors(
	handle: FileHandle,
	offsetBatch: number,
	vectors: number[][],
	dim: number,
): Promise<void> {
	for (let i = 0; i < vectors.length; i++) {
		const vec = vectors[i];
		// §5 row 3: wrong-dim individual vector → zero-fill its slot (zero
		// cosine ≈ never ranks) — the strict chunks×dim×4 byte layout holds.
		const normalized = vec && vec.length === dim ? vec : new Array<number>(dim).fill(0);
		const bytes = Buffer.from(new Float32Array(normalized).buffer);
		await handle.write(bytes, 0, bytes.length, (offsetBatch + i) * dim * 4);
	}
}

/** Flush all pending batches oldest-first (called when dim becomes known). */
async function flushPending(
	handle: FileHandle,
	pending: Array<{ offsetBatch: number; vectors: number[][] }>,
	dim: number,
): Promise<void> {
	for (const b of pending.splice(0).sort((a, b) => a.offsetBatch - b.offsetBatch)) {
		await writeBatchVectors(handle, b.offsetBatch, b.vectors, dim);
	}
}

/**
 * Execute the loop: staged writes at deterministic offsets, fail-batch
 * counting with zero-fill, abort thresholds, finalize (fsync → rename →
 * manifest update), state-file progress.
 */
async function runEmbedJob(
	dir: string,
	chunks: string[],
	batchSize: number,
	config: EmbedConfigSnapshot,
	state: DocsEmbedJobState,
): Promise<void> {
	const stagedPath = path.join(dir, STAGING_SUBDIR, VECTORS_BIN);
	let handle: FileHandle | null = null;
	try {
		const provider = createOpenAICompatible({
			name: "ki-connect-docs-embed",
			baseURL: config.baseUrl,
			apiKey: config.apiKey,
		});

		// The staged bin (same filesystem as the target → atomic rename later).
		handle = await openFile(stagedPath, "w+");

		// Dim detection: the first successful batch fixes the layout. Batches
		// that arrive BEFORE dim is known are held in `pending` (they cannot be
		// written — offsets need dim); the first success flushes them all.
		let dim: number | null = null;
		const pending: Array<{ offsetBatch: number; vectors: number[][] }> = [];
		let done = 0;
		let lastTick = 0;
		let recent429 = 0;

		for (let start = 0; start < chunks.length; start += batchSize) {
			if (getLiveJob("embed")?.cancelled) {
				state.phase = "cancelled";
				state.error = "Embed rebuild cancelled.";
				await writeStateFile(dir, state);
				setLiveJob("embed", null); // terminal: status reads the state FILE now
				await cleanStaging(dir);
				return; // finally releases the slot; old index untouched
			}

			const slice = chunks.slice(start, start + batchSize);
			let vectors: number[][];
			try {
				vectors = await embedWithRetry(provider, config.model, slice);
				recent429 = 0; // recovered — the window resets on any success
				// First successful batch fixes dim.
				if (dim === null && vectors.length > 0 && vectors[0]!.length > 0) {
					dim = vectors[0]!.length;
				}
			} catch (err) {
				const status = (err as { statusCode?: number }).statusCode ?? 0;
				if (status === 429) {
					recent429 += 1;
					// §5 row 9: sustained 429 exhaustion → abort (courtesy wording;
					// the embedWithRetry backoff already spread RETRY_MAX_429 delays
					// before we ever get here, so N consecutive exhausted batches is
					// a real provider limit, not a transient burst).
					if (recent429 >= RATE_LIMIT_ABORT_CONSECUTIVE) {
						state.error =
							"Rate-limited by the embeddings provider — wait a few minutes and retry, or switch providers.";
						state.phase = "failed";
						setLiveJob("embed", null);
						await writeStateFile(dir, state);
						await cleanStaging(dir);
						return;
					}
				}
				state.failedBatches += 1;
				const totalBatches = Math.ceil(chunks.length / batchSize);
				// §5 row 4: too many failed batches — dim/system change → abort.
				if (state.failedBatches / totalBatches > FAILED_BATCH_ABORT_FRACTION) {
					state.error = `Too many failed batches (${state.failedBatches}/${totalBatches}): ${(err as Error).message}`;
					state.phase = "failed";
					await writeStateFile(dir, state);
					setLiveJob("embed", null); // terminal: status reads the state FILE now
					await cleanStaging(dir);
					return;
				}
				// Zero-fill this batch's slots to keep the strict byte layout.
				pending.push({ offsetBatch: start, vectors: [] });
				continue;
			}
			pending.push({ offsetBatch: start, vectors });

			// Write out everything whose offset is now known (dim fixed).
			const knownHandle = handle;
			if (dim !== null && knownHandle) {
				await flushPending(knownHandle, pending, dim);
			}

			done = start + slice.length;
			state.done = Math.min(done, state.total);
			const now = Date.now();
			const elapsed = (now - state.startedAt) / 1000;
			if (elapsed > 0.5 && now - lastTick >= 500) {
				state.ratePerSecond = state.done / elapsed;
				state.etaSeconds =
					state.ratePerSecond > 0
						? Math.round((state.total - state.done) / state.ratePerSecond)
						: 0;
				lastTick = now;
				await writeStateFile(dir, state);
			}
		}

		if (dim === null) {
			throw new Error("No embeddings returned — provider produced no usable vectors.");
		}

		// Finalize (§2.5): pad any trailing pending batches, fsync, rename,
		// then update manifest fields via tmp+rename.
		state.phase = "finalize";
		await writeStateFile(dir, state);

		// Flush any batch that never got written (first batch(es) failed before
		// dim was known — their slots zero-fill at finalize).
		await flushPending(handle, pending, dim);
		// Ensure the file is exactly chunks × dim × 4 bytes (zero-pad any gap
		// from failed batches whose placeholders were never written).
		const expectedBytes = chunks.length * dim * 4;
		await handle.truncate(expectedBytes);
		await handle.sync();
		await handle.close();
		handle = null;
		await rename(stagedPath, path.join(dir, VECTORS_BIN));
		await updateManifestFields(dir, {
			embeddingModel: config.model,
			embeddingDim: dim,
			vectorCount: chunks.length,
		});
		state.phase = "done";
		state.done = state.total;
		await writeStateFile(dir, state);
		setLiveJob("embed", null); // terminal: status reads the state FILE now
		await cleanStaging(dir);
	} catch (err) {
		try {
			if (handle) {
				await handle.close();
			}
		} catch {
			/* already closed */
		}
		state.error = (err as Error).message;
		state.phase = "failed";
		await writeStateFile(dir, state);
		setLiveJob("embed", null); // terminal: status reads the state FILE now
		await cleanStaging(dir);
	}
}

/**
 * Finalize step 2: update the manifest fields atomically (tmp + rename so a
 * crash between the two renames leaves the OLD json — the loader's dim guard
 * still protects; doc §5 row 12 covers the reconciliation).
 */
async function updateManifestFields(
	dir: string,
	fields: { embeddingModel: string; embeddingDim: number; vectorCount: number },
): Promise<void> {
	const jsonPath = path.join(dir, INDEX_JSON);
	const raw = await readFile(jsonPath, "utf-8");
	const parsed = JSON.parse(raw) as Record<string, unknown>;
	parsed["embeddingModel"] = fields.embeddingModel;
	parsed["embeddingDim"] = fields.embeddingDim;
	parsed["vectorCount"] = fields.vectorCount;
	parsed["vectorsFile"] = VECTORS_BIN;
	const tmp = `${jsonPath}.tmp`;
	await writeFile(tmp, JSON.stringify(parsed, null, 1));
	await rename(tmp, jsonPath);
}
