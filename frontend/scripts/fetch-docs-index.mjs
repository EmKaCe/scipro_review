#!/usr/bin/env node
/**
 * @file fetch-docs-index.mjs — download the PREBUILT offline docs index.
 *
 * The offline docs index (docs-index.json + docs-vectors.bin, ≈ 630 MB) is
 * published to the `docs-index` GitHub release (see scripts/publish-docs-index.mjs
 * and .github/workflows/docs-index.yml). A fresh clone / teacher deploy runs
 * THIS to get a working corpus in seconds — no crawl, no embedding, no
 * long build. `build-docs-index.mjs` remains the path to REBUILD from source.
 *
 * Two download modes:
 *   1. DEFAULT (private repo): `gh release download`. Requires the `gh` CLI
 *      authenticated as a member of the repo (the repo is private; the asset
 *      is fetched with the necessary auth).
 *   2. --public (public repo): plain HTTPS download of the release assets.
 *      Uses node's built-in `fetch` with redirect following onto
 *      objects.githubusercontent.com — no auth, no gh CLI, works for any
 *      public release. Required for the public release repo at cutover.
 *
 * Two artifact sets (same staging dir + rename-into-place flow in both):
 *   - FULL (default): docs-index.json + docs-vectors.bin + manifest.
 *   - --chunks-only: downloads ONLY docs-index.json + docs-index.manifest.json
 *     (sha256 verified) and skips the ≈ 630 MB docs-vectors.bin. This is the
 *     corpus-only fetch consumed by the 2.7.0 Option-B pipeline, which
 *     re-embeds the released chunk texts locally (see .github/references/
 *     plans/2.7.0-docs-embeddings-onboarding.md). No API key needed.
 *
 * In BOTH modes and BOTH artifact sets the SHA256 of every downloaded artifact
 * is verified against the release manifest (docs-index.manifest.json) BEFORE
 * anything is renamed into place. Additionally, after sha256 passes, the
 * manifest's chunk/vector claims are cross-checked against the downloaded
 * files themselves (hardening from the 2026-08-30 stale-manifest incident):
 * manifest.chunks must equal the JSON's chunks.length (and vectorCount when
 * vectors are part of the download), and vectorCount × embeddingDim × 4 must
 * equal the .bin byte length. Any mismatch refuses to install, fail-closed —
 * sha256 only proves bytes arrived intact, not that the manifest describes
 * the artifacts it shipped with.
 *
 * Usage: node scripts/fetch-docs-index.mjs [options]
 *   --out <dir>   target dir (default: $DOCS_INDEX_DIR or <DATA_DIR>/docs-index)
 *   --repo <r>    owner/repo (default: EmKaCe/scipro_review)
 *   --tag <t>     release tag (default: docs-index)
 *   --public      use plain HTTPS download (public repo) instead of the gh CLI
 *   --chunks-only download docs-index.json + the manifest ONLY (skip the vectors bin)
 *   --help        show this help
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";

const TAG = "docs-index";
const MANIFEST = "docs-index.manifest.json";
const ARTIFACTS = ["docs-index.json", "docs-vectors.bin"];

function usage() {
	console.log(`Usage: node scripts/fetch-docs-index.mjs [options]
  --out <dir>   target dir (default: $DOCS_INDEX_DIR or <DATA_DIR>/docs-index)
  --repo <r>    owner/repo (default: EmKaCe/scipro_review)
  --tag <t>     release tag (default: ${TAG})
  --public      use plain HTTPS download (public repo) instead of the gh CLI
  --chunks-only download docs-index.json + the manifest ONLY (skip the vectors bin)
  --help        show this help`);
}

function parseArgs(argv) {
	const args = {
		out: null,
		repo: "EmKaCe/scipro_review",
		tag: TAG,
		public: false,
		chunksOnly: false,
	};
	for (let i = 0; i < argv.length; i++) {
		switch (argv[i]) {
			case "--out":
				args.out = argv[++i];
				break;
			case "--repo":
				args.repo = argv[++i];
				break;
			case "--tag":
				args.tag = argv[++i];
				break;
			case "--public":
				args.public = true;
				break;
			case "--chunks-only":
				args.chunksOnly = true;
				break;
			case "--help":
				usage();
				process.exit(0);
				break;
			default:
				console.warn(`[fetch-docs-index] ignoring unknown argument: ${argv[i]}`);
		}
	}
	return args;
}

const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const gh = (args) => execFileSync("gh", args, { encoding: "utf-8" });

/**
 * Download a release asset over plain HTTPS, following redirects (GitHub
 * redirects /releases/download/... to objects.githubusercontent.com).
 * No auth; works for any PUBLIC release asset.
 */
async function downloadViaHttps(repo, tag, asset, dest) {
	const url = `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(asset)}`;
	console.log(`[fetch-docs-index] fetch ${url}`);
	const res = await fetch(url, { redirect: "follow" });
	if (!res.ok) {
		throw new Error(`download ${asset}: HTTP ${res.status} ${res.statusText}`);
	}
	const buf = Buffer.from(await res.arrayBuffer());
	await writeFile(dest, buf);
}

