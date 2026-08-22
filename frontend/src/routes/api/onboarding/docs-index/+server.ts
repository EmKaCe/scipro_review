/**
 * @file POST /api/onboarding/docs-index — start the public docs-index download.
 *
 * Runs scripts/fetch-docs-index.mjs in --public mode (plain HTTPS download of
 * the public release assets — no API key, no gh CLI) with --out pointing at
 * <DATA_DIR>/docs-index (or $DOCS_INDEX_DIR). The script stages into
 * .fetch-staging/ and renames into place only after the SHA-256 manifest
 * check, so a failed download never leaves a torn index.
 *
 * This endpoint NEVER builds the index (build-docs-index.mjs is off-limits)
 * and never requires or exposes an API key.
 *
 * Responses:
 *   200 { ok: true, alreadyPresent: boolean, output: string }
 *       — index in place now (alreadyPresent: false) or already was (true).
 *   409 { ok: false, error } — another download is currently running.
 *   500 { ok: false, error } — the fetch script failed (stderr tail).
 */

import { json } from "@sveltejs/kit";

import {
	DocsIndexDownloadFailedError,
	DocsIndexDownloadInProgressError,
	downloadDocsIndex,
} from "$lib/server/onboarding-docs-index";

export async function POST(): Promise<Response> {
	try {
		const result = await downloadDocsIndex();
		return json(result);
	} catch (err) {
		if (err instanceof DocsIndexDownloadInProgressError) {
			return json({ ok: false, error: err.message }, { status: 409 });
		}
		if (err instanceof DocsIndexDownloadFailedError) {
			return json({ ok: false, error: err.message }, { status: 500 });
		}
		return json(
			{ ok: false, error: `docs-index download failed: ${(err as Error).message}` },
			{ status: 500 },
		);
	}
}
