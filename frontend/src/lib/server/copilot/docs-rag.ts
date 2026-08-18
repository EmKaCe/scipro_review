/**
 * @file Offline library-docs retrieval (docs-rag.ts).
 *
 * Hybrid BM25 + KI Connect embeddings retrieval over the prebuilt offline
 * docs index (`docs-index.json`, produced by
 * `frontend/scripts/build-docs-index.mjs`). The copilot's `search-docs` tool
 * uses this to verify API signatures / parameters / return values of
 * NumPy / pandas / SciPy / scikit-learn / matplotlib WITHOUT web search.
 *
 * Design (per .hermes/plans/2026-08-18-offline-docs.md §3):
 *   - BM25 keyword leg (minisearch) is the deterministic, fully-offline
 *     primary: exact API names (`curve_fit`, `np.polyfit`) are distinctive
 *     tokens and always found.
 *   - If the top BM25 score is below a threshold (paraphrase queries like
 *     "fit a curve to data"), the embedding leg runs: the query is embedded
 *     via the KI Connect embeddings endpoint (same provider pattern as
 *     agent.ts createModel) and compared by cosine similarity against the
 *     PRECOMPUTED corpus vectors (never re-embedded at runtime). Results are
 *     fused with reciprocal-rank fusion (RRF).
 *   - Degradation is a hard invariant: if the index is missing, the vectors
 *     are absent, or the embedding endpoint is down, the BM25 leg still
 *     answers — this module NEVER throws for retrieval.
 *
 * The index is loaded lazily on first use (never at module top level), so
 * tests and servers that never call searchDocs pay nothing and never require
 * the index file to exist.
 *
 * This module runs only on the SvelteKit server (`$lib/server/`).
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import MiniSearch from "minisearch";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

import { getDataDir } from "$lib/server/metadata";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const DOCS_LIBRARIES = ["numpy", "pandas", "scipy", "sklearn", "matplotlib"] as const;
export type DocsLibrary = (typeof DOCS_LIBRARIES)[number];

export interface DocsChunk {
	id: string;
	library: DocsLibrary;
	version: string;
	title: string;
	url: string;
	text: string;
}

export interface DocsLibraryManifest {
	library: string;
	version: string;
	pinnedVersion: string;
	sourceUrl: string | null;
	sha256: string | null;
	builtAt: string;
}

/** On-disk shape of docs-index.json (formatVersion 1). */
export interface DocsIndexFile {
	format: string;
	formatVersion: number;
	builtAt: string;
	embeddingModel: string | null;
	embeddingDim: number | null;
	libraries: DocsLibraryManifest[];
	chunks: DocsChunk[];
	/** Name of the float32 LE vectors file, relative to this JSON's dir. */
	vectorsFile?: string;
	/** Number of vectors in the .bin (must equal chunks.length). */
	vectorCount?: number;
}

export interface DocHit {
	title: string;
	url: string;
	library: DocsLibrary;
	version: string;
	snippet: string;
	score: number;
}

export interface SearchDocsOptions {
	/** Restrict retrieval to one library (cheap precision win). */
	library?: DocsLibrary;
	/** Number of hits to return (clamped 1..10, default 3). */
	topK?: number;
	/**
	 * Test hook: override the query-embedding function. Defaults to the KI
	 * Connect embeddings endpoint via the AI SDK provider. Never called when
	 * the index has no vectors.
	 */
	embedQuery?: (query: string) => Promise<number[]>;
}

