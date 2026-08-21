/**
 * @file GET /api/plagiarism/results — return the cached plagiarism
 *       comparison for an assignment.
 *       PATCH /api/plagiarism/results — set the review status of one pair.
 *
 * GET query params:
 *   assignmentId? — target assignment (default: first enabled assignment)
 *
 * 404 when no check has been run (or the cache was cleared) — the caller
 * should POST /api/plagiarism/check first.
 *
 * PATCH body (JSON):
 *   assignmentId? — target assignment (default: first enabled assignment)
 *   studentA, studentB — the pair (either order accepted)
 *   reviewStatus — "unreviewed" | "accepted" | "dismissed" | "ignored"
 *
 * Persists the status in the cache (P3-1: review is per-pair) and returns
 * the updated result. 404 when no cache or the pair does not exist.
 */

import { error, json } from "@sveltejs/kit";
import type { RequestEvent } from "@sveltejs/kit";

import { assignmentExists, resolveAssignmentId } from "$lib/server/assignments";
import { readPlagiarismResult, updatePairReviewStatus } from "$lib/server/plagiarism/cache";
import type { PairReviewStatus } from "$lib/server/plagiarism/structural";

const REVIEW_STATUSES: readonly PairReviewStatus[] = [
	"unreviewed",
	"accepted",
	"dismissed",
	"ignored",
];

export async function GET(event: RequestEvent): Promise<Response> {
	const explicit = event.url.searchParams.get("assignmentId");
	const assignmentId = await resolveAssignmentId(explicit);
	if (!assignmentId) {
		throw error(404, "No assignments configured");
	}
	if (!(await assignmentExists(assignmentId))) {
		throw error(404, `Assignment "${assignmentId}" not found`);
	}

	const result = await readPlagiarismResult(assignmentId);
	if (!result) {
		throw error(
			404,
			`No plagiarism results for "${assignmentId}" — run POST /api/plagiarism/check first`,
		);
	}
	return json(result);
}

export async function PATCH(event: RequestEvent): Promise<Response> {
	let body: Record<string, unknown>;
	try {
		body = (await event.request.json()) as Record<string, unknown>;
	} catch {
		throw error(400, "Expected a JSON body");
	}
	if (body === null || typeof body !== "object" || Array.isArray(body)) {
		throw error(400, "Expected a JSON object body");
	}

	const studentA = body.studentA;
	const studentB = body.studentB;
	if (typeof studentA !== "string" || studentA === "") {
		throw error(400, "studentA must be a non-empty string");
	}
	if (typeof studentB !== "string" || studentB === "") {
		throw error(400, "studentB must be a non-empty string");
	}
	const reviewStatus = body.reviewStatus;
	if (
		typeof reviewStatus !== "string" ||
		!REVIEW_STATUSES.includes(reviewStatus as PairReviewStatus)
	) {
		throw error(400, `reviewStatus must be one of: ${REVIEW_STATUSES.join(", ")}`);
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

	const updated = await updatePairReviewStatus(
		assignmentId,
		studentA,
		studentB,
		reviewStatus as PairReviewStatus,
	);
	if (!updated) {
		throw error(
			404,
			`Pair "${studentA}" ↔ "${studentB}" not found in plagiarism results for "${assignmentId}" — run POST /api/plagiarism/check first`,
		);
	}
	return json(updated);
}
