/**
 * @file GET /api/executor/health — probe the notebook-execution backend.
 *
 * The executor is a separate FastAPI process whose reachability can't be
 * guessed from settings — the 2.8.0 wizard needs a live probe before the
 * first pipeline. This route is a thin passthrough to
 * ExecutorClient.health() (executor-client.ts), the same health check the
 * dashboard already trusts.
 *
 * An unreachable executor is a probe RESULT, not a server error: transport
 * failures (connection refused, timeout, non-2xx, invalid JSON) resolve to a
 * 200 with { ok: false, reachable: false, error } so the wizard renders
 * either state from the same response shape and status code.
 *
 * Responses:
 *   200 { status, version, data_dir, ki_connect_available }
 *       — executor reachable (the raw ExecutorHealth payload).
 *   200 { ok: false, reachable: false, error } — executor unreachable.
 */

import { json } from "@sveltejs/kit";

import { getExecutorClient } from "$lib/server/executor-client";

/** GET /api/executor/health — probe the executor process. */
export async function GET(): Promise<Response> {
	try {
		const health = await getExecutorClient().health();
		return json(health);
	} catch (err) {
		return json(
			{
				ok: false,
				reachable: false,
				error: err instanceof Error ? err.message : String(err),
			},
			{ status: 200 },
		);
	}
}