export interface DocsIndexStatus {
	loaded: boolean;
	chunkCount: number;
	libraries: string[];
	note?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INDEX_FILENAME = "docs-index.json";
const INDEX_FORMAT = "svelte-review-copilot-docs-index";
const INDEX_FORMAT_VERSION = 1;

/** Top BM25 score below which the embedding leg is also run. */
const BM25_EMBED_THRESHOLD = 0.5;
/** RRF constant (standard k=60). */
const RRF_K = 60;
/** How many candidates each leg contributes to the RRF fusion. */
const RRF_CANDIDATES = 20;
/** Snippet length in chars (the chunk head carries signature + params). */
const SNIPPET_CHARS = 1200;
const SNIPPET_MARKER = "\n… (truncated)";

const EMBEDDING_MODEL = "e5-mistral-7b-instruct";
const EMBEDDING_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Lazy index state
// ---------------------------------------------------------------------------

interface LoadedIndex {
	chunks: DocsChunk[];
	vectors: Float32Array | null;
	/** Embedding dimension from the manifest (null when the index has no vectors). */
	embeddingDim: number | null;
	manifest: DocsLibraryManifest[];
	miniSearch: MiniSearch<DocsChunk>;
}

let loadedIndex: LoadedIndex | null = null;
let loadPromise: Promise<LoadedIndex | null> | null = null;
let loadNote: string | null = null;

/** Resolve the index file path (env override wins; else <DATA_DIR>/docs-index/). */
function getIndexPath(): string {
	if (process.env.DOCS_INDEX_DIR) {
		return path.join(process.env.DOCS_INDEX_DIR, INDEX_FILENAME);
	}
	return path.join(getDataDir(), "docs-index", INDEX_FILENAME);
}

/** Build the minisearch BM25 index over the chunk corpus. */
function buildMiniSearch(chunks: DocsChunk[]): MiniSearch<DocsChunk> {
	const miniSearch = new MiniSearch<DocsChunk>({
		fields: ["title", "text"],
		storeFields: ["title", "url", "library", "version", "id"],
		idField: "id",
	});
	miniSearch.addAll(chunks);
	return miniSearch;
}

/**
 * Load the docs index once (lazily). Returns null on any failure — missing
 * file, wrong format, unreadable JSON — and records a note for the tool to
 * surface. Never throws.
 */
export async function loadDocsIndex(): Promise<LoadedIndex | null> {
	if (loadedIndex) return loadedIndex;
	if (loadPromise) return loadPromise;

	loadPromise = (async () => {
		const indexPath = getIndexPath();
		let raw: string;
		try {
			raw = await readFile(indexPath, "utf-8");
		} catch (err) {
			loadNote = `Offline docs index not found at ${indexPath} — run \`node scripts/build-docs-index.mjs\` to build it (${err instanceof Error ? err.message : String(err)})`;
			return null;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (err) {
			loadNote = `Offline docs index at ${indexPath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`;
			return null;
		}
		const file = parsed as Partial<DocsIndexFile>;
		if (file.format !== INDEX_FORMAT || file.formatVersion !== INDEX_FORMAT_VERSION) {
			loadNote = `Offline docs index at ${indexPath} has unsupported format (${file.format ?? "?"} v${file.formatVersion ?? "?"}) — rebuild with scripts/build-docs-index.mjs`;
			return null;
		}
		if (!Array.isArray(file.chunks) || file.chunks.length === 0) {
			loadNote = `Offline docs index at ${indexPath} contains no chunks — rebuild with scripts/build-docs-index.mjs`;
			return null;
		}
		const chunks = file.chunks as DocsChunk[];
		// Cheap manifest honesty check: vectorCount (written by the build
		// script) must agree with the chunk count, or the vectors are stale.
		if (file.vectorCount !== undefined && file.vectorCount !== chunks.length) {
			loadNote = `Offline docs index at ${indexPath} declares ${file.vectorCount} vectors for ${chunks.length} chunks — treating as BM25-only; rebuild with scripts/build-docs-index.mjs`;
			return null;
		}
		// Vectors live in a separate float32 LE .bin (docs-vectors.bin) named by
		// the manifest. Missing file / wrong byte length / wrong dims → treated
		// as absent (BM25-only) rather than risking wrong pairing. Never throws.
		let vectors: Float32Array | null = null;
		if (file.vectorsFile && typeof file.vectorsFile === "string") {
			const dim = typeof file.embeddingDim === "number" ? file.embeddingDim : 0;
			const expectedBytes = chunks.length * dim * 4;
			try {
				const binPath = path.join(path.dirname(indexPath), file.vectorsFile);
				const buf = await readFile(binPath);
				if (buf.byteLength === expectedBytes && expectedBytes > 0) {
					vectors = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
				} else {
					loadNote = `Offline docs vectors at ${binPath} have ${buf.byteLength} bytes, expected ${expectedBytes} (${chunks.length} chunks x ${dim} dims) — treating as BM25-only; rebuild with scripts/build-docs-index.mjs`;
				}
			} catch (err) {
				loadNote = `Offline docs vectors file ${file.vectorsFile} not found next to ${indexPath} — treating as BM25-only (${err instanceof Error ? err.message : String(err)})`;
			}
		}
		// buildMiniSearch THROWS on parseable-but-malformed indexes (duplicate
		// chunk ids, missing id field) — keep it inside the never-throw envelope.
		let miniSearch: MiniSearch<DocsChunk>;
		try {
			miniSearch = buildMiniSearch(chunks);
		} catch (err) {
			loadNote = `Offline docs index at ${indexPath} could not be indexed (${err instanceof Error ? err.message : String(err)}) — rebuild with scripts/build-docs-index.mjs`;
			return null;
		}
		loadedIndex = {
			chunks,
			vectors,
			embeddingDim: typeof file.embeddingDim === "number" ? file.embeddingDim : null,
			manifest: Array.isArray(file.libraries) ? (file.libraries as DocsLibraryManifest[]) : [],
			miniSearch,
		};
		return loadedIndex;
	})();

	const result = await loadPromise;
	loadPromise = null;
	return result;
}

/** Reset the lazy cache (tests). */
export function __resetDocsIndexForTests(): void {
	loadedIndex = null;
	loadPromise = null;
	loadNote = null;
}

/** Cheap status probe for the tool layer (never loads the index). */
export function getDocsIndexStatus(): DocsIndexStatus {
	if (loadedIndex) {
		return {
			loaded: true,
			chunkCount: loadedIndex.chunks.length,
			libraries: [...new Set(loadedIndex.chunks.map((c) => c.library))],
		};
	}
	return { loaded: false, chunkCount: 0, libraries: [], note: loadNote ?? undefined };
}

// ---------------------------------------------------------------------------
// Embedding leg
// ---------------------------------------------------------------------------

/** Default query embedder: KI Connect via the AI SDK provider (agent.ts pattern). */
async function defaultEmbedQuery(query: string): Promise<number[]> {
	const provider = createOpenAICompatible({
		name: "ki-connect",
		baseURL: process.env.KI_CONNECT_BASE_URL ?? "https://chat.kiconnect.nrw/api/v1",
		apiKey: process.env.KI_CONNECT_API_KEY,
	});
	const model = provider.embeddingModel(EMBEDDING_MODEL);
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), EMBEDDING_TIMEOUT_MS);
	try {
		const result = await model.doEmbed({ values: [query], abortSignal: controller.signal });
		const vector = result.embeddings[0];
		if (!vector || vector.length === 0) throw new Error("empty embedding returned");
		return vector;
	} finally {
		clearTimeout(timeoutId);
	}
}

