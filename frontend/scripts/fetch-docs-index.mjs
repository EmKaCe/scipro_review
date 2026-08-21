#!/usr/bin/env node
/**
 * @file fetch-docs-index.mjs — download the PREBUILT offline docs index.
 *
 * The offline docs index (docs-index.json + docs-vectors.bin, ~350 MB) is
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
 * In BOTH modes the SHA256 of the two artifacts is verified against the
 * release manifest (docs-index.manifest.json) before anything is renamed
 * into place; the same staging dir + rename-into-place flow is used.
 *
 * Usage: node scripts/fetch-docs-index.mjs [options]
 *   --out <dir>   target dir (default: $DOCS_INDEX_DIR or <DATA_DIR>/docs-index)
 *   --repo <r>    owner/repo (default: EmKaCe/scipro_review)
 *   --tag <t>     release tag (default: docs-index)
 *   --public      use plain HTTPS download (public repo) instead of the gh CLI
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
  --help        show this help`);
}

function parseArgs(argv) {
	const args = { out: null, repo: "EmKaCe/scipro_review", tag: TAG, public: false };
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
			case "--help":
				usage();
				process.exit(0);
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
const outDir = args.out ?? process.env.DOCS_INDEX_DIR ?? path.join(process.env.DATA_DIR ?? "./data", "docs-index");
const stashed = path.join(outDir, ".fetch-staging");
await mkdir(stashed, { recursive: true });

if (args.public) {
	console.log(`[fetch-docs-index] HTTPS download ${args.tag} (${args.repo}, public) -> ${stashed}`);
	for (const f of [...ARTIFACTS, MANIFEST]) {
		await downloadViaHttps(args.repo, args.tag, f, path.join(stashed, f));
	}
} else {
	console.log(`[fetch-docs-index] gh release download ${args.tag} (${args.repo}) -> ${stashed}`);
	gh(["release", "download", args.tag, "--repo", args.repo, "--dir", stashed, "--clobber"]);
}
console.log("[fetch-docs-index] downloaded; verifying sha256 …");

const manifest = JSON.parse(await readFile(path.join(stashed, MANIFEST), "utf-8"));
console.log(
	`[fetch-docs-index] manifest: ${manifest.chunks ?? "?"} chunks, ${manifest.libraries?.length ?? "?"} libraries, vectors=${manifest.sha256 ? "yes" : "n/a"}, built ${manifest.builtAt ?? "?"}`,
);

for (const f of ARTIFACTS) {
	const buf = await readFile(path.join(stashed, f));
	const h = sha256(buf);
	const expected = manifest.sha256?.[f];
	if (expected && h !== expected) {
		throw new Error(`sha256 mismatch for ${f}: expected ${expected}, got ${h} — refusing to install`);
	}
	if (expected) console.log(`  ${f}: ok (${h.slice(0, 12)})`);
}

await mkdir(outDir, { recursive: true });
for (const f of [...ARTIFACTS, MANIFEST]) {
	await rename(path.join(stashed, f), path.join(outDir, f));
}
await rm(stashed, { recursive: true, force: true });
console.log(`[fetch-docs-index] done -> ${outDir}`);
