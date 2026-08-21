/**
 * @file POST /api/submissions/pre-evaluate/reset — clear pre-evaluation
 * results so the teacher can re-run the batch without hacking metadata.
 *
 * Body: { assignmentId: string, submissionIds?: string[] }
 *   - submissionIds given: reset only those submissions (unknown ids are
 *     skipped; the response count reflects what was actually reset)
 *   - otherwise: reset every submission in the assignment that carries
 *     pre-evaluation state — status "pre-evaluated" or a stored preEval
 *     envelope (graded rows are included, but their grading data is
 *     untouched; only status + envelope are reset)
 *
 * Reset = lifecycle step back to "executed" (the pre-evaluate route's
 * target set) + drop the preEval envelope from results.json. The
 * pre-evaluated/graded -> executed hops are not in STATUS_TRANSITIONS, so
 * they are force-enabled, mirroring the sibling route's flips.
 *
 * The route refuses while a pre-evaluation run is in flight (409) — a
 * reset mid-run would race the run's writers, which re-persist envelopes
 * the reset just cleared. The dashboard disables the button, but a second
 * tab could still race in here.
 */

import { error, json } from "@sveltejs/kit";
import type { RequestEvent } from "@sveltejs/kit";

import { assignmentExists } from "$lib/server/assignments";
import { listSubmissions, updateStatus } from "$lib/server/metadata";
import { withPersistLock } from "$lib/server/persist-lock";
import { getPreEvalRun } from "$lib/server/pre-eval-progress";
import { readResults, writeResults } from "$lib/server/results-store";

export const prerender = false;

export async function POST(event: RequestEvent): Promise<Response> {
	let body: unknown;
	try {
		body = await event.request.json();
	} catch {
		throw error(400, "Invalid JSON body");
	}
	if (body === null || typeof body !== "object" || Array.isArray(body)) {
		throw error(400, "Expected a JSON object body");
	}
	const { assignmentId, submissionIds } = body as {
		assignmentId?: unknown;
		submissionIds?: unknown;
	};
	if (typeof assignmentId !== "string" || assignmentId.length === 0) {
		throw error(400, "assignmentId is required");
	}
	if (
		submissionIds !== undefined &&
		(!Array.isArray(submissionIds) ||
			submissionIds.some((id) => typeof id !== "string" || id.length === 0))
	) {
		throw error(400, "submissionIds must be an array of strings");
	}

	if (!(await assignmentExists(assignmentId))) {
		throw error(404, `Assignment "${assignmentId}" not found`);
	}

	// One global pre-evaluation run at a time (same model as the sibling
	// route): never reset mid-run — the run's writers would re-persist
	// envelopes the reset just cleared.
	if (getPreEvalRun().running) {
		throw error(409, "A pre-evaluation run is in progress");
	}

	const records = await listSubmissions(assignmentId);
	const byId = new Map(records.map((r) => [r.id, r]));

	let targets: string[];
	if (submissionIds !== undefined) {
		targets = submissionIds.filter((id) => byId.has(id));
	} else {
		// Whole assignment: every row that carries pre-evaluation state.
		const results = await readResults(assignmentId);
		targets = records
			.filter((r) => r.status === "pre-evaluated" || results[r.id]?.preEval !== undefined)
			.map((r) => r.id);
	}

	if (targets.length === 0) {
		return json({ assignmentId, reset: 0 });
	}

	// results.json + metadata.json are single-file stores — the shared
	// persist lock serializes this section against sibling batch routes
	// (the reset is pure local I/O, so the whole thing sits inside).
	await withPersistLock(async () => {
		const results = await readResults(assignmentId);
		let changed = false;
		for (const id of targets) {
			const entry = results[id];
			if (entry?.preEval !== undefined) {
				delete entry.preEval;
				changed = true;
			}
			await updateStatus(assignmentId, id, "executed", { force: true });
		}
		if (changed) {
			await writeResults(assignmentId, results);
		}
	});

	return json({ assignmentId, reset: targets.length });
}
