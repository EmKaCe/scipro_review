#!/usr/bin/env node
/**
 * @file publish-docs-index.mjs — publish a LOCALLY-built docs index to the
 * `docs-index` GitHub Release.
 *
 * Rationale: the full corpus build (crawl ~12-180 MB + embed ~20k chunks at
 * concurrency 2) is a ~40-60 min job that would burn GitHub Actions minutes
 * on every run. Building it locally (where the KI_CONNECT_API_KEY is already
 * available) keeps Actions usage at zero — this script only uploads already
 * built artifacts and computes the integrity manifest. GH Actions is scoped to
 * manual rebuilds only, so the expensive embed never auto-runs.
 *
 * Run AFTER `build-docs-index.mjs`:
 *   node scripts/publish-docs-index.mjs [--dir <built-index-dir>] [--tag <tag>]
 *     --dir  dir holding docs-index.json + docs-vectors.bin (default: <DATA_DIR>/docs-index)
 *     --tag  release tag (default: docs-index)
 *
 * Requires the `gh` CLI authenticated as the repo owner (pub policy: this
 * publishes a public release asset — explicit, reviewed action only).
 *
 * Publishes: docs-index.json, docs-vectors.bin, docs-index.manifest.json
 * (which carries configSha so the skip-if-unchanged gate in the (rare) CI
 * rebuild path can short-circuit).
 */
import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";

const TAG = "docs-index";

function usage() {
	console.log(`Usage: node scripts/publish-docs-index.mjs [options]
  --dir <dir>    built index dir (default: $DOCS_INDEX_DIR or <DATA_DIR>/docs-index)
  --tag <tag>    release tag (default: ${TAG})
  --help         show this help`);
}

function parseArgs(argv) {
	const args = { dir: null, tag: TAG };
	for (let i = 0; i < argv.length; i++) {
		switch (argv[i]) {
			case "--dir":
				args.dir = argv[++i];
				break;
			case "--tag":
				args.tag = argv[++i];
				break;
			case "--help":
				usage();
				process.exit(0);
			default:
				console.warn(`[publish-docs-index] ignoring unknown argument: ${argv[i]}`);
		}
	}
	return args;
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const gh = (args, opts = {}) => execFileSync("gh", args, { encoding: "utf-8", ...opts });

const args = parseArgs(process.argv.slice(2));
const dir = args.dir ?? process.env.DOCS_INDEX_DIR ?? path.join(process.env.DATA_DIR ?? "./data", "docs-index");
const tag = args.tag;

const jsonPath = path.join(dir, "docs-index.json");
const binPath = path.join(dir, "docs-vectors.bin");
for (const p of [jsonPath, binPath]) {
	try {
		await stat(p);
	} catch {
		console.error(`[publish-docs-index] missing artifact: ${p}`);
		process.exit(1);
	}
}

const json = JSON.parse(await readFile(jsonPath, "utf-8"));
const configSha = sha256(
	Buffer.concat([
		await readFile(path.join(process.cwd(), "frontend", "scripts", "docs-libraries.json")),
		await readFile(path.join(process.cwd(), "frontend", "scripts", "build-docs-index.mjs")),
	]),
);
const manifest = {
	format: json.format,
	formatVersion: json.formatVersion,
	chunks: json.chunks?.length,
	embeddingModel: json.embeddingModel ?? null,
	libraries: (json.libraries || []).map((l) => l.library),
	builtAt: json.builtAt ?? null,
	configSha,
	sha256: {
		"docs-index.json": sha256(await readFile(jsonPath)),
		"docs-vectors.bin": sha256(await readFile(binPath)),
	},
};
const manifestPath = path.join(dir, "docs-index.manifest.json");
await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

console.log(
	`[publish-docs-index] ${manifest.chunks} chunks, ${manifest.libraries.length} libraries, vectors=${json.vectorCount ?? 0}, built ${manifest.builtAt}`,
);

// Create the release if the tag doesn't exist yet (ignore if it does).
try {
	gh(["release", "view", tag, "--json", "tagName"]);
} catch {
	console.log(`[publish-docs-index] creating release tag '${tag}' …`);
	gh(["release", "create", tag, "--title", "Offline docs index", "--notes", "Prebuilt offline docs index."]);
}

console.log(`[publish-docs-index] uploading 3 assets to '${tag}' …`);
gh(["release", "upload", tag, jsonPath, binPath, manifestPath, "--clobber"]);
console.log(`[publish-docs-index] done. Consumers run: node scripts/fetch-docs-index.mjs`);
