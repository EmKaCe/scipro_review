/**
 * @file POST /api/assignments/[id]/criteria/draft — LLM-drafted per-assignment
 * criteria (rubric) config for the visual criteria editor.
 *
 * Runs the TURN-BASED criteria draft pipeline (criteria-draft/pipeline.ts,
 * mirroring the pre-evaluation pipeline shape):
 *   Phase 0 — deterministic grounding (assignment metadata, own rubric when
 *     present, assignment PDF, key notebook summary, input-data files, the
 *     FIXED 5-dimension contract, shared criteria summaries)
 *   Phase 1 — one LLM call proposing the assignment-specific category skeleton
 *   Phase 2 — one LLM call PER category (sequential), each emitting a
 *     dimension-attributed category map
 *   Phase 3 — deterministic merge
 *   Phase 4 — one LLM consistency call (coverage gaps / unattributed items /
 *     vague wording) + deterministic one-round revision application
 *   Phase 5 — criteria validation gate (async, dimension-aware) +
 *     general-collision gate; on failure the validation message is fed back
 *     to the model and the WHOLE draft is retried (max 3); final failure →
 *     400 with the validation message.
 *
 * This endpoint NEVER writes: the teacher reviews the draft in the criteria
 * editor and saves it through the existing PUT /api/assignments/[id]/criteria
 * (which runs the same validation gate). The chicken-and-egg is fixed: the
 * draft no longer requires an existing own rubric — it is grounded on PDF +
 * key summary + input data + shared criteria, and includes the own-rubric
 * summary as additional grounding when one exists.
 *
 * Responses:
 *   POST 200 { draft: { categories }, notes: [...] }  — gate-validated
 *   POST 400 — the draft failed the validation gate after all retries (the
 *              validation message), or a category key collides with general.yaml
 *   POST 404 — unknown assignment id
 *   POST 500 — LLM call failure / corrupt shared criteria on disk
 *
 * Environment: DATA_DIR (default ./data). Server-only ($lib/server deps).
 */

import { error, json } from "@sveltejs/kit";
import type { RequestEvent } from "@sveltejs/kit";

import { getAssignmentById } from "$lib/server/assignments";
import { CriteriaValidationError } from "$lib/server/criteria";
import { draftCriteriaCategories } from "$lib/server/copilot/criteria-draft/pipeline";
import type { CriteriaFile } from "$lib/types/criteria";

/** POST /api/assignments/[id]/criteria/draft — turn-based draft pipeline. */
export async function POST(event: RequestEvent): Promise<Response> {
	const id = event.params.id ?? "";

	const assignment = await getAssignmentById(id);
	if (!assignment) {
		throw error(404, `Assignment "${id}" not found`);
	}

	try {
		const result = await draftCriteriaCategories(assignment);
		const draft = { categories: result.categories } as unknown as CriteriaFile;
		return json({ draft, notes: result.notes });
	} catch (err) {
		if (err instanceof CriteriaValidationError) {
			throw error(400, err.message);
		}
		throw error(500, (err as Error).message);
	}
}
