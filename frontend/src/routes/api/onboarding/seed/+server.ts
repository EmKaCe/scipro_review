/**
 * @file POST /api/onboarding/seed — one-click enable of the reference assignment.
 *
 * The bundled reference assignment (soil_contamination) ships TRACKED in
 * data/assignments.yaml, so seeding is verify-and-enable, NOT file staging:
 * this endpoint checks the registry has the assignment and that every
 * criteria file + its scoring config exists on disk, then flips
 * `enabled: true` through the standard assignments writer
 * ($lib/server/assignments-writer). A broken install (missing files) returns
 * 422 with the seed result and writes NOTHING. Re-running is idempotent —
 * an already-enabled assignment resolves 200 with alreadyEnabled: true.
 *
 * Responses:
 *   200 { ok: true, assignmentId, alreadyEnabled, missingFiles: [] }
 *       — verified and enabled (or already was).
 *   422 { ok: false, assignmentId, alreadyEnabled, missingFiles: [...] }
 *       — broken install: referenced files are missing on disk.
 *   500 { ok: false, error } — unexpected failure (registry read/write).
 */

import { json } from "@sveltejs/kit";

import { seedReferenceAssignment } from "$lib/server/onboarding-seed";

/** POST /api/onboarding/seed — verify + enable the reference assignment. */
export async function POST(): Promise<Response> {
	try {
		const result = await seedReferenceAssignment();
		if (!result.ok) {
			return json(result, { status: 422 });
		}
		return json(result, { status: 200 });
	} catch (err) {
		return json(
			{ ok: false, error: `seed failed: ${(err as Error).message}` },
			{ status: 500 },
		);
	}
}