/**
 * @file Server-side trigger for the PREBUILT offline docs-index download.
 *
 * POST /api/onboarding/docs-index calls this. It runs
 * scripts/fetch-docs-index.mjs in --public mode — plain HTTPS download of the
 * public release assets; NO API key, NO gh CLI, and NEVER build-docs-index —
 * with --out pointing at <DATA_DIR>/docs-index (or $DOCS_INDEX_DIR).
 *
 * The script stages into .fetch-staging/ inside the target dir and renames
 * into place only after the SHA-256 manifest check passes, so a failed
 * download never leaves a torn index. This module only serializes concurrent
 * downloads (single in-flight guard) and surfaces the child's exit status —
 * it never touches, reads, or logs secrets.
 */

import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getDataDir } from "$lib/server/metadata";

/** fetch-docs-index.mjs relative to this module (src/lib/server → scripts/). */
function resolveFetchScript(): string {
	try {
		return fileURLToPath(new URL("../../../scripts/fetch-docs-index.mjs", import.meta.url));
	} catch {
		// Vitest/vite-node transforms import.meta.url to a non-file scheme —
		// fall back to the repo-relative path from the process cwd.
		return path.resolve(process.cwd(), "scripts/fetch-docs-index.mjs");
	}
}
const INDEX_FILENAME = "docs-index.json";

export interface DocsIndexDownloadResult {
	ok: true;
	/** True when the index was already present — nothing was downloaded. */
	alreadyPresent: boolean;
	/** Captured script stdout (progress log); may be empty. */
	output: string;
}

/** Thrown when another download is already in flight → HTTP 409. */
export class DocsIndexDownloadInProgressError extends Error {
	constructor() {
		super("A docs-index download is already in progress.");
		this.name = "DocsIndexDownloadInProgressError";
	}
}

/** Thrown when the fetch script exits non-zero → HTTP 500 with exit detail. */
export class DocsIndexDownloadFailedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DocsIndexDownloadFailedError";
	}
}

/** Target dir, mirroring docs-rag.getIndexPath() / onboarding status resolution. */
function getDocsIndexDir(): string {
	if (process.env.DOCS_INDEX_DIR) return process.env.DOCS_INDEX_DIR;
	return path.join(getDataDir(), "docs-index");
}

async function indexExists(dir: string): Promise<boolean> {
	try {
		await access(path.join(dir, INDEX_FILENAME));
		return true;
	} catch {
		return false;
	}
}

/**
 * Single-flight job slot, SHARED between the docs-index download (mode A)
 * and the 2.7.0 embed-rebuild job (option B) — claimJobSlot/tryRelease.
 * The legacy `downloadDocsIndex` mirror keeps its own guard-free path by
 * claiming through the same slot.
 */
let slotOwner: string | null = null;

/** Claim the single docs-index mutation slot. Throws when already held. */
export function claimJobSlot(owner: string): void {
	if (slotOwner !== null) {
		throw new Error(`A docs-index job (${slotOwner}) is already in progress.`);
	}
	slotOwner = owner;
}

/** Release the slot (idempotent for the given owner). */
export function releaseJobSlot(owner: string): void {
	if (slotOwner === owner) slotOwner = null;
}

/** Test hook: force-release the slot (never mid-job in production). */
export function __resetJobSlotForTests(): void {
	slotOwner = null;
}

/** Legacy in-flight promise guard for downloadDocsIndex — mirrors slotOwner. */
let inFlight: Promise<DocsIndexDownloadResult> | null = null;

/**
 * Download (or refresh) the public docs-index into DATA_DIR/docs-index.
 *
 * Serializes concurrent calls: while one download runs, others reject with
 * DocsIndexDownloadInProgressError. When docs-index.json is already present
 * the call returns immediately without touching the network.
 */
export async function downloadDocsIndex(): Promise<DocsIndexDownloadResult> {
	// Fast path — already in place; read-only check, no guard needed.
	const dir = getDocsIndexDir();
	if (await indexExists(dir)) {
		return { ok: true, alreadyPresent: true, output: "" };
	}
	if (inFlight) {
		throw new DocsIndexDownloadInProgressError();
	}
	// Claim the shared slot so embed-rebuild (option B) contends with us too.
	claimJobSlot("docs-index-download");

	const run = (async (): Promise<DocsIndexDownloadResult> => {
		// Re-check under the guard: a concurrent run may have landed the file.
		if (await indexExists(dir)) {
			return { ok: true, alreadyPresent: true, output: "" };
		}
		const child = spawn(process.execPath, [resolveFetchScript(), "--public", "--out", dir], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		const code = await new Promise<number | null>((resolve, reject) => {
			child.once("close", resolve);
			child.once("error", reject);
		});
		if (code !== 0) {
			const tail = (stderr || stdout).trim().split("\n").slice(-6).join("\n");
			throw new DocsIndexDownloadFailedError(
				`docs-index fetch exited with code ${code}${tail ? `: ${tail}` : ""}`,
			);
		}
		return { ok: true, alreadyPresent: false, output: stdout };
	})();

	inFlight = run;
	try {
		return await run;
	} finally {
		if (inFlight === run) inFlight = null;
		releaseJobSlot("docs-index-download");
	}
}
