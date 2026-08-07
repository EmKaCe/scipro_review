/**
 * @file GET /api/submissions/process/status — live batch progress.
 *
 * Reads the progress record that POST /api/submissions/process writes while
 * looping over targets. The dashboard polls this every 2s during a batch to
 * show the current notebook, per-notebook + total elapsed time, settled
 * count, and automatic auto-fix tallies.
 */

import { json } from "@sveltejs/kit";
import type { RequestEvent } from "@sveltejs/kit";

import { getProcessRun } from "$lib/server/process-progress";

export async function GET(_event: RequestEvent): Promise<Response> {
	return json(getProcessRun());
}
