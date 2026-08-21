/**
 * @file GET /api/pipeline/status — unified pipeline progress.
 *
 * Aggregates the batch-process and batch pre-evaluation progress records
 * into one response so a reloaded dashboard can restore BOTH run trackers
 * (startedAt, totals) from a single call instead of two. Pure aggregator —
 * no new logic; the per-run modules keep owning their records and the
 * per-run status endpoints stay the live polling sources.
 */

import { json } from "@sveltejs/kit";

import { getProcessRun } from "$lib/server/process-progress";
import { getPreEvalRun } from "$lib/server/pre-eval-progress";

export async function GET(): Promise<Response> {
	const process = getProcessRun();
	const preEval = getPreEvalRun();
	return json({
		process,
		preEval,
		anyRunning: process.running || preEval.running,
	});
}
