/**
 * @file Integration test: the docs-embed rebuild runner against a REAL local
 * HTTP stub implementing the OpenAI-compatible POST /embeddings contract
 * (2.7.0 §6.2 — the unit suite mocks the provider; this one exercises the
 * actual fetch/socket path, dim negotiation, and status transitions).
 *
 * The stub is configurable per test: latency, dimension, 429/404/400
 * injection, batch-size echo. Fixture: a 64-chunk corpus written into a temp
 * DATA_DIR/docs-index. No external network — everything binds 127.0.0.1:0.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// HTTP stub configuration (reset per test)
// ---------------------------------------------------------------------------

/** Deterministic vector of `dim` floats keyed on the text. */
function vecFor(text: string, dim: number): number[] {
	const v = new Array<number>(dim).fill(0);
	v[0] = text.length % 7;
	v[1] = 1;
	return v;
}

interface StubConfig {
	dim: number;
	/** Extra ms of latency per request. */
	latencyMs: number;
	/** Respond 429 for the first N requests (then behave). */
	first429: number;
	/** Respond 404 model-not-found unconditionally. */
	notFound: boolean;
	/** Maximum input batch the provider accepts (400 beyond). */
	maxBatch: number;
	/** Content-Type scramble (wrong-shape responses). */
	brokenResponse: boolean;
}

const cfg: StubConfig = {
	dim: 4,
	latencyMs: 0,
	first429: 0,
	notFound: false,
	maxBatch: 64,
	brokenResponse: false,
};

let requests = 0;
let seenBatchSizes: number[] = [];
let server: Server | null = null;
let baseUrl = "";

beforeAll(async () => {
	server = createServer((req, res) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			requests += 1;
			const respond = () => {
				if (cfg.brokenResponse) {
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ object: "list", data: [{ weird: true }] }));
					return;
				}
				if (cfg.notFound) {
					res.writeHead(404, { "Content-Type": "application/json" });
					res.end(
						JSON.stringify({
							error: { message: "model not found", code: "model_not_found" },
						}),
					);
					return;
				}
				let input: unknown;
				try {
					input = JSON.parse(body).input;
				} catch {
					input = [];
				}
				const list = Array.isArray(input) ? input : [input];
				seenBatchSizes.push(list.length);
				if (list.length > cfg.maxBatch) {
					res.writeHead(400, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: { message: "batch too large" } }));
					return;
				}
				if (cfg.dim === null) {
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(
						JSON.stringify({
							object: "list",
							data: list.map((_) => ({ embedding: [1, 0] })),
						}),
					);
					return;
				}
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						object: "list",
						data: list.map((t: string) => ({ embedding: vecFor(String(t), cfg.dim) })),
					}),
				);
			};
			if (requests <= cfg.first429) {
				res.writeHead(429, { "Retry-After": "1" });
				res.end(JSON.stringify({ error: { message: "rate limited" } }));
				return;
			}
			if (cfg.latencyMs > 0) {
				setTimeout(respond, cfg.latencyMs);
			} else {
				respond();
			}
		});
	});
	await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
	const addr = server!.address() as { port: number };
	baseUrl = "http://127.0.0.1:" + String(addr.port);
	// The runner resolves the endpoint from settings/env — set env directly.
	process.env.KI_CONNECT_BASE_URL = baseUrl;
});

afterAll(async () => {
	if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
});

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const CHUNKS = 64;
const DIM = Number(process.env.STUB_DIM ?? "4");
void DIM;

let dataDir: string;
let indexDir: string;

async function writeCorpus(): Promise<void> {
	await rm(indexDir, { recursive: true, force: true });
	await mkdir(indexDir, { recursive: true });
	const index = {
		format: "svelte-review-copilot-docs-index",
		formatVersion: 1,
		builtAt: "2026-08-30T00:00:00.000Z",
		embeddingModel: null,
		embeddingDim: null,
		libraries: [],
		chunks: Array.from({ length: CHUNKS }, (_, i) => ({
			id: `numpy:chunk-${i}`,
			title: `chunk ${i}`,
			url: `https://example.invalid/${i}`,
			library: "numpy",
			version: "2.5.1",
			text: `integration corpus chunk ${i} about curve fitting`,
		})),
	};
	// The settings loader resolves base_url from DATA_DIR/settings.yaml FIRST
	// (env is only a fallback that other suites may clobber) — make the stub
	// authoritative for this file's runs.
	await writeFile(
		path.join(dataDir, "settings.yaml"),
		`llm:\n  base_url: ${JSON.stringify(baseUrl)}\n  model: e5-mistral-7b-instruct\n  embedding_model: e5-mistral-7b-instruct\n`,
	);
	await writeFile(path.join(indexDir, "docs-index.json"), JSON.stringify(index));
}

async function binSize(): Promise<number> {
	return (await stat(path.join(indexDir, "docs-vectors.bin"))).size;
}

// ---------------------------------------------------------------------------
// Module imports (after env + beforeEach)
// ---------------------------------------------------------------------------

