/**
 * @file One-click seed of the bundled reference assignment (2.8.0 wizard).
 *
 * `soil_contamination` ships TRACKED in data/assignments.yaml, so seeding is
 * verify-and-enable, NOT file staging — this module never writes criteria or
 * scoring content. It:
 *   1. Checks the registry has the reference assignment and that every file
 *      it references (all `criteria_files` entries + its scoring config)
 *      exists on disk. A missing file means a broken install — the seed
 *      reports it as missingFiles and writes NOTHING.
 *   2. Flips `enabled: true` through the shared assignments writer
 *      ($lib/server/assignments-writer), the same atomic rewrite path the
 *      teacher assignment editor uses. Re-running is idempotent: an
 *      already-enabled assignment returns alreadyEnabled: true (with the
 *      integrity check still performed first).
 *
 * Environment: DATA_DIR — data root (default: ./data, /app/data in Docker).
 * Server-only ($lib/server deps).
 */

import { access } from "node:fs/promises";
import path from "node:path";

import { getAssignmentById } from "$lib/server/assignments";
import { updateAssignment } from "$lib/server/assignments-writer";
import { getDataDir } from "$lib/server/metadata";

// ---------------------------------------------------------------------------
// Constants & types
// ---------------------------------------------------------------------------

/** The bundled reference assignment id (shipped tracked in assignments.yaml). */
export const REFERENCE_ASSIGNMENT_ID = "soil_contamination";

/** Result of a seed attempt — the route serializes it verbatim. */
export interface SeedResult {
	ok: boolean;
	assignmentId: string;
	/** Whether the assignment was ALREADY enabled before this call. */
	alreadyEnabled: boolean;
	/** Referenced files that do not exist on disk (broken install). */
	missingFiles: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a registry path (e.g. "data/criteria/general.yaml") inside DATA_DIR.
 *
 * Registry entries carry a leading `data/` prefix relative to the data root;
 * it is stripped before joining so the file resolves inside DATA_DIR itself —
 * same convention as getCriteriaPath in $lib/server/criteria.ts.
 */
function resolveDataPath(filePath: string): string {
	const normalized = filePath.replace(/^data[/\\]/, "");
	return path.join(getDataDir(), normalized);
}

/** Cheap existence check — true only when the path is readable. */
async function pathExists(p: string): Promise<boolean> {
	try {
		await access(p);
		return true;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

/**
 * Verify + enable the reference assignment.
 *
 * Returns ok:true (and a possibly-write of just the `enabled` flag) when the
 * assignment exists in the registry and every file it references exists on
 * disk; ok:false with the missing paths otherwise — the write is skipped so
 * a broken install is surfaced, never silently patched.
 */
export async function seedReferenceAssignment(): Promise<SeedResult> {
	const assignment = await getAssignmentById(REFERENCE_ASSIGNMENT_ID);

	// Registry missing the reference assignment → the tracking file itself is
	// the broken piece; nothing to enable.
	if (!assignment) {
		return {
			ok: false,
			assignmentId: REFERENCE_ASSIGNMENT_ID,
			alreadyEnabled: false,
			missingFiles: [getAssignmentsPathLabel()],
		};
	}

	// Integrity check: every referenced file must exist on disk.
	const missingFiles: string[] = [];
	for (const criteriaPath of assignment.criteria_files) {
		if (!(await pathExists(resolveDataPath(criteriaPath)))) {
			missingFiles.push(criteriaPath);
		}
	}
	const scoringPath = resolveScoringPath(assignment);
	if (!(await pathExists(scoringPath))) {
		missingFiles.push(scoringPathLabel(assignment));
	}
	if (missingFiles.length > 0) {
		return {
			ok: false,
			assignmentId: REFERENCE_ASSIGNMENT_ID,
			alreadyEnabled: assignment.enabled,
			missingFiles,
		};
	}

	// Enable via the existing writer path — idempotent (no write when enabled).
	if (!assignment.enabled) {
		await updateAssignment(REFERENCE_ASSIGNMENT_ID, { enabled: true });
	}
	return {
		ok: true,
		assignmentId: REFERENCE_ASSIGNMENT_ID,
		alreadyEnabled: assignment.enabled,
		missingFiles: [],
	};
}

/**
 * Resolve the scoring config on disk: the assignment's `scoring_file` when
 * set, else the default data/scoring/<id>.yaml (getScoringConfigPath).
 */
function resolveScoringPath(assignment: {
	readonly id: string;
	readonly scoring_file?: string;
}): string {
	if (assignment.scoring_file) {
		return resolveDataPath(assignment.scoring_file);
	}
	return path.join(getDataDir(), "scoring", `${assignment.id}.yaml`);
}

/**
 * Registry spelling of the scoring config the seed expects: the assignment's
 * `scoring_file` value, else the canonical data/scoring/<id>.yaml — used in
 * missingFiles so the wizard can point at what the registry references.
 */
function scoringPathLabel(assignment: {
	readonly id: string;
	readonly scoring_file?: string;
}): string {
	if (assignment.scoring_file) {
		return assignment.scoring_file;
	}
	return path.join("data", "scoring", `${assignment.id}.yaml`);
}

/** Human-readable label of the registry file for the assignment-missing case. */
function getAssignmentsPathLabel(): string {
	return path.join("data", "assignments.yaml");
}