const args = parseArgs(process.argv.slice(2));
const outDir =
	args.out ??
	process.env.DOCS_INDEX_DIR ??
	path.join(process.env.DATA_DIR ?? "./data", "docs-index");
const artifacts = args.chunksOnly ? ["docs-index.json"] : ARTIFACTS;
const modeLabel = args.chunksOnly ? "chunks-only" : "full";
const stashed = path.join(outDir, ".fetch-staging");
await mkdir(stashed, { recursive: true });

if (args.public) {
	console.log(
		`[fetch-docs-index] HTTPS download ${args.tag} (${args.repo}, ${modeLabel}, public) -> ${stashed}`,
	);
	for (const f of [...artifacts, MANIFEST]) {
		await downloadViaHttps(args.repo, args.tag, f, path.join(stashed, f));
	}
} else {
	const ghArgs = [
		"release",
		"download",
		args.tag,
		"--repo",
		args.repo,
		"--dir",
		stashed,
		"--clobber",
	];
	if (args.chunksOnly) ghArgs.push("--pattern", "docs-index.json", "--pattern", MANIFEST);
	console.log(
		`[fetch-docs-index] gh release download ${args.tag} (${args.repo}, ${modeLabel}) -> ${stashed}`,
	);
	gh(ghArgs);
}
console.log("[fetch-docs-index] downloaded; verifying sha256 …");

const manifest = JSON.parse(await readFile(path.join(stashed, MANIFEST), "utf-8"));
console.log(
	`[fetch-docs-index] manifest: ${manifest.chunks ?? "?"} chunks, ${manifest.libraries?.length ?? "?"} libraries, vectors=${manifest.sha256 ? "yes" : "n/a"}, built ${manifest.builtAt ?? "?"}`,
);

// sha256 per artifact; keep the buffers so the byte-length cross-check below
// does not re-read the ≈ 630 MB vectors file from disk.
const verified = {};
for (const f of artifacts) {
	const buf = await readFile(path.join(stashed, f));
	const h = sha256(buf);
	const expected = manifest.sha256?.[f];
	if (expected && h !== expected) {
		throw new Error(
			`sha256 mismatch for ${f}: expected ${expected}, got ${h} — refusing to install`,
		);
	}
	if (expected) console.log(`  ${f}: ok (${h.slice(0, 12)})`);
	verified[f] = buf;
}

// --- Consistency cross-check (2026-08-30 stale-manifest incident hardening) ---
// sha256 proves the bytes arrived intact; it does NOT prove the release
// manifest describes the artifacts it shipped with. A stale manifest (chunk /
// vector counts copied from an older build) would silently install an index
// whose manifest and files disagree — the loader would only degrade later.
// Cross-check BEFORE install and refuse on any mismatch (fail-closed, both
// download modes and both artifact sets).
const json = JSON.parse(await readFile(path.join(stashed, "docs-index.json"), "utf-8"));
const chunkCount = Array.isArray(json.chunks) ? json.chunks.length : null;
if (chunkCount === null) {
	throw new Error(
		`docs-index.json has no chunks array (${typeof json.chunks}) — file is corrupt; refusing to install; re-publish`,
	);
}
if (manifest.chunks !== chunkCount) {
	throw new Error(
		`manifest says ${manifest.chunks} chunks, file has ${chunkCount} — manifest is stale; re-publish`,
	);
}
const vectorsIncluded = artifacts.includes("docs-vectors.bin");
if (vectorsIncluded) {
	const vectorCount = json.vectorCount;
	if (typeof vectorCount !== "number" || !Number.isInteger(vectorCount) || vectorCount <= 0) {
		throw new Error(
			`index declares vectorCount ${vectorCount} (expected a positive integer) — file is corrupt; refusing to install; re-publish`,
		);
	}
	if (vectorCount !== chunkCount) {
		throw new Error(
			`index declares ${vectorCount} vectors for ${chunkCount} chunks — vectors are stale; re-publish`,
		);
	}
	const dim = json.embeddingDim;
	if (typeof dim !== "number" || !Number.isInteger(dim) || dim <= 0) {
		throw new Error(
			`index declares embeddingDim ${dim} (expected a positive integer) — file is corrupt; refusing to install; re-publish`,
		);
	}
	const expectedBytes = vectorCount * dim * 4;
	const binBuf = verified["docs-vectors.bin"];
	if (binBuf.byteLength !== expectedBytes) {
		throw new Error(
			`index says ${expectedBytes} bytes (${vectorCount} × ${dim} × 4), file has ${binBuf.byteLength} — vectors are stale; re-publish`,
		);
	}
	console.log(
		`  docs-vectors.bin: ${binBuf.byteLength} bytes matches ${vectorCount} × ${dim} × 4`,
	);
}

await mkdir(outDir, { recursive: true });
for (const f of [...artifacts, MANIFEST]) {
	await rename(path.join(stashed, f), path.join(outDir, f));
}
await rm(stashed, { recursive: true, force: true });
console.log(`[fetch-docs-index] done -> ${outDir}`);
