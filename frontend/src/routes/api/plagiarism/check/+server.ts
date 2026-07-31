/**
 * @file POST /api/plagiarism/check — run the plagiarism comparison for an
 *       assignment and cache the result.
 *
 * Body (JSON):
 *   assignmentId? — target assignment (default: first enabled assignment)
 *   semantic?     — true to also run the KI Connect semantic pass on the
 *                   flagged pairs (skipped gracefully when KI_CONNECT_API_KEY
 *                   is unset or the LLM fails)
 *   ngramSize?    — token n-gram size for the structural pass, 2–5
 *                   (default 3)
 *
 * Pipeline: load all submission notebooks of the assignment, run the pure
 * structural comparison (Phase 3d.1), keep the flagged pairs (Phase 3d
 * thresholds), optionally enrich them with semantic scores (Phase 3d.2),
 * then write the result to data/plagiarism/<assignment>.json and return it.
 */

import { error, json } from "@sveltejs/kit";
import type { RequestEvent } from "@sveltejs/kit";

import { assignmentExists, resolveAssignmentId } from "$lib/server/assignments";
import { writePlagiarismResult, type PlagiarismResult } from "$lib/server/plagiarism/cache";
import {
	isSemanticComparisonAvailable,
	mergeSemanticResults,
	runSemanticPass,
} from "$lib/server/plagiarism/semantic";
import {
	compareAll,
	flagPairs,
	loadAssignmentNotebooks,
	MAX_NGRAM_SIZE,
	MIN_NGRAM_SIZE,
	type PlagiarismPair,
} from "$lib/server/plagiarism/structural";

export async function POST(event: RequestEvent): Promise<Response> {
	let body: Record<string, unknown>;
	try {
		body = (await event.request.json()) as Record<string, unknown>;
	} catch {
		throw error(400, "Expected a JSON body");
	}
	if (body === null || typeof body !== "object" || Array.isArray(body)) {
		throw error(400, "Expected a JSON object body");
	}

	const assignmentId = await resolveAssignmentId(
		typeof body.assignmentId === "string" ? body.assignmentId : null,
	);
	if (!assignmentId) {
		throw error(404, "No assignments configured");
	}
	if (!(await assignmentExists(assignmentId))) {
		throw error(404, `Assignment "${assignmentId}" not found`);
	}

	let ngramSize: number | undefined;
	if (body.ngramSize !== undefined) {
		if (
			typeof body.ngramSize !== "number" ||
			!Number.isInteger(body.ngramSize) ||
			body.ngramSize < MIN_NGRAM_SIZE ||
			body.ngramSize > MAX_NGRAM_SIZE
		) {
			throw error(
				400,
				`ngramSize must be an integer between ${MIN_NGRAM_SIZE} and ${MAX_NGRAM_SIZE}`,
			);
		}
		ngramSize = body.ngramSize;
	}

	const notebooks = await loadAssignmentNotebooks(assignmentId);
	const allPairs = compareAll(notebooks, { ngramSize });
	const flagged = flagPairs(allPairs);

	let pairs: PlagiarismPair[] = flagged;
	const wantSemantic = body.semantic === true;
	const semanticChecked = wantSemantic && isSemanticComparisonAvailable();
	if (wantSemantic && flagged.length > 0 && semanticChecked) {
		const notebooksById = new Map(notebooks.map((n) => [n.studentId, n]));
		const semanticResults = await runSemanticPass(flagged, notebooksById);
		pairs = mergeSemanticResults(flagged, semanticResults);
	}

	const result: PlagiarismResult = {
		status: "done",
		assignmentId,
		generatedAt: new Date().toISOString(),
		pairs,
		totalPairs: allPairs.length,
		comparedSubmissions: notebooks.map((n) => n.studentId).sort(),
		semanticChecked,
	};

	await writePlagiarismResult(assignmentId, result);
	return json(result);
}
