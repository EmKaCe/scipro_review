/**
 * @file Helpers for resolving state from the `review/[id]` route's `[id]` param.
 *
 * The `review/[id]` and `review/[id]/evaluation` routes are the STUDENT review
 * surface, and their `[id]` param is keyed by ASSIGNMENT id (e.g.
 * `soil_contamination`), NOT a student id (e.g. `2026SS_00`).
 *
 * B1 wiring defect: the pages blindly fed `page.params.id` into
 * `reviewStore.setAssignment(id)`, which calls `getCriteriaForAssignment(id)`.
 * That lookup resolves against the assignment registry by assignment key, so a
 * student id passed in the URL slot makes criteria loading fail ("Assignment
 * not found: 2026SS_00") and leaves the evaluation page in a misleading
 * "No evaluation to preview" empty state (with an error toast) — the symptom
 * reported in teacher mode. See B9/B1 in the product-sound release plan.
 *
 * These pages must only ever call `setAssignment(id)` when `id` is a VALID,
 * ENABLED assignment id; otherwise they stay in their honest empty state
 * instead of degrading to a bogus error + misleading message.
 */
export interface ReviewRouteAssignmentLike {
	id: string;
}

/**
 * Return the assignment id derived from the `[id]` route param for loading, or
 * `null` when the param is NOT a valid assignment id.
 *
 * @param paramId  the raw `page.params.id` value
 * @param assignments  the enabled-assignment registry from the review store
 * @returns `paramId` when it matches an enabled assignment, else `null`
 *   (meaning: do NOT feed `paramId` to `reviewStore.setAssignment`).
 */
export function resolveReviewAssignmentId(
	paramId: string | undefined,
	assignments: ReadonlyArray<ReviewRouteAssignmentLike>,
): string | null {
	if (!paramId) return null;
	return assignments.some((a) => a.id === paramId) ? paramId : null;
}

/**
 * Whether the current route `[id]` is NOT a valid assignment id once the
 * registry has loaded — i.e. the param carried a non-assignment value (such as
 * a student id), which is the root cause of the B1 empty-state/error wiring
 * defect. Used to render an honest message instead of the generic
 * "generate an evaluation" hint.
 */
export function isUnknownReviewAssignmentId(
	paramId: string | undefined,
	assignments: ReadonlyArray<ReviewRouteAssignmentLike>,
	registryLoaded: boolean,
): boolean {
	return !!paramId && registryLoaded && resolveReviewAssignmentId(paramId, assignments) === null;
}
