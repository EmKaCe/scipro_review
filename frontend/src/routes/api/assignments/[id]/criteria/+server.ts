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
import * as yaml from "js-yaml";

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
import { parseMultipartFormData } from "$lib/server/form-data";
import type { CriteriaFile } from "$lib/types/criteria";

/** Safe criteria basenames: letters, digits, underscores, hyphens, .yaml. */
const SAFE_BASENAME = /^[a-zA-Z0-9_-]+\.yaml$/;

/** The shared rubric file — never editable through the per-assignment editor. */
const GENERAL_CRITERIA_PATH = "data/criteria/general.yaml";

/**
 * Deep structural equality for two criteria category maps.
 *
 * Used by the PUT no-op guard: the client round-trips the document through
 * JSON/YAML, so key order and undefined-vs-absent booleans can differ while
 * the document is semantically the same. Compare values only, ignoring key
 * order in objects.
 */
function deepEqualCategories(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== typeof b || a === null || b === null) return false;
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
		return a.every((item, i) => deepEqualCategories(item, b[i]));
	}
	if (typeof a === "object") {
		const aObj = a as Record<string, unknown>;
		const bObj = b as Record<string, unknown>;
		const aKeys = Object.keys(aObj);
		const bKeys = Object.keys(bObj);
		if (aKeys.length !== bKeys.length) return false;
		return aKeys.every((key) => deepEqualCategories(aObj[key], bObj[key]));
	}
	return a === b;
}

// ---------------------------------------------------------------------------
// GET / PUT — visual criteria editor
// ---------------------------------------------------------------------------

/**
 * The assignment's own criteria file: the first entry in `criteria_files`
 * that is NOT the shared general.yaml. general.yaml applies automatically to
 * every assignment and is never returned here as editable.
 */
function ownCriteriaFile(criteriaFiles: readonly string[]): string | null {
	return criteriaFiles.find((f) => f !== GENERAL_CRITERIA_PATH) ?? null;
}

/** GET /api/assignments/[id]/criteria — load the assignment's own criteria. */
export async function GET(event: RequestEvent): Promise<Response> {
	const id = event.params.id ?? "";

	const assignment = await getAssignmentById(id);
	if (!assignment) {
		throw error(404, `Assignment "${id}" not found`);
	}

	const fileName = ownCriteriaFile(assignment.criteria_files);
	if (!fileName) {
		return json({ fileName: null, content: null });
	}

	// Missing file on disk → treat as none (the editor starts empty).
	const content = await loadCriteriaFile(fileName);
	if (!content) {
		return json({ fileName: null, content: null });
	}
	return json({ fileName, content });
}

/** PUT /api/assignments/[id]/criteria — replace the assignment's own criteria. */
export async function PUT(event: RequestEvent): Promise<Response> {
	const id = event.params.id ?? "";

	// The assignment must exist and be writable (checked before persisting
	// anything so a bad id leaves no file or registry change).
	const existing = await getAssignmentById(id);
	if (!existing) {
		throw error(404, `Assignment "${id}" not found`);
	}

	let body: { categories?: Record<string, unknown> };
	try {
		body = (await event.request.json()) as { categories?: Record<string, unknown> };
	} catch {
		throw error(400, "Expected a JSON body");
	}
	if (
		!body ||
		typeof body !== "object" ||
		!body.categories ||
		typeof body.categories !== "object"
	) {
		throw error(400, "Expected a JSON body with a 'categories' map");
	}

	// Determine the target file: existing own file, or a new
	// data/criteria/<assignmentId>.yaml when the assignment has none.
	let fileName = ownCriteriaFile(existing.criteria_files);
	let isNewFile = false;
	if (!fileName) {
		const basename = path.basename(`${id}.yaml`);
		if (!SAFE_BASENAME.test(basename)) {
			throw error(400, `Invalid criteria file name "${basename}"`);
		}
		fileName = `data/criteria/${basename}`;
		isNewFile = true;
	}

	// Serialize + validate (throws CriteriaValidationError with a 400 message).
	const yamlText = yaml.dump({ categories: body.categories });
	let validated: { fileName: string; categories: Record<string, unknown> };
	try {
		validated = await validateCriteriaYaml(yamlText, path.basename(fileName));
	} catch (err) {
		if (err instanceof CriteriaValidationError) {
			throw error(400, err.message);
		}
		throw err;
	}

	// Collision check against data/criteria/general.yaml (skipped when the
	// file is missing on disk — the document itself is still valid).
	await assertNoGeneralCollision(validated.categories);

	// No-op guard: when the saved document is semantically identical to what
	// is already on disk, skip the write entirely. The YAML dump reformats
	// (indentation, folding), so a no-op save must NOT churn the tracked
	// git file — otherwise every "Save" click produces a fake diff.
	if (!isNewFile) {
		const existingOnDisk = await loadCriteriaFile(fileName);
		if (
			existingOnDisk &&
			deepEqualCategories(existingOnDisk.categories, validated.categories)
		) {
			return json({
				fileName,
				content: { categories: validated.categories } as unknown as CriteriaFile,
			});
		}
	}

	// Atomic write: temp file in the same directory + rename.
	try {
		const criteriaDir = path.join(getDataDir(), "criteria");
		await mkdir(criteriaDir, { recursive: true });
		const basename = path.basename(fileName);
		const tmpPath = path.join(criteriaDir, `.${basename}.tmp-${process.pid}-${Date.now()}`);
		await writeFile(tmpPath, yamlText, "utf-8");
		await rename(tmpPath, path.join(criteriaDir, basename));
	} catch (err) {
		throw error(500, `Failed to write criteria file: ${(err as Error).message}`);
	}

	// A brand-new file must be registered in the assignment's criteria_files
	// (dedupe in case the entry somehow already exists).
	if (isNewFile) {
		try {
			await updateAssignment(id, {
				criteria_files: existing.criteria_files.includes(fileName)
					? [...existing.criteria_files]
					: [...existing.criteria_files, fileName],
			});
		} catch (err) {
			if (err instanceof AssignmentWriteError) {
				throw error(err.status, err.message);
			}
			throw error(500, (err as Error).message);
		}
	}

	return json({
		fileName,
		content: { categories: validated.categories } as unknown as CriteriaFile,
	});
}

// ---------------------------------------------------------------------------
// POST — YAML upload (unchanged)
// ---------------------------------------------------------------------------

/** POST /api/assignments/[id]/criteria — upload one criteria YAML file. */
export async function POST(event: RequestEvent): Promise<Response> {
	const id = event.params.id ?? "";

	const form = await parseMultipartFormData(event);

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
		validated = await validateCriteriaYaml(raw, basename);
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
	// Re-uploading the same file must not duplicate the registry entry.
	let updated;
	try {
		updated = await updateAssignment(id, {
			criteria_files: existing.criteria_files.includes(relativePath)
				? [...existing.criteria_files]
				: [...existing.criteria_files, relativePath],
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
