/**
 * @file Unit tests for the offline library-docs retrieval layer
 * (docs-rag.ts + tools/docs-tools.ts).
 *
 * Uses a TINY hand-written fixture corpus (4 chunks, one per library) written
 * into a temp DATA_DIR — never the real 5.6M-token build. Covers:
 *   (a) exact-name lookup finds the right page (BM25 leg),
 *   (b) paraphrase lookup works via embeddings when vectors are present
 *       (RRF fusion leg, mocked embedder — no network),
 *   (c) library filter narrows,
 *   (d) degrade path: no vectors / embedding endpoint down → BM25-only still
 *       returns results,
 *   (e) tool registration + input schema validation.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createRegistry, type ToolContext } from "$lib/server/copilot/registry";
import { registerDocsTools } from "$lib/server/copilot/tools/docs-tools";
import {
	__resetDocsIndexForTests,
	getDocsIndexStatus,
	searchDocs,
	type DocsChunk,
} from "$lib/server/copilot/docs-rag";

// ---------------------------------------------------------------------------
// Fixture corpus (hand-written, mirrors the real chunk shape)
// ---------------------------------------------------------------------------

const FIXTURE_CHUNKS: DocsChunk[] = [
	{
		id: "scipy:reference/generated/scipy.optimize.curve_fit.html#0",
		title: "scipy.optimize.curve_fit",
		url: "https://docs.scipy.org/doc/scipy/reference/generated/scipy.optimize.curve_fit.html",
		library: "scipy",
		version: "1.18.0",
		text: `## scipy.optimize.curve_fit (scipy 1.18.0)
Signature: curve_fit(f, xdata, ydata, p0=None, sigma=None, absolute_sigma=False, check_finite=None, bounds=(-inf, inf), method=None)
Use non-linear least squares to fit a function, f, to data.
Parameters:
  - f: callable — model function f(x, ...) taking xdata and parameters
  - p0: array_like, optional — initial guess for parameters
  - sigma: None or M-length sequence or MxM array — uncertainty in ydata
Returns:
  - popt: array — optimal values for the parameters
  - pcov: 2-D array — estimated covariance of popt
Example:
  >>> popt, pcov = curve_fit(func, xdata, ydata)
  >>> popt
  array([ 2.5,  0.5 ])
Source: https://docs.scipy.org/doc/scipy/reference/generated/scipy.optimize.curve_fit.html`,
	},
	{
		id: "numpy:reference/generated/numpy.polyfit.html#0",
		title: "numpy.polyfit",
		url: "https://numpy.org/doc/stable/reference/generated/numpy.polyfit.html",
		library: "numpy",
		version: "2.5.1",
		text: `## numpy.polyfit (numpy 2.5.1)
Signature: polyfit(x, y, deg, rcond=None, full=False, w=None, cov=False)
Least squares polynomial fit.
Parameters:
  - x: array_like, shape (M,) — x-coordinates of the M sample points
  - y: array_like, shape (M,) or (M, K) — y-coordinates of the sample points
  - deg: int — degree of the fitting polynomial
Returns:
  - p: ndarray, shape (deg + 1,) — polynomial coefficients, highest power first
Example:
  >>> p = np.polyfit(x, y, 2)
Source: https://numpy.org/doc/stable/reference/generated/numpy.polyfit.html`,
	},
	{
		id: "pandas:reference/api/pandas.DataFrame.html#0",
		title: "pandas.DataFrame",
		url: "https://pandas.pydata.org/docs/reference/api/pandas.DataFrame.html",
		library: "pandas",
		version: "3.0.5",
		text: `## pandas.DataFrame (pandas 3.0.5)
Signature: DataFrame(data=None, index=None, columns=None, dtype=None, copy=None)
Two-dimensional, size-mutable, potentially heterogeneous tabular data.
Parameters:
  - data: ndarray, Iterable, dict, or DataFrame
  - index: Index or array-like
  - columns: Index or array-like
Example:
  >>> df = pd.DataFrame({'a': [1, 2, 3]})
Source: https://pandas.pydata.org/docs/reference/api/pandas.DataFrame.html`,
	},
	{
		id: "sklearn:modules/generated/sklearn.cluster.KMeans.html#0",
		title: "sklearn.cluster.KMeans",
		url: "https://scikit-learn.org/stable/modules/generated/sklearn.cluster.KMeans.html",
		library: "sklearn",
		version: "1.9.0",
		text: `## sklearn.cluster.KMeans (sklearn 1.9.0)
Signature: KMeans(n_clusters=8, init='k-means++', n_init='auto', max_iter=300, random_state=None)
K-Means clustering.
Parameters:
  - n_clusters: int, default=8 — number of clusters
  - init: 'k-means++' or ndarray — initialization method
Methods:
  - fit(X, y=None, sample_weight=None) — compute k-means clustering
Example:
  >>> kmeans = KMeans(n_clusters=3).fit(X)
Source: https://scikit-learn.org/stable/modules/generated/sklearn.cluster.KMeans.html`,
	},
];

/**
 * Hand-crafted 4-dim vectors, one per chunk (index-aligned with
 * FIXTURE_CHUNKS). The KMeans chunk owns axis 3, so a query vector of
 * [0, 0, 0, 1] is most similar to it.
 */