/** Cosine similarity between two equal-length vectors. */
function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
	let dot = 0;
	let na = 0;
	let nb = 0;
	const len = Math.min(a.length, b.length);
	for (let i = 0; i < len; i++) {
		dot += a[i]! * b[i]!;
		na += a[i]! * a[i]!;
		nb += b[i]! * b[i]!;
	}
	const denom = Math.sqrt(na) * Math.sqrt(nb);
	return denom === 0 ? 0 : dot / denom;
}

/** Top-N chunks by cosine similarity to the query vector (library-filtered). */
function embeddingTopN(
	chunks: DocsChunk[],
	vectors: Float32Array,
	queryVector: ArrayLike<number>,
	library: DocsLibrary | undefined,
	n: number,
): Array<{ chunk: DocsChunk; score: number }> {
	// Flat row-major layout: chunk i's vector is the subarray
	// [i * dim, (i + 1) * dim). subarray is a zero-copy view — no
	// conversion to number[][] (avoids ~2x memory).
	const dim = vectors.length / chunks.length;
	const scored: Array<{ chunk: DocsChunk; score: number }> = [];
	for (let i = 0; i < chunks.length; i++) {
		if (library && chunks[i]!.library !== library) continue;
		scored.push({ chunk: chunks[i]!, score: cosine(vectors.subarray(i * dim, (i + 1) * dim), queryVector) });
	}
	scored.sort((a, b) => b.score - a.score);
	return scored.slice(0, n);
}

