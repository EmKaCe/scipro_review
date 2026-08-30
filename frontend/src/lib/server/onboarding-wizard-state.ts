/**
 * @file Persisted wizard dismiss flag — <DATA_DIR>/wizard_state.json.
 *
 * The teacher entrypoint redirect keeps sending users to /onboarding until
 * the wizard is dismissed once; this file is that single dismiss record
 * ({ dismissed: true, dismissedAt: <iso> }). Written atomically (temp file +
 * rename, same staging pattern as results-store/settings) so concurrent
 * requests never observe a torn file.
 *
 * Environment:
 *   DATA_DIR — data root (default: ./data, i.e. /app/data in Docker)
 *
 * This module runs only on the SvelteKit server (`$lib/server/`).
 */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { getDataDir } from "$lib/server/metadata";

const WIZARD_STATE_FILENAME = "wizard_state.json";

/** Persisted wizard state shape. */
export interface WizardState {
	dismissed: boolean;
}

/** Path of the wizard state file inside DATA_DIR. */
function statePath(): string {
	return path.join(getDataDir(), WIZARD_STATE_FILENAME);
}

/**
 * Read the persisted dismiss flag. Returns null when the file is missing
 * (ENOENT — never dismissed), unreadable, or holds corrupt / non-object JSON
 * that lacks the `dismissed` boolean. Never throws to the caller.
 */
export async function readWizardState(): Promise<WizardState | null> {
	let raw: string;
	try {
		raw = await readFile(statePath(), "utf-8");
	} catch {
		// ENOENT or unreadable — both mean "no dismiss on record".
		return null;
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (
			parsed === null ||
			typeof parsed !== "object" ||
			Array.isArray(parsed) ||
			typeof (parsed as WizardState).dismissed !== "boolean"
		) {
			return null;
		}
		return { dismissed: (parsed as WizardState).dismissed };
	} catch {
		// Corrupt JSON — treat as not dismissed rather than crashing onboarding.
		return null;
	}
}

/** Atomically persist the dismiss flag (staging temp file + rename). */
export async function writeDismissed(): Promise<void> {
	const filePath = statePath();
	await mkdir(path.dirname(filePath), { recursive: true });
	const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
	await writeFile(
		tmpPath,
		JSON.stringify({ dismissed: true, dismissedAt: new Date().toISOString() }, null, 2),
		"utf-8",
	);
	try {
		await rename(tmpPath, filePath);
	} catch (err) {
		// The rename failed — don't leave the staging temp file behind.
		await rm(tmpPath, { force: true }).catch(() => {});
		throw err;
	}
}
