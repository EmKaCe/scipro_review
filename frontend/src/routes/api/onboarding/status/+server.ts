/**
 * @file GET /api/onboarding/status — read-only first-run setup checklist status.
 *
 * Returns the current state of the five onboarding items as booleans (or null
 * when a check is undeterminable). This endpoint NEVER creates or writes
 * anything — it only reports what already exists. The guided "wizard" flow is
 * deferred; this surface is strictly a status read.
 *
 * Response shape:
 *   { items: [{ id, done: boolean | null, detail?: string }] }
 *
 * Feeds the /onboarding checklist page (T6).
 */

import { json } from "@sveltejs/kit";

import { getOnboardingStatus } from "$lib/server/onboarding-status";

export async function GET(): Promise<Response> {
	const status = await getOnboardingStatus();
	return json(status);
}