// ---------------------------------------------------------------------------
// Fusion
// ---------------------------------------------------------------------------

/** Reciprocal-rank fusion of two ranked candidate lists. */
function rrfFuse(
	bm25: Array<{ chunk: DocsChunk; score: number }>,
	embed: Array<{ chunk: DocsChunk; score: number }>,
	topK: number,
): Array<{ chunk: DocsChunk; score: number }> {
	const fused = new Map<string, { chunk: DocsChunk; score: number }>();
	const addList = (list: Array<{ chunk: DocsChunk; score: number }>) => {
		for (let rank = 0; rank < list.length; rank++) {
			const item = list[rank]!;
			const existing = fused.get(item.chunk.id);
			const contribution = 1 / (RRF_K + rank + 1);
			if (existing) {
				existing.score += contribution;
			} else {
				fused.set(item.chunk.id, { chunk: item.chunk, score: contribution });
			}
		}
	};
	addList(bm25);
	addList(embed);
	return [...fused.values()].sort((a, b) => b.score - a.score).slice(0, topK);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function toHit(chunk: DocsChunk, score: number): DocHit {
	const snippet =
		chunk.text.length > SNIPPET_CHARS ? chunk.text.slice(0, SNIPPET_CHARS) + SNIPPET_MARKER : chunk.text;
	return {
		title: chunk.title,
		url: chunk.url,
		library: chunk.library,
		version: chunk.version,
		snippet,
		score,
	};
}

/**
 * Hybrid docs search. Returns [] when the index is not built (never throws).
 *
 * BM25 first; if the top score is below {@link BM25_EMBED_THRESHOLD} (or BM25
 * found nothing), the embedding leg runs when vectors are present and the
 * embedder is available, and the two rankings are fused with RRF. Any
 * embedding failure degrades to BM25-only.
 */
export async function searchDocs(
	query: string,
	options: SearchDocsOptions = {},
): Promise<DocHit[]> {
	const index = await loadDocsIndex();
	if (!index) return [];

	const topK = Math.max(1, Math.min(Math.floor(options.topK ?? 3), 10));
	const library = options.library;

	const bm25Results = index.miniSearch.search(query, {
		prefix: true,
		boost: { title: 3 },
		filter: library ? (result) => result.library === library : undefined,
	});
	const bm25Top = bm25Results.slice(0, RRF_CANDIDATES).map((r) => ({
		chunk: index.chunks.find((c) => c.id === r.id)!,
		score: r.score,
	}));

	const topScore = bm25Top.length > 0 ? bm25Top[0]!.score : 0;
	const needsEmbedding = bm25Top.length === 0 || topScore < BM25_EMBED_THRESHOLD;

	if (!needsEmbedding) {
		return bm25Top.slice(0, topK).map((r) => toHit(r.chunk, r.score));
	}

	// Embedding leg — degrade to BM25-only on ANY failure (endpoint down,
	// no key, no vectors, embedder throws, wrong vector dimension).
	if (index.vectors) {
		try {
			const embedQuery = options.embedQuery ?? defaultEmbedQuery;
			const queryVector = await embedQuery(query);
			// The query vector must match the corpus dimension — cosine()
			// would otherwise silently compute a partial dot product.
			if (
				Array.isArray(queryVector) &&
				queryVector.length > 0 &&
				queryVector.length === index.embeddingDim
			) {
				const embedTop = embeddingTopN(index.chunks, index.vectors, queryVector, library, RRF_CANDIDATES);
				const fused = rrfFuse(bm25Top, embedTop, topK);
				return fused.map((r) => toHit(r.chunk, r.score));
			}
		} catch {
			// fall through to BM25-only
		}
	}

	return bm25Top.slice(0, topK).map((r) => toHit(r.chunk, r.score));
}