const FIXTURE_VECTORS: number[][] = [
	[1, 0, 0, 0], // scipy.optimize.curve_fit
	[0, 1, 0, 0], // numpy.polyfit
	[0, 0, 1, 0], // pandas.DataFrame
	[0, 0, 0, 1], // sklearn.cluster.KMeans
];

/**
 * Write the fixture docs-index.json + docs-vectors.bin into the temp DATA_DIR.
 *
 * `withVectors` writes the manifest vectorsFile/vectorCount fields AND the
 * .bin (4 chunks x 4 dims = 64 bytes). `options` lets degrade-branch tests
 * corrupt one piece of the vector contract:
 *   - vectorsFile: override the .bin filename (e.g. point at a missing file)
 *   - vectorCount: override the manifest count (defaults to 4 when withVectors)
 *   - embeddingDim: override the manifest dim (defaults to 4 when withVectors)
 *   - vectorsBytes: override the .bin byte length (defaults to 64)
 *   - duplicateIds: duplicate every chunk id so buildMiniSearch throws
 */
async function writeFixtureIndex(
	dataDir: string,
	withVectors: boolean,
	options: {
		vectorsFile?: string;
		vectorCount?: number;
		embeddingDim?: number | null;
		vectorsBytes?: number;
		duplicateIds?: boolean;
	} = {},
): Promise<void> {
	const dir = path.join(dataDir, "docs-index");
	await mkdir(dir, { recursive: true });
	const chunks = options.duplicateIds
		? FIXTURE_CHUNKS.map((c) => ({ ...c, id: "duplicate:id" }))
		: FIXTURE_CHUNKS;
	const index: Record<string, unknown> = {
		format: "svelte-review-copilot-docs-index",
		formatVersion: 1,
		builtAt: "2026-08-18T00:00:00.000Z",
		embeddingModel: withVectors ? "e5-mistral-7b-instruct" : null,
		embeddingDim: withVectors ? (options.embeddingDim ?? 4) : null,
		libraries: [
			{
				library: "numpy",
				version: "2.5.1",
				pinnedVersion: "2.5.1",
				sourceUrl: "https://numpy.org/doc/stable/numpy-html.zip",
				sha256: "abc",
				builtAt: "2026-08-18T00:00:00.000Z",
			},
			{
				library: "pandas",
				version: "3.0.5",
				pinnedVersion: "3.0.5",
				sourceUrl: "https://pandas.pydata.org/docs/pandas.zip",
				sha256: "abc",
				builtAt: "2026-08-18T00:00:00.000Z",
			},
			{
				library: "scipy",
				version: "1.18.0",
				pinnedVersion: "1.18.0",
				sourceUrl: "https://docs.scipy.org/doc/scipy-1.18.0/scipy-html-1.18.0.zip",
				sha256: "abc",
				builtAt: "2026-08-18T00:00:00.000Z",
			},
			{
				library: "sklearn",
				version: "1.9.0",
				pinnedVersion: "1.9.0",
				sourceUrl: "https://scikit-learn.org/stable/_downloads/scikit-learn-docs.zip",
				sha256: "abc",
				builtAt: "2026-08-18T00:00:00.000Z",
			},
		],
		chunks,
	};
	if (withVectors) {
		index.vectorsFile = options.vectorsFile ?? "docs-vectors.bin";
		index.vectorCount = options.vectorCount ?? FIXTURE_VECTORS.length;
	}
	await writeFile(path.join(dir, "docs-index.json"), JSON.stringify(index), "utf-8");
	if (withVectors) {
		// float32 little-endian, row-major: 4 chunks x 4 dims = 16 floats = 64 bytes.
		// Only write vectors that fit in the (possibly truncated) buffer.
		const buf = Buffer.allocUnsafe(options.vectorsBytes ?? FIXTURE_VECTORS.length * 4 * 4);
		const writeCount = Math.min(FIXTURE_VECTORS.length, Math.floor(buf.length / 16));
		for (let i = 0; i < writeCount; i++) {
			const vec = FIXTURE_VECTORS[i]!;
			const offset = i * 4 * 4;
			for (let j = 0; j < 4; j++) {
				buf.writeFloatLE(vec[j]!, offset + j * 4);
			}
		}
		await writeFile(path.join(dir, options.vectorsFile ?? "docs-vectors.bin"), buf);
	}
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let dataDir: string;
let registry: ReturnType<typeof createRegistry>;

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
	return { signal: new AbortController().signal, ...overrides };
}

