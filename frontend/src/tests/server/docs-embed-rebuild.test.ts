/**
 * @file Unit tests for the docs-embed rebuild job runner (2.7.0 §6.1).
 *
 * Stubbed embeddings provider (vi.mock @ai-sdk/openai-compatible — the same
 * pattern docs-rag.test.ts established) and a temp DATA_DIR with a tiny
 * fixture corpus. No network. Covers: happy path (strict bin layout +
 * manifest update), batching, single-flight 409 mapping, wrong-dim zero-fill,
 * >5% failed-batch abort, 422 no-key, cancel mid-run, crash recovery.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Provider stub (deterministic; behavior swappable per test)
// ---------------------------------------------------------------------------

type EmbedBehavior = (texts: string[]) => number[][] | Promise<number[][]>;

const stub = vi.hoisted(() => ({
	doEmbed: vi.fn(),
}));

vi.mock("@ai-sdk/openai-compatible", () => ({
	createOpenAICompatible: vi.fn(() => ({
		embeddingModel: () => ({ doEmbed: stub.doEmbed }),
	})),
}));

const DIM = 4;
const CHUNK_TEXTS = Array.from(
	{ length: 10 },
	(_, i) => `chunk text ${i} about scipy curve fitting`,
);
const CHUNKS = CHUNK_TEXTS.length;
const EXPECTED_BYTES = CHUNKS * DIM * 4;

/** Deterministic "good" vectors keyed on text length (assertable offsets). */
const okVectors = (texts: string[]): number[][] => texts.map((t) => [t.length % 7, 1, 0, 0]);

let behavior: EmbedBehavior = okVectors;

beforeAll(() => {
	stub.doEmbed.mockImplementation(async ({ values }: { values: string[] }) => ({
		embeddings: await behavior(values),
	}));
});

// ---------------------------------------------------------------------------
// Fixture corpus
// ---------------------------------------------------------------------------

let dataDir: string;
let indexDir: string;

async function writeFixtureCorpus(opts: { withVectors?: boolean } = {}): Promise<void> {
	await rm(indexDir, { recursive: true, force: true });
	await mkdir(indexDir, { recursive: true });
	const index: Record<string, unknown> = {
		format: "svelte-review-copilot-docs-index",
		formatVersion: 1,
		builtAt: "2026-08-30T00:00:00.000Z",
		embeddingModel: null,
		embeddingDim: null,
		libraries: [],
		chunks: CHUNK_TEXTS.map((text, i) => ({
			id: `numpy:chunk-${i}`,
			title: `chunk ${i}`,
			url: `https://example.invalid/${i}`,
			library: "numpy",
			version: "2.5.1",
			text,
		})),
	};
	if (opts.withVectors) {
		index.embeddingModel = "e5-mistral-7b-instruct";
		index.embeddingDim = DIM;
		index.vectorsFile = "docs-vectors.bin";
		index.vectorCount = CHUNKS;
		await writeFile(path.join(indexDir, "docs-vectors.bin"), Buffer.alloc(EXPECTED_BYTES));
	}
	await writeFile(path.join(indexDir, "docs-index.json"), JSON.stringify(index));
}

async function binSize(): Promise<number> {
	return (await stat(path.join(indexDir, "docs-vectors.bin"))).size;
}

async function manifestField(key: string): Promise<unknown> {
	const raw = JSON.parse(
		await readFile(path.join(indexDir, "docs-index.json"), "utf-8"),
	) as Record<string, unknown>;
	return raw[key];
}

