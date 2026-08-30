/**
 * @file POST /api/onboarding/dismiss — persist the wizard's one-time dismiss flag.
 *
 * Writes { dismissed: true, dismissedAt: <iso> } to <DATA_DIR>/wizard_state.json
 * (atomic temp-file + rename, see $lib/server/onboarding-wizard-state). The
 * teacher entrypoint redirect consults this flag, so a dismiss survives
 * restarts until the setup conditions change again.
 *
 * Responses:
 *   200 { ok: true }         — flag persisted.
 *   500 { ok: false, error } — the flag could not be written (e.g. a read-only
 *                              DATA_DIR subtree); the UI copy for this case is
 *                              "could not save — setup will re-open next visit".
 *   Other methods            — 405 (only POST is exported; the framework
 *                              rejects the rest).
 */

import { json } from "@sveltejs/kit";

import { writeDismissed } from "$lib/server/onboarding-wizard-state";

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