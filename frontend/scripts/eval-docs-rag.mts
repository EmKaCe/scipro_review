/**
 * @file eval-docs-rag.mts — calibration harness for the docs-RAG hybrid gate.
 *
 * Measures, against a REAL docs index + a LIVE embeddings endpoint:
 *   1. Gate behavior: for each eval query, does `searchDocs` reach the
 *      embedding leg (embedQuery called) or stay BM25-only?
 *   2. Whether the hybrid result ever differs from BM25-only when the gate
 *      fires (rescue = the leg's purpose).
 *   3. BM25 raw-score distribution — the calibration evidence for
 *      BM25_EMBED_THRESHOLD (see docs-rag.ts).
 *
 * Usage (from frontend/):
 *   pnpm exec tsx scripts/eval-docs-rag.mts --index /tmp/docs-index-eval \
 *       [ --queries scripts/eval-queries.json ]
 *
 * Requirements:
 *   - The index dir must contain docs-index.json (+ docs-vectors.bin when
 *     the embedding leg should be live).
 *   - KI_CONNECT_BASE_URL / KI_CONNECT_API_KEY must be set in the
 *     environment (repo root .env is NOT auto-loaded here).
 *   - No prefixes are applied: mirrors the released corpus (built verbatim).
 *
 * Exit code 0 always (informational); print-only.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const argValue = (flag: string): string | undefined => {
	const i = args.indexOf(flag);
	return i >= 0 ? args[i + 1] : undefined;
};
const indexDir = argValue("--index") ?? "/tmp/docs-index-eval";

if (!process.env.KI_CONNECT_API_KEY) {
	console.error("[eval] KI_CONNECT_API_KEY must be set in the environment");
	process.exit(1);
}

// Re-point the loader at the eval index before importing the module.
process.env.DOCS_INDEX_DIR = indexDir;

const { searchDocs, loadDocsIndex, getDocsIndexStatus } =
	await import("../src/lib/server/copilot/docs-rag");
const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");

// ---------------------------------------------------------------------------
// Live embedder (single-flight, mirrors defaultEmbedQuery's provider shape)
// ---------------------------------------------------------------------------

const provider = createOpenAICompatible({
	name: "ki-connect-eval",
	baseURL: process.env.KI_CONNECT_BASE_URL ?? "https://chat.kiconnect.nrw/api/v1",
	apiKey: process.env.KI_CONNECT_API_KEY,
});
const model = provider.embeddingModel("e5-mistral-7b-instruct");

let embedCalls = 0;
let n429 = 0;

async function liveEmbedQuery(query: string): Promise<number[]> {
	embedCalls += 1;
	for (let attempt = 0; ; attempt++) {
		try {
			const res = await model.doEmbed({ values: [query] });
			const vector = res.embeddings[0];
			if (!vector || vector.length === 0) throw new Error("empty embedding returned");
			return vector;
		} catch (err) {
			const status = (err as { statusCode?: number }).statusCode;
			if (status === 429 && attempt < 4) {
				n429++;
				await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
				continue;
			}
			throw err;
		}
	}
}

// ---------------------------------------------------------------------------
// Query set (mirrors the 2026-08-30 eval protocol)
// ---------------------------------------------------------------------------

interface EvalQuery {
	id: string;
	q: string;
	/** What a competent user would expect the top hits to target. */
	expect?: string[];
	/** Zero-lexical-overlap paraphrase (the leg's rescue case). */
	paraphrase?: boolean;
}

const DEFAULT_QUERIES: EvalQuery[] = [
	// (a) exact-API sanity — the leg must NOT fire (BM25 is confident).
	{ id: "A1", q: "numpy array reshape" },
	{ id: "A2", q: "pandas DataFrame merge" },
	{ id: "A3", q: "scipy optimize curve_fit" },
	{ id: "A4", q: "sklearn train_test_split kmeans" },
	// (b) paraphrase — rescue cases: weak/no lexical overlap.
	{ id: "B1", q: "stack arrays along a new axis" },
	{ id: "B2", q: "save the figure as png" },
	{ id: "B3", q: "fit a polynomial to my measured data points" },
	{ id: "B4", q: "partition observations into homogeneous groups" },
	// (c) ambiguous / teaching-style.
	{ id: "C1", q: "how to make the plot colored by the value of another column" },
	{ id: "C2", q: "count how often each value occurs" },
	{ id: "C3", q: "read a csv file into a table" },
];

let queries: EvalQuery[] = DEFAULT_QUERIES;
if (argValue("--queries")) {
	queries = JSON.parse(await readFile(argValue("--queries")!, "utf-8")) as EvalQuery[];
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const status = getDocsIndexStatus();
console.log(`[eval] index status: ${JSON.stringify(status)}`);
const index = await loadDocsIndex();
if (!index) {
	console.error("[eval] index failed to load — aborting");
	process.exit(1);
}

console.log(
	`[eval] chunks=${index.chunks.length} dim=${index.embeddingDim} vectors=${index.vectors ? "present" : "ABSENT"}`,
);
if (!index.vectors) {
	console.log("[eval] no vectors — runs are BM25-only; the gate-fire check still works");
}

const rows: Array<Record<string, unknown>> = [];

for (const q of queries) {
	// BM25-only view: an embedder that throws forces the degrade path.
	const bm25Only = await searchDocs(q.q, {
		topK: 3,
		embedQuery: async () => {
			throw new Error("bm25-only probe");
		},
	});
	// Hybrid view: live embedder; "fired" is observable via a flag promise.
	let fired = false;
	const hybrid = await searchDocs(q.q, {
		topK: 3,
		embedQuery: async (query: string) => {
			fired = true;
			return liveEmbedQuery(query);
		},
	});
	rows.push({
		id: q.id,
		query: q.q,
		bm25Top1: bm25Only[0]?.title ?? null,
		hybTop1: hybrid[0]?.title ?? null,
		embedFired: fired,
		rescued:
			fired &&
			JSON.stringify(hybrid.map((h) => h.title)) !==
				JSON.stringify(bm25Only.map((h) => h.title)),
		gate: fired ? "EMBED-FIRED" : "bm25-only",
	});
	console.log(
		` ${q.id} fired=${fired ? "YES" : "no "} bm25Top1=${bm25Only[0]?.title ?? "∅"} hybTop1=${hybrid[0]?.title ?? "∅"}`,
	);
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

const firedCount = rows.filter((r) => r.embedFired).length;
const rescues = rows.filter((r) => r.rescued).length;
console.log("\n=== SUMMARY ===");
console.log(
	`queries: ${rows.length} | embed leg fired: ${firedCount} | hybrid-differs-from-BM25: ${rescues}`,
);
console.log(`embedding API calls: ${embedCalls} | 429s: ${n429}`);

await mkdir(path.dirname("eval-out.json") === "." ? "." : "eval-out", { recursive: true });
const outFile = process.env.EVAL_OUT ?? "eval-docs-rag-results.json";
await writeFile(outFile, JSON.stringify(rows, null, 1));
console.log(`results written to ${outFile}`);
