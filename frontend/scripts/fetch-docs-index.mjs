#!/usr/bin/env node
/**
 * @file fetch-docs-index.mjs — download the PREBUILT offline docs index.
 *
 * The offline docs index (docs-index.json + docs-vectors.bin, ~350 MB) is
 * built once by CI (see .github/workflows/docs-index.yml) and published as a
 * GitHub Release asset under the `docs-index` tag. A fresh clone / a teacher
 * deploy runs THIS script to get a working corpus in seconds — no crawl, no
 * embedding job, no 30-60 min build. `build-docs-index.mjs` remains the path
 * to REBUILD from source.
 *
 * Requires network only. (The runtime KI_CONNECT_API_KEY is still needed
 * separately — the semantic search leg embeds the query per request — but
 * that is not this script's concern.)
 *
 * Usage: node scripts/fetch-docs-index.mjs [options]
 *   --out <dir>     target dir (default: $DOCS_INDEX_DIR or <DATA_DIR>/docs-index)
 *   --base <url>    release base URL (default: https://github.com/EmKaCe/svelte_review/releases/download/docs-index)
 *   --check         verify the manifest + file shas WITHOUT writing
 *   --help          show usage
 *
 * Env: DATA_DIR, DOCS_INDEX_DIR (honoured for the default --out).
 *
 * Integrity: downloads docs-index.manifest.json first (contains the sha256 of
 * both artifacts), verifies each download against it, and only then renames
 * into place — a tampered or truncated download never clobbers a good index.
 */
import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const MANIFEST = "docs-index.manifest.json";
const ARTIFACTS = ["docs-index.json", "docs-vectors.bin"];
const DEFAULT_BASE = "https://github.com/EmKaCe/svelte_review/releases/download/docs-index";

function usage() {
	console.log(`Usage: node scripts/fetch-docs-index.mjs [options]
  --out <dir>    target dir (default: $DOCS_INDEX_DIR or <DATA_DIR>/docs-index)
  --base <url>   release base URL (default: ${DEFAULT_BASE})
  --check        verify manifest + file shas without writing
  --help         show this help`);
}

function parseArgs(argv) {
	const args = { out: null, base: null, check: false };
	for (let i = 0; i < argv.length; i++) {
		switch (argv[i]) {
			case "--out":
				args.out = argv[++i];
				break;
			case "--base":
				args.base = argv[++i];
				break;
			case "--check":
				args.check = true;
				break;
			case "--help":
				usage();
				process.exit(0);
			default:
				console.warn(`[fetch-docs-index] ignoring unknown argument: ${argv[i]}`);
		}
	}
	return args;
}

async function download(url, label) {
	const resp = await fetch(url, { redirect: "follow" });
	if (!resp.ok) throw new Error(`download failed (HTTP ${resp.status}): ${url}`);
	return Buffer.from(await resp.arrayBuffer());
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

const args = parseArgs(process.argv.slice(2));
const outDir =
	args.out ?? process.env.DOCS_INDEX_DIR ?? path.join(process.env.DATA_DIR ?? "./data", "docs-index");
const base = args.base ?? DEFAULT_BASE;

const manifestUrl = `${base}/${MANIFEST}`;
console.log(`[fetch-docs-index] fetching ${manifestUrl}`);
const manifestBuf = await download(manifestUrl, MANIFEST);
const manifest = JSON.parse(manifestBuf.toString("utf-8"));
console.log(
	`[fetch-docs-index] manifest: ${manifest.chunks ?? "?"} chunks, ${manifest.libraries?.length ?? "?"} libraries, built ${manifest.builtAt ?? "?"}`,
);

for (const f of ARTIFACTS) {
	const buf = await download(`${base}/${f}`, f);
	const h = sha256(buf);
	const expected = manifest.sha256?.[f];
	if (expected && h !== expected) {
		throw new Error(`sha256 mismatch for ${f}: expected ${expected}, got ${h} — refusing to write`);
	}
	if (args.check) {
		console.log(`[fetch-docs-index] ${f}: ok (${expected ? "verified" : "no pinned sha"} ${h.slice(0, 12)})`);
		continue;
	}
	await mkdir(outDir, { recursive: true });
	const tmp = path.join(outDir, `${f}.tmp-${process.pid}`);
	await writeFile(tmp, buf);
	await rename(tmp, path.join(outDir, f));
	console.log(`[fetch-docs-index] wrote ${path.join(outDir, f)} (${(buf.length / 1024 / 1024).toFixed(1)} MB, sha ${h.slice(0, 12)})`);
}

if (!args.check) {
	await mkdir(outDir, { recursive: true });
	await writeFile(path.join(outDir, MANIFEST), manifestBuf);
	console.log(`[fetch-docs-index] done -> ${outDir}`);
}
