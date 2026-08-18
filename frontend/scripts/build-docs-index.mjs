#!/usr/bin/env node
/**
 * @file Offline library-docs index builder (v1).
 *
 * Downloads the official HTML doc zips for NumPy / pandas / SciPy /
 * scikit-learn (matplotlib has NO zip — pass a pre-crawled directory via
 * --matplotlib-dir, or it is skipped with a warning), extracts ONLY the
 * API-reference pages, strips nav/script/style, chunks ONE OBJECT PER PAGE
 * (signature block + parameter list + first 1-2 examples; multi-object pages
 * like sklearn classes split per `dt.sig` object), embeds each chunk via the
 * KI Connect embeddings endpoint (e5-mistral-7b-instruct, 4096-dim), and
 * writes `docs-index.json` (chunks + per-library manifest) plus
 * `docs-vectors.bin` (float32 LE vectors) to a configurable output dir.
 *
 * The full corpus is ~5.6M tokens / ~13,100 pages — a one-shot deploy
 * operation (~10 min). For smoke tests use `--limit N` and/or `--skip-embed`.
 *
 * Usage (from frontend/):
 *   node scripts/build-docs-index.mjs [--out <dir>] [--libraries numpy,pandas]
 *       [--limit N] [--matplotlib-dir <dir>] [--skip-embed] [--help]
 *
 * Environment:
 *   KI_CONNECT_API_KEY  — required unless --skip-embed (read from env, never
 *                         printed). The repo-root .env is loaded for any
 *                         variable not already in the process environment.
 *   KI_CONNECT_BASE_URL — default https://chat.kiconnect.nrw/api/v1
 *   DATA_DIR            — default output root (out dir = <DATA_DIR>/docs-index)
 *   DOCS_INDEX_DIR      — explicit output dir override (wins over DATA_DIR)
 *
 * Output shape:
 *   docs-index.json:
 *     {
 *       format: "svelte-review-copilot-docs-index",
 *       formatVersion: 1,
 *       builtAt: ISO string,
 *       embeddingModel: "e5-mistral-7b-instruct" | null,
 *       embeddingDim: 4096 | null,
 *       libraries: [{ library, version, pinnedVersion, sourceUrl, sha256, builtAt }],
 *       chunks: [{ id, library, version, title, url, text }],
 *       vectorsFile: "docs-vectors.bin",  // present only when vectors were embedded
 *       vectorCount: <number>             // present only when vectors were embedded
 *     }
 *   docs-vectors.bin:  // present only when vectors were embedded
 *     float32 little-endian, row-major; chunk i's vector at byte offset
 *     i * embeddingDim * 4. Byte length = chunks.length * embeddingDim * 4.
 *     (Split out of the JSON because JSON.stringify of ~3000 x 4096-dim
 *     vectors exceeds Node's ~512MB string cap.)
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { strFromU8, unzipSync } from "fflate";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

// ---------------------------------------------------------------------------
// Library config (versions = executor venv pins, measured 2026-08-18)
// ---------------------------------------------------------------------------

const LIBRARIES = {
	numpy: {
		zipUrl: "https://numpy.org/doc/stable/numpy-html.zip",
		pinnedVersion: "2.5.1",
		apiPrefix: "reference/generated/",
		urlBase: "https://numpy.org/doc/stable/",
	},
	pandas: {
		zipUrl: "https://pandas.pydata.org/docs/pandas.zip",
		pinnedVersion: "3.0.5",
		apiPrefix: "reference/api/",
		urlBase: "https://pandas.pydata.org/docs/",
	},
	scipy: {
		zipUrl: "https://docs.scipy.org/doc/scipy-1.18.0/scipy-html-1.18.0.zip",
		pinnedVersion: "1.18.0",
		apiPrefix: "reference/generated/",
		urlBase: "https://docs.scipy.org/doc/scipy/",
	},
	sklearn: {
		zipUrl: "https://scikit-learn.org/stable/_downloads/scikit-learn-docs.zip",
		pinnedVersion: "1.9.0",
		apiPrefix: "modules/generated/",
		urlBase: "https://scikit-learn.org/stable/",
	},
	matplotlib: {
		zipUrl: null, // no official zip — pre-crawled dir via --matplotlib-dir
		pinnedVersion: "3.11.1",
		apiPrefix: "api/",
		urlBase: "https://matplotlib.org/stable/",
	},
};

const EMBEDDING_MODEL = "e5-mistral-7b-instruct";
const EMBEDDING_DIM = 4096;
const EMBED_BATCH = 16; // texts per API call
const EMBED_CONCURRENCY = 2; // KI Connect rate-limit ceiling (empirical, 2026-08-17)

const MAX_DESCRIPTION_CHARS = 5000; // per object block (signature+params+notes)
const MAX_EXAMPLE_CHARS = 1500; // per kept example
const MAX_EXAMPLES = 2; // first 1-2 examples per object

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage() {
	console.log(`Usage: node scripts/build-docs-index.mjs [options]
  --out <dir>          output dir (default: $DOCS_INDEX_DIR or <DATA_DIR>/docs-index)
  --libraries <list>   comma list: numpy,pandas,scipy,sklearn,matplotlib (default: all)
  --limit <N>          process only the first N API pages per library (smoke tests)
  --matplotlib-dir <d> pre-crawled matplotlib docs dir (api/ inside); enables matplotlib
  --skip-embed         write chunks without vectors (no KI Connect call)
  --help               show this help`);
}

function parseArgs(argv) {
	const args = { out: null, libraries: null, limit: null, matplotlibDir: null, skipEmbed: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		switch (a) {
			case "--out":
				args.out = argv[++i];
				break;
			case "--libraries":
				args.libraries = argv[++i]?.split(",").map((s) => s.trim()).filter(Boolean);
				break;
			case "--limit":
				args.limit = Number(argv[++i]);
				break;
			case "--matplotlib-dir":
				args.matplotlibDir = argv[++i];
				break;
			case "--skip-embed":
				args.skipEmbed = true;
				break;
			case "--help":
				usage();
				process.exit(0);
			default:
				console.warn(`[build-docs-index] ignoring unknown argument: ${a}`);
		}
	}
	return args;
}

// ---------------------------------------------------------------------------
// Environment bootstrap (load repo-root .env for KI_CONNECT_*)
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ENV_PATH = path.join(REPO_ROOT, ".env");
try {
	const raw = await readFile(ENV_PATH, "utf-8");
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eq = trimmed.indexOf("=");
		if (eq === -1) continue;
		const key = trimmed.slice(0, eq).trim().replace(/^export\s+/, "");
		const value = trimmed.slice(eq + 1).trim();
		if (key && !(key in process.env)) process.env[key] = value;
	}
} catch {
	// No .env — rely on the ambient environment.
}

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

const NAMED_ENTITIES = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	hellip: "…",
	mdash: "—",
	ndash: "–",
	times: "×",
	minus: "−",
	le: "≤",
	ge: "≥",
	ne: "≠",
	plusmn: "±",
	deg: "°",
	mu: "μ",
	sigma: "σ",
	alpha: "α",
	beta: "β",
	lambda: "λ",
	pi: "π",
	Delta: "Δ",
	Sigma: "Σ",
	infty: "∞",
	approx: "≈",
	equiv: "≡",
	sqrt: "√",
	frac: "⁄",
	nbsp: " ",
};

/** Decode HTML entities (numeric + common named) in a text string. */
function decodeEntities(text) {
	return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, body) => {
		if (body.startsWith("#x") || body.startsWith("#X")) {
			const code = Number.parseInt(body.slice(2), 16);
			return Number.isFinite(code) ? String.fromCodePoint(code) : m;
		}
		if (body.startsWith("#")) {
			const code = Number.parseInt(body.slice(1), 10);
			return Number.isFinite(code) ? String.fromCodePoint(code) : m;
		}
		return NAMED_ENTITIES[body] ?? m;
	});
}