beforeEach(async () => {
	dataDir = await mkdtemp(path.join(os.tmpdir(), "scipro-docs-rag-"));
	process.env.DATA_DIR = dataDir;
	registry = createRegistry();
	registerDocsTools(registry);
});

afterEach(async () => {
	await rm(dataDir, { recursive: true, force: true });
	delete process.env.DATA_DIR;
	__resetDocsIndexForTests();
	vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// (a) exact-name lookup (BM25 leg)
// ---------------------------------------------------------------------------

describe("searchDocs — exact-name lookup (BM25)", () => {
	it("finds scipy.optimize.curve_fit for the exact name", async () => {
		await writeFixtureIndex(dataDir, false);

		const hits = await searchDocs("curve_fit");

		expect(hits.length).toBeGreaterThan(0);
		expect(hits[0]!.title).toBe("scipy.optimize.curve_fit");
		expect(hits[0]!.library).toBe("scipy");
		expect(hits[0]!.version).toBe("1.18.0");
		expect(hits[0]!.url).toContain("scipy.optimize.curve_fit.html");
		expect(hits[0]!.snippet).toContain("Signature: curve_fit(");
		expect(hits[0]!.snippet).toContain("popt");
		expect(hits[0]!.score).toBeGreaterThan(0);
	});

	it("finds numpy.polyfit for the exact name", async () => {
		await writeFixtureIndex(dataDir, false);

		const hits = await searchDocs("polyfit");

		expect(hits[0]!.title).toBe("numpy.polyfit");
		expect(hits[0]!.library).toBe("numpy");
	});

	it("returns [] with no throw when the index is not built", async () => {
		const hits = await searchDocs("curve_fit");
		expect(hits).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// (b) paraphrase lookup via embeddings (RRF fusion)
// ---------------------------------------------------------------------------

describe("searchDocs — paraphrase via embeddings (RRF fusion)", () => {
	// The fixture corpus (4 chunks) scores orders of magnitude below the
	// production corpus calibration (150); pin a fixture-scale gate so the
	// leg fires exactly when these tests intend.
	const origThreshold = process.env.DOCS_RAG_EMBED_THRESHOLD;

	beforeAll(() => {
		process.env.DOCS_RAG_EMBED_THRESHOLD = "1";
	});

	afterAll(() => {
		if (origThreshold === undefined) delete process.env.DOCS_RAG_EMBED_THRESHOLD;
		else process.env.DOCS_RAG_EMBED_THRESHOLD = origThreshold;
	});

	it("surfaces the semantically closest page when BM25 has no lexical overlap", async () => {
		await writeFixtureIndex(dataDir, true);

		// "partition observations into homogeneous groups" shares NO tokens
		// with the KMeans chunk (verified: BM25 top score 0), so the
		// embedding leg runs. The mocked embedder returns the KMeans vector
		// exactly (cosine 1) — RRF must surface KMeans.
		const embedQuery = vi.fn(async () => FIXTURE_VECTORS[3]!);
		const hits = await searchDocs("partition observations into homogeneous groups", {
			embedQuery,
		});

		expect(embedQuery).toHaveBeenCalledOnce();
		expect(hits.length).toBeGreaterThan(0);
		expect(hits[0]!.title).toBe("sklearn.cluster.KMeans");
		expect(hits[0]!.library).toBe("sklearn");
	});

	it("does not call the embedder when BM25 already nails the query", async () => {
		await writeFixtureIndex(dataDir, true);

		const embedQuery = vi.fn(async () => FIXTURE_VECTORS[0]!);
		const hits = await searchDocs("curve_fit", { embedQuery });

		expect(embedQuery).not.toHaveBeenCalled();
		expect(hits[0]!.title).toBe("scipy.optimize.curve_fit");
	});
});

// ---------------------------------------------------------------------------
// (c) library filter
// ---------------------------------------------------------------------------

describe("searchDocs — library filter", () => {
	it("narrows results to the requested library", async () => {
		await writeFixtureIndex(dataDir, false);

		const hits = await searchDocs("fit", { library: "numpy" });

		expect(hits.length).toBeGreaterThan(0);
		for (const hit of hits) expect(hit.library).toBe("numpy");
		expect(hits[0]!.title).toBe("numpy.polyfit");
	});

	it("applies the filter to the embedding leg too", async () => {
		await writeFixtureIndex(dataDir, true);

		const embedQuery = vi.fn(async () => FIXTURE_VECTORS[3]!); // KMeans vector
		const hits = await searchDocs("partition observations into homogeneous groups", {
			library: "scipy",
			embedQuery,
		});

		// The KMeans chunk is filtered out of the embedding leg; the scipy
		// chunk (axis 0) is the only candidate and must surface.
		expect(hits.length).toBeGreaterThan(0);
		for (const hit of hits) expect(hit.library).toBe("scipy");
		expect(hits[0]!.title).toBe("scipy.optimize.curve_fit");
	});
});

// ---------------------------------------------------------------------------
// (d) degrade path
// ---------------------------------------------------------------------------

describe("searchDocs — degrade path (BM25-only)", () => {
	it("still returns BM25 results when the index has no vectors", async () => {
		await writeFixtureIndex(dataDir, false);

		const hits = await searchDocs("curve_fit", {
			embedQuery: vi.fn(async () => {
				throw new Error("should never be called");
			}),
		});

		expect(hits[0]!.title).toBe("scipy.optimize.curve_fit");
	});

	it("degrades to BM25-only when the embedder throws (endpoint down)", async () => {
		await writeFixtureIndex(dataDir, true);

		const embedQuery = vi.fn(async () => {
			throw new Error("KI Connect unreachable");
		});
		const hits = await searchDocs("partition observations into homogeneous groups", {
			embedQuery,
		});

		expect(embedQuery).toHaveBeenCalledOnce();
		// BM25-only: no lexical overlap → empty, but NO throw.
		expect(hits).toEqual([]);
	});

	it("degrades to BM25-only when the embedder returns a bad vector", async () => {
		await writeFixtureIndex(dataDir, true);

		const embedQuery = vi.fn(async () => []);
		const hits = await searchDocs("partition observations into homogeneous groups", {
			embedQuery,
		});

		expect(hits).toEqual([]);
	});

	it("degrades to BM25-only when the query vector has the wrong dimension", async () => {
		await writeFixtureIndex(dataDir, true);

		// Manifest says 4 dims; the embedder returns a 3-dim vector. cosine()
		// would silently compute a partial dot product — the embedding leg
		// must be skipped instead.
		const embedQuery = vi.fn(async () => [0, 0, 0]);
		const hits = await searchDocs("partition observations into homogeneous groups", {
			embedQuery,
		});

		expect(embedQuery).toHaveBeenCalledOnce();
		// BM25-only: no lexical overlap → empty, but NO throw.
		expect(hits).toEqual([]);
	});

	it("degrades to BM25-only when the vectors .bin has the wrong byte length", async () => {
		// Manifest promises 4 chunks x 4 dims = 64 bytes; write only 32.
		await writeFixtureIndex(dataDir, true, { vectorsBytes: 32 });

		const hits = await searchDocs("curve_fit", {
			embedQuery: vi.fn(async () => {
				throw new Error("should never be called");
			}),
		});

		expect(hits[0]!.title).toBe("scipy.optimize.curve_fit");
	});

	it("degrades to BM25-only when the manifest embeddingDim is null", async () => {
		// vectorsFile present but embeddingDim null → expected byte count is
		// 0, so the .bin can never match → vectors treated as absent.
		await writeFixtureIndex(dataDir, true, { embeddingDim: null });

		const hits = await searchDocs("curve_fit", {
			embedQuery: vi.fn(async () => {
				throw new Error("should never be called");
			}),
		});

		expect(hits[0]!.title).toBe("scipy.optimize.curve_fit");
	});

	it("degrades to BM25-only when the vectors .bin is missing entirely", async () => {
		// vectorsFile points at a file that was never written.
		await writeFixtureIndex(dataDir, true, { vectorsFile: "docs-vectors-missing.bin" });

		const hits = await searchDocs("curve_fit", {
			embedQuery: vi.fn(async () => {
				throw new Error("should never be called");
			}),
		});

		expect(hits[0]!.title).toBe("scipy.optimize.curve_fit");
	});

	it("degrades to BM25-only when vectorCount disagrees with the chunk count", async () => {
		// Manifest honesty check: 4 chunks but vectorCount 3 → stale vectors;
		// the whole index is rejected (load fails → no results, note set).
		await writeFixtureIndex(dataDir, true, { vectorCount: 3 });

		const hits = await searchDocs("curve_fit", {
			embedQuery: vi.fn(async () => {
				throw new Error("should never be called");
			}),
		});

		expect(hits).toEqual([]);
		expect(getDocsIndexStatus().note).toContain("declares 3 vectors for 4 chunks");
	});
});

// ---------------------------------------------------------------------------
// (f) malformed index — never-throw envelope
// ---------------------------------------------------------------------------

describe("loadDocsIndex — malformed index never throws", () => {
	it("returns null with a note when chunk ids are duplicated (buildMiniSearch throws)", async () => {
		await writeFixtureIndex(dataDir, false, { duplicateIds: true });

		const hits = await searchDocs("curve_fit");

		expect(hits).toEqual([]);
		expect(getDocsIndexStatus().note).toContain("could not be indexed");
	});
});

// ---------------------------------------------------------------------------
// (e) tool registration + schema validation
// ---------------------------------------------------------------------------

describe("search-docs tool", () => {
	it("registers with permission auto and kebab-case name", () => {
		const tool = registry.get("search-docs");
		expect(tool.name).toBe("search-docs");
		expect(tool.permission).toBe("auto");
		expect(tool.destructive).toBeUndefined();
	});

	it("returns hits with the documented shape through the registry", async () => {
		await writeFixtureIndex(dataDir, false);

		const result = (await registry.run(
			"search-docs",
			{ query: "curve_fit" },
			makeContext(),
		)) as Record<string, unknown>;

		expect(result["query"]).toBe("curve_fit");
		expect(result["count"]).toBeGreaterThan(0);
		const results = result["results"] as Array<Record<string, unknown>>;
		expect(results[0]).toMatchObject({
			title: "scipy.optimize.curve_fit",
			library: "scipy",
			version: "1.18.0",
		});
		expect(typeof results[0]!["url"]).toBe("string");
		expect(typeof results[0]!["snippet"]).toBe("string");
		expect(typeof results[0]!["score"]).toBe("number");
		const index = result["index"] as Record<string, unknown>;
		expect(index["loaded"]).toBe(true);
		expect(index["chunkCount"]).toBe(4);
	});

	it("rejects invalid args via the zod input schema", async () => {
		await expect(registry.run("search-docs", { query: "" }, makeContext())).rejects.toThrow(
			/invalid arguments/,
		);
		await expect(
			registry.run("search-docs", { query: "x", library: "tensorflow" }, makeContext()),
		).rejects.toThrow(/invalid arguments/);
		await expect(
			registry.run("search-docs", { query: "x", top_k: 0 }, makeContext()),
		).rejects.toThrow(/invalid arguments/);
		await expect(
			registry.run("search-docs", { query: "x", top_k: 11 }, makeContext()),
		).rejects.toThrow(/invalid arguments/);
	});

	it("honors top_k and the library filter", async () => {
		await writeFixtureIndex(dataDir, false);

		const result = (await registry.run(
			"search-docs",
			{ query: "fit", library: "numpy", top_k: 10 },
			makeContext(),
		)) as Record<string, unknown>;

		expect(result["library"]).toBe("numpy");
		const results = result["results"] as Array<Record<string, unknown>>;
		expect(results.length).toBeLessThanOrEqual(10);
		for (const r of results) expect(r["library"]).toBe("numpy");
	});

	it("returns a note when the index is not built (never throws)", async () => {
		const result = (await registry.run(
			"search-docs",
			{ query: "curve_fit" },
			makeContext(),
		)) as Record<string, unknown>;

		expect(result["count"]).toBe(0);
		expect(result["results"]).toEqual([]);
		expect(result["note"]).toContain("not found");
	});
});
