/**
 * @file POST /api/assignments/[id]/criteria — validated criteria YAML upload.
 *
 * Accepts a multipart `file` field holding one v2 criteria YAML document,
 * validates it (schema + duplicate-key + collision with data/criteria/general.yaml),
 * writes it atomically to <DATA_DIR>/criteria/<basename>, and appends
 * "data/criteria/<basename>" to the assignment's `criteria_files` via the
 * shared writer.
 *
 * Responses:
 *   201 { fileName: "data/criteria/<basename>", criteria_files: [...] }
 *   400 — non-.yaml file, unsafe basename, schema violation, duplicate
 *         category key, or collision with general.yaml
 *   404 — unknown assignment id
 *   500 — unexpected write failure
 *
 * Environment: DATA_DIR (default ./data). Server-only ($lib/server deps).
 */

import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { error, json } from "@sveltejs/kit";
import type { RequestEvent } from "@sveltejs/kit";

import { getAssignmentById } from "$lib/server/assignments";
import {
	AssignmentWriteError,
	toAssignmentSummary,
	updateAssignment,
} from "$lib/server/assignments-writer";
import {
	CriteriaValidationError,
	loadCriteriaFile,
	validateCriteriaYaml,
} from "$lib/server/criteria";
import { getDataDir } from "$lib/server/metadata";

/** Safe criteria basenames: letters, digits, underscores, hyphens, .yaml. */
const SAFE_BASENAME = /^[a-zA-Z0-9_-]+\.yaml$/;

/** POST /api/assignments/[id]/criteria — upload one criteria YAML file. */
export async function POST(event: RequestEvent): Promise<Response> {
	const id = event.params.id ?? "";

	let form: FormData;
	try {
		form = await event.request.formData();
	} catch {
		throw error(400, "Expected a multipart/form-data body");
	}

	const file = form.get("file");
	if (!(file instanceof File)) {
		throw error(400, "Expected a multipart file field named 'file'");
	}
	if (!file.name.toLowerCase().endsWith(".yaml")) {
		throw error(400, "Expected a .yaml criteria file");
	}

	// Sanitize the basename — reject traversal or unsafe characters.
	const basename = path.basename(file.name);
	if (!SAFE_BASENAME.test(basename)) {
		throw error(400, `Invalid criteria file name "${file.name}"`);
	}
	const relativePath = `data/criteria/${basename}`;

	const raw = await file.text();

	// Schema validation (throws CriteriaValidationError with a 400 message).
	let validated: { fileName: string; categories: Record<string, unknown> };
	try {
		validated = validateCriteriaYaml(raw, basename);
	} catch (err) {
		if (err instanceof CriteriaValidationError) {
			throw error(400, err.message);
		}
		throw err;
	}

	// Collision check against data/criteria/general.yaml (skipped when the
	// file is missing on disk — the upload itself is still valid).
	await assertNoGeneralCollision(validated.categories);

	// The assignment must exist and be writable (writer maps unknown ids to
	// 404). Checked before persisting anything so a bad id leaves no file.
	const existing = await getAssignmentById(id);
	if (!existing) {
		throw error(404, `Assignment "${id}" not found`);
	}

	// Atomic write: temp file in the same directory + rename.
	try {
		const criteriaDir = path.join(getDataDir(), "criteria");
		await mkdir(criteriaDir, { recursive: true });
		const tmpPath = path.join(criteriaDir, `.${basename}.tmp-${process.pid}-${Date.now()}`);
		await writeFile(tmpPath, raw, "utf-8");
		await rename(tmpPath, path.join(criteriaDir, basename));
	} catch (err) {
		throw error(500, `Failed to write criteria file: ${(err as Error).message}`);
	}

	// Append the file to the assignment's criteria_files via the shared writer.
	let updated;
	try {
		updated = await updateAssignment(id, {
			criteria_files: [...existing.criteria_files, relativePath],
		});
	} catch (err) {
		if (err instanceof AssignmentWriteError) {
			throw error(err.status, err.message);
		}
		throw error(500, (err as Error).message);
	}

	const summary = toAssignmentSummary(updated);
	return json(
		{ fileName: relativePath, criteria_files: [...summary.criteria_files] },
		{ status: 201 },
	);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Reject uploads whose category keys collide with data/criteria/general.yaml.
 *
 * general.yaml is loaded via the existing loader; when the file is missing
 * on disk the check is skipped (the upload remains valid). Any uploaded key
 * that general.yaml already defines → 400.
 */
async function assertNoGeneralCollision(categories: Record<string, unknown>): Promise<void> {
	let general;
	try {
		general = await loadCriteriaFile("data/criteria/general.yaml");
	} catch (err) {
		// Corrupt general.yaml is a server misconfig, not the upload's fault —
		// surface it rather than silently accepting a colliding upload.
		throw error(500, `Failed to load data/criteria/general.yaml: ${(err as Error).message}`);
	}
	if (!general) return; // no general.yaml on disk — skip the collision check

	const generalKeys = new Set(Object.keys(general.categories).map((k) => k.trim().toLowerCase()));
	for (const key of Object.keys(categories)) {
		if (generalKeys.has(key.trim().toLowerCase())) {
			throw error(400, `category key ${key} already exists in general.yaml`);
		}
	}
}
