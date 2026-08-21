/**
 * @file GET /api/submissions/pre-evaluate/status — live batch pre-evaluation
 * progress.
 *
 * Reads the progress record that POST /api/submissions/pre-evaluate writes
 * while looping over targets. The dashboard polls this every 2s during a run
 * to show the done/total count and keep the Pre-evaluate All button disabled.
 * Final tallies are retained after running flips to false (mirroring the
 * batch-process status endpoint).
 */

import { json } from "@sveltejs/kit";
import type { RequestEvent } from "@sveltejs/kit";

import { getPreEvalRun } from "$lib/server/pre-eval-progress";

export async function GET(_event: RequestEvent): Promise<Response> {
	return json(getPreEvalRun());
}
