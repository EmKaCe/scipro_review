/**
 * @file GET /api/executor/logs — proxy to the executor's pipeline log ring
 * buffer.
 *
 * The browser cannot reach the executor directly (it is server-side, like
 * EXECUTOR_URL), so the dashboard polls this route while a batch runs and
 * renders the captured pipeline lines (preprocessing, execution, autofix,
 * LLM calls).
 */

import { json } from "@sveltejs/kit";
import type { RequestEvent } from "@sveltejs/kit";

import { getExecutorClient } from "$lib/server/executor-client";

export async function GET(event: RequestEvent): Promise<Response> {
	const raw = event.url.searchParams.get("limit") ?? "200";
	const limit = Number.parseInt(raw, 10);
	const clamped = Number.isFinite(limit) ? Math.max(1, Math.min(limit, 1000)) : 200;
	const logs = await getExecutorClient().fetchLogs(clamped);
	return json(logs);
}
