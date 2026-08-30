/**
 * @file POST /api/onboarding/docs-embeddings — start a docs-embeddings job.
 *
 * Body (JSON):
 *   mode        — "download" | "rebuild" | "skip" (required)
 *   overwrite   — rebuild only: required true when vectors already exist
 *   batch       — optional batch-size override (1..64)
 *
 * - download: shared-slot URL-alias of the legacy docs-index fetch (kept so
 *   the current frontend keeps working; the card migrates in 2.7.0-W2B).
 * - rebuild: starts the detached embed-rebuild job (poll GET status).
 * - skip: explicit "BM25-only" choice — no job, nothing written; the docs
 *   leg simply has no vectors. Always 200 { ok: true, skipped: true }.
 *
 * Errors: 409 job-in-flight, 422 no API key (rebuild), 400 overwrite
 * required / bad mode / bad batch, 500 fetch failure (legacy alias path).
 */

import { error, json } from "@sveltejs/kit";
import type { RequestEvent } from "@sveltejs/kit";
import { stat } from "node:fs/promises";
import path from "node:path";

import {
	DocsEmbedJobInProgressError,
	DocsEmbedNoKeyError,
	startDocsEmbedRebuild,
} from "$lib/server/docs-embed-rebuild";
import {
	DocsIndexDownloadFailedError,
	DocsIndexDownloadInProgressError,
	downloadDocsIndex,
} from "$lib/server/onboarding-docs-index";
import { getDataDir } from "$lib/server/metadata";

function vectorsBinPath(): string {
	if (process.env.DOCS_INDEX_DIR) {
		return path.join(process.env.DOCS_INDEX_DIR, "docs-vectors.bin");
	}
	return path.join(getDataDir(), "docs-index", "docs-vectors.bin");
}

async function vectorsExist(): Promise<boolean> {
	try {
		const s = await stat(vectorsBinPath());
		return s.isFile() && s.size > 0;
	} catch {
		return false;
	}
}

export async function POST({ request }: RequestEvent): Promise<Response> {
	let body: {
		mode?: unknown;
		overwrite?: unknown;
		batch?: unknown;
	};
	try {
		body = (await request.json()) as typeof body;
	} catch {
		throw error(400, "Request body must be JSON");
	}

	const mode = body.mode;
	const overwrite = body.overwrite === true;

	if (mode === "skip") {
		// Explicit BM25-only choice. Nothing written; honest degradation is the
		// absence of vectors. A stale interrupted state file might exist —
		// leave status to surface it with Retry (the teacher may change their
		// mind); skip is non-destructive by contract.
		return json({ ok: true, skipped: true });
	}

	if (mode === "download") {
		try {
			const result = await downloadDocsIndex();
			return json(result);
		} catch (err) {
			if (err instanceof DocsIndexDownloadInProgressError) throw error(409, err.message);
			if (err instanceof DocsIndexDownloadFailedError) throw error(500, err.message);
			throw err;
		}
	}

	if (mode === "rebuild") {
		// Overwrite guard FIRST (job-state-less, cheap): vectors already on
		// disk and no explicit confirmation → 400 with the confirm semantics.
		if (!overwrite && (await vectorsExist())) {
			throw error(400, "Vectors already exist — pass overwrite:true to replace them.");
		}
		// Batch validation (fail-fast before any job state is written).
		let batch: number | undefined;
		if (body.batch !== undefined) {
			const n = Number(body.batch);
			if (!Number.isFinite(n) || n < 1 || n > 64 || !Number.isInteger(n)) {
				throw error(400, "batch must be an integer between 1 and 64");
			}
			batch = n;
		}
		try {
			await startDocsEmbedRebuild({ batch });
			return json({ ok: true, started: true });
		} catch (err) {
			if (err instanceof DocsEmbedJobInProgressError) throw error(409, err.message);
			if (err instanceof DocsEmbedNoKeyError) throw error(422, err.message);
			throw error(500, (err as Error).message);
		}
	}

	throw error(400, 'mode must be "download" | "rebuild" | "skip"');
}