/** Strip all tags from an HTML fragment and normalize whitespace. */
function htmlToText(html) {
	return decodeEntities(html.replace(/<[^>]+>/g, " ")).replace(/[ \t\r\f\v]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}

/** Collapse whitespace in a signature line. */
function cleanSignature(text) {
	return decodeEntities(
		text
			.replace(/<[^>]+>/g, "")
			.replace(/\s*\[source\]\s*/g, "")
			.replace(/\s*#\s*$/, ""),
	)
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Remove balanced elements whose opening tag matches `predicate` (e.g.
 * script/style/nav/footer/try-examples divs). Handles nested elements of the
 * same kind by depth counting.
 */
function removeElements(html, predicate) {
	const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
	let out = "";
	let last = 0;
	let depth = 0;
	let removing = false;
	let m;
	while ((m = tagRe.exec(html)) !== null) {
		const full = m[0];
		const tag = m[1];
		const attrs = m[2] ?? "";
		const isClosing = full.startsWith("</");
		if (removing) {
			if (!isClosing) depth++;
			else depth--;
			if (depth <= 0) {
				removing = false;
				last = tagRe.lastIndex;
			}
			continue;
		}
		if (!isClosing && predicate(tag, attrs)) {
			out += html.slice(last, m.index);
			removing = true;
			depth = 1;
			continue;
		}
	}
	if (!removing) out += html.slice(last);
	return out;
}

/** Extract the main article (or first section) of a Sphinx page. */
function extractArticle(html) {
	const articleStart = html.indexOf("<article");
	if (articleStart !== -1) {
		const end = html.indexOf("</article>", articleStart);
		if (end !== -1) return html.slice(articleStart, end);
	}
	const sectionStart = html.indexOf("<section");
	if (sectionStart !== -1) {
		const end = html.indexOf("</section>", sectionStart);
		if (end !== -1) return html.slice(sectionStart, end);
	}
	return html;
}

/** Split an article into object blocks at each `dt.sig.sig-object` boundary. */
function splitObjectBlocks(article) {
	const dtRe = /<dt class="sig sig-object[^"]*"[^>]*>/g;
	const starts = [];
	let m;
	while ((m = dtRe.exec(article)) !== null) starts.push(m.index);
	if (starts.length <= 1) return [article];
	const blocks = [];
	for (let i = 0; i < starts.length; i++) {
		const end = i + 1 < starts.length ? starts[i + 1] : article.length;
		blocks.push(article.slice(starts[i], end));
	}
	return blocks;
}

/** Extract the first N doctest/code `<pre>` blocks from a fragment. */
function extractExamples(fragment, max = MAX_EXAMPLES) {
	const preRe = /<pre[^>]*>([\s\S]*?)<\/pre>/g;
	const examples = [];
	let m;
	while ((m = preRe.exec(fragment)) !== null) {
		const text = htmlToText(m[1]);
		if (!text) continue;
		// Keep doctest blocks (>>>) and plain code blocks; skip pure output.
		if (text.includes(">>>") || /^[a-zA-Z_][\w.]*\s*\(/.test(text) || text.includes("import ")) {
			examples.push(text.slice(0, MAX_EXAMPLE_CHARS));
			if (examples.length >= max) break;
		}
	}
	return examples;
}

/** Cut a class page's dd before the Attributes/Methods link tables. */
function cutAtRubric(fragment) {
	const cut = fragment.search(/<p class="rubric">\s*(?:Attributes|Methods)\s*<\/p>/);
	return cut === -1 ? fragment : fragment.slice(0, cut);
}

/** Detect the docs version from a page (version_match or title). */
function detectVersion(html, fallback) {
	const vm = html.match(/version_match\s*=\s*'([^']+)'/);
	if (vm) return vm[1];
	const title = html.match(/<title>([^<]*)<\/title>/);
	if (title) {
		const t = title[1].match(/v?(\d+\.\d+(?:\.\d+)?)/);
		if (t) return t[1];
	}
	return fallback;
}

// ---------------------------------------------------------------------------
// Page selection
// ---------------------------------------------------------------------------

/** Select API-reference page names from an unzipped file map. */
function selectApiPages(files, lib) {
	const names = Object.keys(files).filter((n) => n.endsWith(".html"));
	const prefix = LIBRARIES[lib].apiPrefix;
	const direct = names.filter((n) => n.startsWith(prefix));
	if (lib === "scipy") {
		// SciPy also has "special" API pages directly under reference/
		// (e.g. reference/optimize.minimize-lbfgsb.html) that carry a
		// signature dt but no generated/ prefix. Index pages (optimize.html,
		// stats.html, ...) have no signature dt and are excluded.
		const special = names.filter(
			(n) => n.startsWith("reference/") && !n.startsWith("reference/generated/") && n.includes("<dt class=\"sig sig-object"),
		);
		return [...direct, ...special];
	}
	return direct;
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

/**
 * Turn one API page into one or more chunks (one per `dt.sig` object).
 * Returns [{ id, title, url, text }].
 */
function chunkPage(html, relPath, lib, version) {
	const article = extractArticle(html);
	const cleaned = removeElements(article, (tag, attrs) => {
		if (tag === "script" || tag === "style" || tag === "nav" || tag === "footer" || tag === "aside" || tag === "dialog") {
			return true;
		}
		// Try-examples / jupyterlite iframe wrappers (numpy/pandas) — noise.
		return /class="[^"]*(?:try_examples|jupyterlite)[^"]*"/.test(attrs);
	});
	const blocks = splitObjectBlocks(cleaned);
	const url = LIBRARIES[lib].urlBase + relPath;
	const chunks = [];

	for (let i = 0; i < blocks.length; i++) {
		const block = blocks[i];
		const dtMatch = block.match(/<dt class="sig sig-object[^"]*"[^>]*id="([^"]+)"/);
		const title = dtMatch ? dtMatch[1] : null;
		const sigMatch = block.match(/<dt class="sig sig-object[^"]*"[^>]*>([\s\S]*?)<\/dt>/);
		const signature = sigMatch ? cleanSignature(sigMatch[1]) : title ?? relPath;

		// dd content (everything after the dt), minus the Attributes/Methods
		// link tables on class pages, minus examples (kept separately).
		let dd = block;
		if (sigMatch) dd = block.slice(sigMatch.index + sigMatch[0].length);
		dd = cutAtRubric(dd);
		const examples = extractExamples(dd);
		const ddWithoutPre = dd.replace(/<pre[^>]*>[\s\S]*?<\/pre>/g, " ");
		const description = htmlToText(ddWithoutPre).slice(0, MAX_DESCRIPTION_CHARS);

		const objectName = title ?? signature.split("(")[0]?.trim() ?? relPath;
		const text = [
			`## ${objectName} (${lib} ${version})`,
			`Signature: ${signature}`,
			description,
			...(examples.length > 0 ? ["Example:", ...examples] : []),
			`Source: ${url}`,
		]
			.filter((part) => part && part.trim())
			.join("\n\n");

		chunks.push({
			id: `${lib}:${relPath}#${i}`,
			title: objectName,
			url,
			text,
		});
	}
	return chunks;
}

// ---------------------------------------------------------------------------
// Corpus acquisition
// ---------------------------------------------------------------------------

async function downloadZip(url) {
	const resp = await fetch(url, { redirect: "follow" });
	if (!resp.ok) throw new Error(`download failed (HTTP ${resp.status}): ${url}`);
	const buf = Buffer.from(await resp.arrayBuffer());
	return buf;
}

function sha256(buf) {
	return createHash("sha256").update(buf).digest("hex");
}

/** Recursively list .html files under a directory (matplotlib crawl). */
async function listHtmlFiles(dir) {
	const out = [];
	async function walk(d) {
		const entries = await readdir(d, { withFileTypes: true });
		for (const entry of entries) {
			const full = path.join(d, entry.name);
			if (entry.isDirectory()) await walk(full);
			else if (entry.isFile() && entry.name.endsWith(".html")) out.push(full);
		}
	}
	await walk(dir);
	return out;
}

// ---------------------------------------------------------------------------
// Embedding
// ---------------------------------------------------------------------------

function createEmbedder() {
	const provider = createOpenAICompatible({
		name: "ki-connect",
		baseURL: process.env.KI_CONNECT_BASE_URL ?? "https://chat.kiconnect.nrw/api/v1",
		apiKey: process.env.KI_CONNECT_API_KEY,
	});
	return provider.embeddingModel(EMBEDDING_MODEL);
}

/** Embed texts in batches with bounded concurrency (KI Connect rate limit). */
async function embedAll(model, texts, onProgress) {
	const vectors = new Array(texts.length);
	let next = 0;
	async function worker() {
		while (true) {
			const start = next;
			next += EMBED_BATCH;
			if (start >= texts.length) return;
			const batch = texts.slice(start, start + EMBED_BATCH);
			const result = await model.doEmbed({ values: batch });
			// A partial response would leave undefined holes in `vectors`
			// that reach the write loop as a TypeError — fail loudly so the
			// outer try/catch writes the index WITHOUT vectors instead.
			if (result.embeddings.length !== batch.length) {
				throw new Error(
					`embedding API returned ${result.embeddings.length} vectors for a ${batch.length}-text batch`,
				);
			}
			for (let i = 0; i < result.embeddings.length; i++) {
				vectors[start + i] = result.embeddings[i];
			}
			onProgress?.(start + result.embeddings.length, texts.length);
		}
	}
	await Promise.all(Array.from({ length: EMBED_CONCURRENCY }, () => worker()));
	return vectors;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));

const requested = args.libraries ?? Object.keys(LIBRARIES);
const libraries = requested.filter((lib) => {
	if (LIBRARIES[lib]) return true;
	console.warn(`[build-docs-index] unknown library "${lib}" — skipping`);
	return false;
});
if (libraries.length === 0) {
	console.error("[build-docs-index] no libraries selected");
	process.exit(1);
}

const outDir = args.out ?? process.env.DOCS_INDEX_DIR ?? path.join(process.env.DATA_DIR ?? "./data", "docs-index");
await mkdir(outDir, { recursive: true });

const allChunks = [];
const allVectors = [];
const manifestLibraries = [];
let embeddingModel = null;
let embeddingDim = null;

for (const lib of libraries) {
	const cfg = LIBRARIES[lib];
	console.log(`[build-docs-index] === ${lib} ===`);

	let files;
	let zipSha = null;
	let sourceUrl = cfg.zipUrl ?? null;

	if (cfg.zipUrl) {
		console.log(`[build-docs-index] downloading ${cfg.zipUrl} …`);
		const buf = await downloadZip(cfg.zipUrl);
		zipSha = sha256(buf);
		console.log(`[build-docs-index]   ${(buf.length / 1024 / 1024).toFixed(1)} MB, sha256 ${zipSha.slice(0, 12)}…`);
		files = unzipSync(new Uint8Array(buf));
	} else if (lib === "matplotlib") {
		if (!args.matplotlibDir) {
			console.warn(
				"[build-docs-index] matplotlib has no official doc zip — pass --matplotlib-dir <crawled-dir> to include it; skipping for this build",
			);
			continue;
		}
		console.log(`[build-docs-index] reading pre-crawled dir ${args.matplotlibDir} …`);
		const htmlFiles = await listHtmlFiles(args.matplotlibDir);
		files = {};
		for (const f of htmlFiles) {
			const rel = path.relative(args.matplotlibDir, f).split(path.sep).join("/");
			files[rel] = new TextEncoder().encode(await readFile(f, "utf-8"));
		}
		sourceUrl = "crawled:" + args.matplotlibDir;
	} else {
		console.warn(`[build-docs-index] no source for ${lib} — skipping`);
		continue;
	}

	const pages = selectApiPages(files, lib);
	const limited = args.limit ? pages.slice(0, args.limit) : pages;
	console.log(`[build-docs-index]   ${pages.length} API pages (processing ${limited.length})`);

	let version = cfg.pinnedVersion;
	let libChunks = [];
	for (const relPath of limited) {
		const html = strFromU8(files[relPath]);
		if (version === cfg.pinnedVersion) version = detectVersion(html, cfg.pinnedVersion);
		libChunks.push(...chunkPage(html, relPath, lib, version));
	}
	console.log(`[build-docs-index]   ${libChunks.length} chunks (docs version ${version})`);

	manifestLibraries.push({
		library: lib,
		version,
		pinnedVersion: cfg.pinnedVersion,
		sourceUrl,
		sha256: zipSha,
		builtAt: new Date().toISOString(),
	});

	if (!args.skipEmbed) {
		if (!process.env.KI_CONNECT_API_KEY) {
			console.warn("[build-docs-index] KI_CONNECT_API_KEY not set — writing index WITHOUT vectors (BM25-only at runtime)");
		} else {
			try {
				const model = createEmbedder();
				embeddingModel = EMBEDDING_MODEL;
				embeddingDim = EMBEDDING_DIM;
				console.log(`[build-docs-index]   embedding ${libChunks.length} chunks (${EMBEDDING_MODEL}, concurrency ${EMBED_CONCURRENCY}) …`);
				const vectors = await embedAll(model, libChunks.map((c) => c.text), (done, total) => {
					if (done % 64 === 0 || done === total) console.log(`[build-docs-index]     ${done}/${total}`);
				});
				allVectors.push(...vectors);
			} catch (err) {
				console.warn(`[build-docs-index]   embedding failed (${err instanceof Error ? err.message : String(err)}) — writing index WITHOUT vectors`);
			}
		}
	}

	allChunks.push(...libChunks.map((c) => ({ ...c, library: lib, version })));
}

if (allChunks.length === 0) {
	console.error("[build-docs-index] no chunks produced — nothing to write");
	process.exit(1);
}

const index = {
	format: "svelte-review-copilot-docs-index",
	formatVersion: 1,
	builtAt: new Date().toISOString(),
	embeddingModel,
	embeddingDim,
	libraries: manifestLibraries,
	chunks: allChunks,
};
if (allVectors.length > 0) {
	index.vectorsFile = "docs-vectors.bin";
	index.vectorCount = allVectors.length;
}

const outPath = path.join(outDir, "docs-index.json");
await writeFile(outPath, JSON.stringify(index), "utf-8");

if (allVectors.length > 0) {
	// float32 little-endian, row-major: chunk i's vector at byte offset
	// i * embeddingDim * 4. writeFloatLE explicitly (do NOT rely on
	// Buffer.from(Float32Array) platform endianness).
	const buf = Buffer.allocUnsafe(allVectors.length * embeddingDim * 4);
	for (let i = 0; i < allVectors.length; i++) {
		const vec = allVectors[i];
		const offset = i * embeddingDim * 4;
		for (let j = 0; j < embeddingDim; j++) {
			buf.writeFloatLE(vec[j], offset + j * 4);
		}
	}
	const vectorsPath = path.join(outDir, "docs-vectors.bin");
	await writeFile(vectorsPath, buf);
	console.log(
		`[build-docs-index] wrote ${vectorsPath}: ${allVectors.length} vectors x ${embeddingDim} dims (${buf.length} bytes)`,
	);
}

console.log(
	`[build-docs-index] wrote ${outPath}: ${allChunks.length} chunks, ${allVectors.length} vectors, ${manifestLibraries.length} libraries`,
);