import {
	__resetDocsEmbedJobForTests,
	getDocsEmbedJobStatus,
	startDocsEmbedRebuild,
	cancelDocsEmbedJob,
} from "$lib/server/docs-embed-rebuild";
import { __resetJobSlotForTests } from "$lib/server/onboarding-docs-index";
import { setApiKey } from "$lib/server/api-key-store";
import type { DocsEmbedJobState } from "$lib/server/docs-embed-rebuild";

beforeEach(async () => {
	dataDir = await mkdtemp(path.join(os.tmpdir(), "scipro-embed-int-"));
	indexDir = path.join(dataDir, "docs-index");
	process.env.DATA_DIR = dataDir;
	process.env.KI_CONNECT_BASE_URL = baseUrl;
	process.env.KI_CONNECT_API_KEY = "test-key";
	setApiKey("test-key");
	// Fast, honest backoff (the env contract added in W2-A)
	process.env.DOCS_EMBED_BACKOFF_BASE_MS = "2";
	process.env.DOCS_EMBED_BACKOFF_CAP_MS = "8";
	cfg.dim = 4;
	cfg.latencyMs = 0;
	cfg.first429 = 0;
	cfg.notFound = false;
	cfg.maxBatch = 64;
	cfg.brokenResponse = false;
	requests = 0;
	seenBatchSizes = [];
	__resetDocsEmbedJobForTests();
	__resetJobSlotForTests();
});

afterEach(async () => {
	__resetDocsEmbedJobForTests();
	__resetJobSlotForTests();
	await rm(dataDir, { recursive: true, force: true });
	delete process.env.DATA_DIR;
	vi.restoreAllMocks();
});

async function waitForTerminal(timeoutMs = 15_000): Promise<DocsEmbedJobState> {
	for (let waited = 0; waited < timeoutMs; waited += 25) {
		const s = await getDocsEmbedJobStatus();
		if (s && ["done", "failed", "cancelled", "interrupted"].includes(s.phase)) return s;
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error("job did not reach a terminal phase in time");
}

describe("integration: embed rebuild against a real local embeddings stub", () => {
	it("64-chunk corpus → done: bin bytes = 64×4×4, offets spot-check, manifest updated, batch sizes ≤ 64", async () => {
		await writeCorpus();
		await startDocsEmbedRebuild({ batch: 16 });
		const state = await waitForTerminal();

		expect(state.phase, `state.error=${state.error}`).toBe("done");
		expect(state.done).toBe(CHUNKS);
		expect(await binSize()).toBe(CHUNKS * 4 * 4);

		const buf = await readFile(path.join(indexDir, "docs-vectors.bin"));
		const first = new Float32Array(buf.buffer, 0, 4);
		expect(first[0]).toBe(CHUNK_TEXT_LEN(0) % 7);
		const mid = new Float32Array(buf.buffer, 32 * 4 * 4, 4);
		expect(mid[0]).toBe(CHUNK_TEXT_LEN(32) % 7);

		const manifest = JSON.parse(
			(await readFile(path.join(indexDir, "docs-index.json"))).toString(),
		) as Record<string, unknown>;
		expect(manifest["embeddingDim"]).toBe(4);
		expect(manifest["vectorCount"]).toBe(CHUNKS);
		expect(manifest["embeddingModel"]).toBe("e5-mistral-7b-instruct");
		// every provider call respected the batch cap
		expect(seenBatchSizes.every((n) => n <= 16)).toBe(true);
	});

	it("first-429 injection: the job recovers via Retry-After backoff and still completes", async () => {
		await writeCorpus();
		cfg.first429 = 1;
		await startDocsEmbedRebuild({ batch: 16 });
		const state = await waitForTerminal();
		expect(state.phase).toBe("done");
	});

	it("404 model-not-found fails the job fast (all batches fail → abort)", async () => {
		await writeCorpus();
		cfg.notFound = true;
		await startDocsEmbedRebuild({ batch: 16 });
		const state = await waitForTerminal();
		expect(state.phase).toBe("failed");
		expect(state.error).toMatch(/Too many failed batches/);
		await expect(stat(path.join(indexDir, "docs-vectors.bin"))).rejects.toThrow();
	});

	it("cancel at a batch boundary mid-run → cancelled, staging cleaned, no vectors file", async () => {
		await writeCorpus();
		cfg.latencyMs = 40; // slow enough to catch mid-run
		const run = startDocsEmbedRebuild({ batch: 4 });
		await new Promise((r) => setTimeout(r, 50));
		expect(cancelDocsEmbedJob()).toBe(true);
		await run;
		const state = await waitForTerminal();
		expect(state.phase).toBe("cancelled");
		await expect(stat(path.join(indexDir, "docs-vectors.bin"))).rejects.toThrow();
	});
});

function CHUNK_TEXT_LEN(i: number): number {
	return `integration corpus chunk ${i} about curve fitting`.length;
}
void CHUNK_TEXT_LEN;