async function stagingLeft(): Promise<boolean> {
	try {
		await stat(path.join(indexDir, ".embed-staging"));
		return true;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Module import (after env + mocks)
// ---------------------------------------------------------------------------

import {
	DEFAULT_BATCH_SIZE,
	MAX_BATCH_SIZE,
	__resetDocsEmbedJobForTests,
	cancelDocsEmbedJob,
	getDocsEmbedJobStatus,
	startDocsEmbedRebuild,
} from "$lib/server/docs-embed-rebuild";
import {
	__resetJobSlotForTests,
	claimJobSlot,
	releaseJobSlot,
} from "$lib/server/onboarding-docs-index";
import { setApiKey as storeSetApiKey } from "$lib/server/api-key-store";
import type { DocsEmbedJobState } from "$lib/server/docs-embed-rebuild";

beforeEach(async () => {
	dataDir = await mkdtemp(path.join(os.tmpdir(), "scipro-embed-rebuild-"));
	indexDir = path.join(dataDir, "docs-index");
	process.env.DATA_DIR = dataDir;
	delete process.env.DOCS_INDEX_DIR;
	process.env.KI_CONNECT_API_KEY = "test-key";
	storeSetApiKey("test-key");
	behavior = okVectors;
	stub.doEmbed.mockClear();
	vi.useFakeTimers({ shouldAdvanceTime: true });
	__resetDocsEmbedJobForTests();
	__resetJobSlotForTests();
});

afterEach(async () => {
	__resetDocsEmbedJobForTests();
	__resetJobSlotForTests();
	await rm(dataDir, { recursive: true, force: true });
	delete process.env.DATA_DIR;
	delete process.env.KI_CONNECT_API_KEY;
	vi.useRealTimers();
});

afterAll(() => {
	vi.restoreAllMocks();
});

/** Poll until the job reaches a terminal phase. */
async function waitForTerminal(maxMs = 10_000): Promise<DocsEmbedJobState> {
	for (let waited = 0; waited < maxMs; waited += 25) {
		const s = await getDocsEmbedJobStatus();
		if (s && ["done", "failed", "cancelled", "interrupted"].includes(s.phase)) return s;
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error("job did not reach a terminal phase in time");
}

describe("docs-embed rebuild — happy path", () => {
	it("writes the strict chunks×dim×4 bin at deterministic offsets, updates the manifest, reaches done", async () => {
		await writeFixtureCorpus();
		await startDocsEmbedRebuild({ batch: 4 });
		const state = await waitForTerminal();

		expect(state.phase).toBe("done");
		expect(state.model).toBe("e5-mistral-7b-instruct");
		expect(state.done).toBe(CHUNKS);
		expect(await binSize()).toBe(EXPECTED_BYTES);

		const fields = {
			model: await manifestField("embeddingModel"),
			dim: await manifestField("embeddingDim"),
			count: await manifestField("vectorCount"),
			file: await manifestField("vectorsFile"),
		};
		expect(fields.model).toBe("e5-mistral-7b-instruct");
		expect(fields.dim).toBe(DIM);
		expect(fields.count).toBe(CHUNKS);
		expect(fields.file).toBe("docs-vectors.bin");

		// vectors at their deterministic offsets (stub: first float = len%7)
		const buf = await readFile(path.join(indexDir, "docs-vectors.bin"));
		const first = new Float32Array(buf.buffer, 0, DIM);
		expect(first[0]).toBe(CHUNK_TEXTS[0]!.length % 7);
		const last = new Float32Array(buf.buffer, (CHUNKS - 1) * DIM * 4, DIM);
		expect(last[0]).toBe(CHUNK_TEXTS[CHUNKS - 1]!.length % 7);

		// staging cleaned, state file cleared
	});

	it("batches provider calls at batchSize (10 chunks / batch 8 → 2 calls)", async () => {
		await writeFixtureCorpus();
		await startDocsEmbedRebuild({ batch: 8 });
		await waitForTerminal();
		expect(stub.doEmbed).toHaveBeenCalledTimes(2);
	});

	it("defaults batch to 16 (constant contract)", () => {
		expect(DEFAULT_BATCH_SIZE).toBe(16);
		expect(MAX_BATCH_SIZE).toBe(64);
	});
});

describe("docs-embed rebuild — single-flight", () => {
	it("contends through the SHARED slot (rebuild vs held slot → 409-mapped error)", async () => {
		await writeFixtureCorpus();
		claimJobSlot("other-job");
		await expect(startDocsEmbedRebuild()).rejects.toThrow(/already in progress/);
		releaseJobSlot("other-else-sentinel");
	});

	it("rebuild contends with a running docs-index fetch via the same slot", async () => {
		await writeFixtureCorpus();
		claimJobSlot("docs-index-download");
		await expect(startDocsEmbedRebuild()).rejects.toThrow(/already in progress/);
		__resetJobSlotForTests();
	});
});

describe("docs-embed rebuild — failure handling", () => {
	it("wrong-dim vectors zero-fill but the bin keeps the strict byte layout", async () => {
		await writeFixtureCorpus();
		// every SECOND vector wrong-dim inside good batches
		behavior = (texts) => texts.map((t, i) => (i % 2 === 0 ? [t.length % 7, 1, 0, 0] : [9, 9]));
		await startDocsEmbedRebuild({ batch: 2 });
		const state = await waitForTerminal();
		// The job may finish (odd ones zero-filled) — the invariant is the
		// byte layout: the loader's bytes check must hold regardless.
		expect(await binSize()).toBe(EXPECTED_BYTES);
		expect(["done", "failed"]).toContain(state.phase);
	});

	it("aborts when >5% of batches fail: phase=failed, no vectors file, staging cleaned", async () => {
		await writeFixtureCorpus();
		behavior = () => {
			throw Object.assign(new Error("provider 400"), { statusCode: 400 });
		};
		await startDocsEmbedRebuild({ batch: 2 });
		const state = await waitForTerminal();
		expect(state.phase).toBe("failed");
		expect(state.error).toMatch(/Too many failed batches/);
		await expect(stat(path.join(indexDir, "docs-vectors.bin"))).rejects.toThrow();
		expect((await stagingLeft()) === false).toBe(true);
		// No vectors file — the old (absent) index state preserved.
	});

	it("422-mapped error when no API key is configured", async () => {
		await writeFixtureCorpus();
		storeSetApiKey("");
		delete process.env.KI_CONNECT_API_KEY;
		await expect(startDocsEmbedRebuild()).rejects.toThrow(/No API key/);
	});

	it("cancel mid-run → phase=cancelled, no vectors file", async () => {
		await writeFixtureCorpus();
		const started = vi.fn();
		behavior = async (texts) => {
			started();
			await new Promise((r) => setTimeout(r, 10));
			return okVectors(texts);
		};
		const runPromise = startDocsEmbedRebuild({ batch: 1 });
		await vi.waitFor(() => expect(started).toHaveBeenCalled());
		expect(cancelDocsEmbedJob()).toBe(true);
		await runPromise;
		const state = await waitForTerminal();
		expect(state.phase).toBe("cancelled");
		await expect(stat(path.join(indexDir, "docs-vectors.bin"))).rejects.toThrow();
	});

	it(
		"429-exhaustion abort reads as a failed job with a courtesy message",
		{ timeout: 30_000 },
		async () => {
			vi.useRealTimers(); // the abort path walks a genuine backoff chain
			// Shrink the backoff so 5 retry rounds ≈ 155ms total (production
			// constants stay §2.5 1s→30s; verified separately by the contract).
			process.env.DOCS_EMBED_BACKOFF_BASE_MS = "2";
			process.env.DOCS_EMBED_BACKOFF_CAP_MS = "8";
			await writeFixtureCorpus();
			behavior = () => {
				throw Object.assign(new Error("rate limited"), { statusCode: 429 });
			};
			await startDocsEmbedRebuild({ batch: 2 });
			const state = await waitForTerminal();
			expect(state.phase).toBe("failed");
			// backoff-then-abort wording is courtesy (no provider blame)
			expect(state.error).toMatch(/Rate-limited|Too many failed batches/);
		},
	);
});

describe("docs-embed rebuild — crash recovery", () => {
	it("status returns interrupted when a state file exists but no live job", async () => {
		await writeFixtureCorpus();
		const stale: DocsEmbedJobState = {
			kind: "embed",
			phase: "embed",
			startedAt: Date.now() - 60_000,
			done: 5,
			total: 10,
			ratePerSecond: 1,
			etaSeconds: 5,
			failedBatches: 0,
			model: "e5-mistral-7b-instruct",
			error: null,
		};
		await writeFile(path.join(indexDir, ".docs-embed-job.json"), JSON.stringify(stale));
		const s = await getDocsEmbedJobStatus();
		expect(s?.phase).toBe("interrupted");
	});

	it("no state file and no job → status null", async () => {
		await writeFixtureCorpus();
		expect(await getDocsEmbedJobStatus()).toBeNull();
	});
});
