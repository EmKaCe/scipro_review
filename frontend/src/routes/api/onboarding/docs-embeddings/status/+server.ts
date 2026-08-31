/**
 * @file GET /api/onboarding/docs-embeddings/status — job progress poll.
 *
 * Returns `{ job: null | DocsEmbedJobState }` (design doc §4.1). `null` means
 * no job has ever run (or was cleared). A state file without a live process
 * (`interrupted`) is surfaced by the shared job-state module (crash recovery
 * row §5-2). Since 2.8.1 the SAME contract covers the prebuilt download
 * (kind "fetch", done/total = bytes) and the local embed rebuild (kind
 * "embed", done/total = chunks).
 *
 * Cancel uses DELETE here (idempotent; safe to send twice from the UI) and
 * cancels whichever kind is live.
 */

import { json } from "@sveltejs/kit";
import type { RequestEvent } from "@sveltejs/kit";

import { getDocsEmbedJobStatus } from "$lib/server/docs-embed-job-state";
import { cancelDocsIndexDownload } from "$lib/server/onboarding-docs-index";
import { cancelDocsEmbedJob } from "$lib/server/docs-embed-rebuild";

export async function GET(_event: RequestEvent): Promise<Response> {
	const job = await getDocsEmbedJobStatus();
	return json({ job });
}

/** Cancel a running download/rebuild job (idempotent; 409 when nothing runs). */
export async function DELETE(_event: RequestEvent): Promise<Response> {
	const ok = cancelDocsIndexDownload() || cancelDocsEmbedJob();
	if (!ok) {
		return json({ ok: false, error: "No running docs-index job." }, { status: 409 });
	}
	return json({ ok: true, cancelling: true });
}
