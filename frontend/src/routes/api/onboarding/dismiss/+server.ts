/**
 * @file GET/POST /api/onboarding/dismiss — read + persist the wizard's one-time dismiss flag.
 *
 * GET reads the persisted { dismissed: true, dismissedAt: <iso> } record
 * from <DATA_DIR>/wizard_state.json; a missing or unreadable record (never
 * dismissed) answers { dismissed: false }. The teacher entrypoint redirect
 * consults this flag every navigation, so dismissing once stops the
 * redirect until the setup conditions change again.
 *
 * POST writes the flag (atomic temp-file + rename, see
 * $lib/server/onboarding-wizard-state).
 *
 * Responses:
 *   GET  200 { dismissed: boolean }  — current dismiss flag.
 *   POST 200 { ok: true }            — flag persisted.
 *   POST 500 { ok: false, error }    — the flag could not be written (e.g. a
 *                                     read-only DATA_DIR subtree); the UI copy
 *                                     for this case is "could not save —
 *                                     setup will re-open next visit".
 *   Other methods                    — 405 (only GET/POST are exported; the
 *                                     framework rejects the rest).
 */

import { json } from "@sveltejs/kit";

import { readWizardState, writeDismissed } from "$lib/server/onboarding-wizard-state";

/** GET /api/onboarding/dismiss — current dismiss flag (never throws). */
export async function GET(): Promise<Response> {
	const state = await readWizardState();
	return json({ dismissed: state?.dismissed === true });
}

export async function POST(): Promise<Response> {
	try {
		await writeDismissed();
		return json({ ok: true });
	} catch (err) {
		return json(
			{ ok: false, error: `could not save wizard dismissal: ${(err as Error).message}` },
			{ status: 500 },
		);
	}
}
