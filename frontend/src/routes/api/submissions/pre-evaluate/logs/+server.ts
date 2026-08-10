/**
 * @file GET /api/submissions/pre-evaluate/logs — pre-evaluation pipeline log
 * lines.
 *
 * Pre-evaluation runs inside this server process, so its per-row log entries
 * live in a server-side ring buffer (pre-eval-logs.ts) instead of the
 * executor's. The dashboard polls this route alongside /api/executor/logs
 * while a run is in flight and renders the entries in the same pipeline log
 * panel, tagged with source "pre-eval".
 */

import { json } from "@sveltejs/kit";
import type { RequestEvent } from "@sveltejs/kit";

import { getPreEvalLogs } from "$lib/server/pre-eval-logs";

export async function GET(event: RequestEvent): Promise<Response> {
	const raw = event.url.searchParams.get("limit") ?? "200";
	const limit = Number.parseInt(raw, 10);
	return json(getPreEvalLogs(limit));
}
