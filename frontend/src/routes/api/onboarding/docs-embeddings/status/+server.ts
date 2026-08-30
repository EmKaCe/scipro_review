/**
 * @file GET /api/onboarding/docs-embeddings/status — job progress poll.
 *
 * Returns `{ job: null | DocsEmbedJobState }` (design doc §4.1). `null` means
 * no job has ever run (or was cleared). A state file without a live process
 * (`interrupted`) is surfaced by the runner module (crash recovery row §5-2).
 * Cancel is sent on the same POST route family? No — cancel uses DELETE here
 * (idempotent; safe to send twice from the UI).
 */

import { json } from "@sveltejs/kit";
import type { RequestEvent } from "@sveltejs/kit";

import { cancelDocsEmbedJob, getDocsEmbedJobStatus } from "$lib/server/docs-embed-rebuild";

export async function GET(_event: RequestEvent): Promise<Response> {
	const job = await getDocsEmbedJobStatus();
	return json({ job });
}

/** Cancel a running embed job (idempotent; 409 when nothing runs). */
export async function DELETE(_event: RequestEvent): Promise<Response> {
	const ok = cancelDocsEmbedJob();
	if (!ok) {
		return json({ ok: false, error: "No running embed job." }, { status: 409 });
	}
	return json({ ok: true, cancelling: true });
}
