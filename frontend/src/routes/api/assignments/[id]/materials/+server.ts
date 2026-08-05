/**
 * @file /api/assignments/[id]/materials — material status + multipart upload.
 *
 * GET  — report which materials exist for an assignment:
 *        { hasPdf, hasKey, hasInputData, files } by scanning
 *        <DATA_DIR>/materials/<id>/ (pdf files and key notebooks at the root,
 *        data files under input_data/).
 * POST — accept multipart uploads (pdf, key.ipynb, data files), classify each
 *        via file-service.classifyFile, persist via persistUpload, and return
 *        the updated material status plus per-file upload results.
 *
 * Environment: DATA_DIR (default ./data). Server-only ($lib/server deps).
 */

import { readdir, rm, unlink } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";

import { error, json } from "@sveltejs/kit";
import type { RequestEvent } from "@sveltejs/kit";

import { classifyFile, persistUpload } from "$lib/server/file-service";
import { assertSafeSegment, getDataDir } from "$lib/server/metadata";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One material file on disk, with its canonical classification. */
interface MaterialFileInfo {
	name: string;
	kind: "material-file" | "material-data";
	/** Path relative to DATA_DIR, e.g. "materials/soil/input_data/soil.csv". */
	relativePath: string;
}

/** Material status report for one assignment. */
interface MaterialsStatus {
	assignmentId: string;
	/** True when any *.pdf sits in the materials root. */
	hasPdf: boolean;
	/** True when key.ipynb (or <name>_key.ipynb) sits in the materials root. */
	hasKey: boolean;
	/** True when input_data/ exists with at least one entry. */
	hasInputData: boolean;
	files: MaterialFileInfo[];
}

/** Per-file result returned by the upload endpoint. */
interface UploadResult {
	name: string;
	kind: "material-file" | "material-data";
	replaced: boolean;
	bytes: number;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/** Report the current material status for an assignment. */
export async function GET(event: RequestEvent): Promise<Response> {
	const assignmentId = validateAssignmentId(event.params.id);
	return json(await scanMaterials(assignmentId));
}

/**
 * Persist uploaded material files and return the updated status.
 *
 * Accepts any multipart file (pdf, key.ipynb, data files). Files matching the
 * student-submission naming pattern are rejected — this endpoint is for
 * assignment materials, not submissions. Non-file form fields are ignored.
 */
export async function POST(event: RequestEvent): Promise<Response> {
	const assignmentId = validateAssignmentId(event.params.id);

	let form: FormData;
	try {
		form = await event.request.formData();
	} catch {
		throw error(400, "Expected a multipart/form-data body");
	}

	const uploaded: UploadResult[] = [];
	for (const [, value] of form.entries()) {
		if (typeof value === "string") continue; // ignore non-file fields
		const file = value as File;

		const classified = classifyFile(file.name, assignmentId);
		if (classified.kind === "submission") {
			throw error(
				400,
				`"${classified.fileName}" looks like a student submission — upload it via /api/submissions/upload instead`,
			);
		}

		const result = await persistUpload(file.name, await file.arrayBuffer(), assignmentId);
		uploaded.push({
			name: result.file.fileName,
			// Narrowed to "material-file" | "material-data" by the guard above.
			kind: classified.kind,
			replaced: result.replaced,
			bytes: result.bytes,
		});
	}

	if (uploaded.length === 0) {
		throw error(400, "No files provided");
	}

	return json({ status: await scanMaterials(assignmentId), uploaded });
}

/**
 * Delete assignment materials.
 *
 *   DELETE /api/assignments/<id>/materials?name=<file>
 *       — remove one material file (searches the materials root and
 *         input_data/; the name must be a single path segment)
 *   DELETE /api/assignments/<id>/materials
 *       — remove the whole materials directory for the assignment
 *
 * Returns the updated material status.
 */
export async function DELETE(event: RequestEvent): Promise<Response> {
	const assignmentId = validateAssignmentId(event.params.id);
	const name = event.url.searchParams.get("name");

	const root = path.join(getDataDir(), "materials", assignmentId);

	if (name !== null && name !== "") {
		try {
			assertSafeSegment(name, "name");
		} catch (err) {
			throw error(400, (err as Error).message);
		}
		const candidates = [path.join(root, name), path.join(root, "input_data", name)];
		let removed = false;
		for (const candidate of candidates) {
			try {
				await unlink(candidate);
				removed = true;
			} catch (err) {
				if (!isNodeError(err) || err.code !== "ENOENT") {
					throw error(
						500,
						`Failed to delete material "${name}": ${(err as Error).message}`,
					);
				}
			}
		}
		if (!removed) {
			throw error(404, `Material "${name}" not found for assignment "${assignmentId}"`);
		}
		return json({ status: await scanMaterials(assignmentId), removed: [name] });
	}

	// Clear the whole materials directory for the assignment.
	try {
		await rm(root, { recursive: true, force: true });
	} catch (err) {
		throw error(500, `Failed to clear materials: ${(err as Error).message}`);
	}
	return json({ status: await scanMaterials(assignmentId), removed: [] });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validateAssignmentId(id: string | undefined): string {
	const value = id ?? "";
	try {
		assertSafeSegment(value, "assignmentId");
	} catch (err) {
		throw error(400, (err as Error).message);
	}
	return value;
}

/** True for key.ipynb or the <name>_key.ipynb convention used in sample data. */
function isKeyNotebook(name: string): boolean {
	const lower = name.toLowerCase();
	return lower === "key.ipynb" || lower.endsWith("_key.ipynb");
}

/** Scan <DATA_DIR>/materials/<assignmentId>/ and build a status report. */
async function scanMaterials(assignmentId: string): Promise<MaterialsStatus> {
	const root = path.join(getDataDir(), "materials", assignmentId);
	const files: MaterialFileInfo[] = [];
	let hasPdf = false;
	let hasKey = false;
	let hasInputData = false;

	let entries: Dirent[];
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch (err) {
		if (isNodeError(err) && err.code === "ENOENT") {
			// No materials uploaded yet — report an empty status.
			return { assignmentId, hasPdf, hasKey, hasInputData, files };
		}
		throw err;
	}

	for (const entry of entries) {
		if (entry.isDirectory()) {
			if (entry.name === "input_data") {
				const inner = await readdir(path.join(root, entry.name), {
					withFileTypes: true,
				}).catch(() => [] as Dirent[]);
				hasInputData = inner.length > 0;
				for (const fileEntry of inner) {
					if (fileEntry.isDirectory()) continue;
					files.push({
						name: fileEntry.name,
						kind: "material-data",
						relativePath: path.posix.join(
							"materials",
							assignmentId,
							"input_data",
							fileEntry.name,
						),
					});
				}
			}
			continue;
		}

		if (entry.name.toLowerCase().endsWith(".pdf")) hasPdf = true;
		if (isKeyNotebook(entry.name)) hasKey = true;
		files.push({
			name: entry.name,
			kind: "material-file",
			relativePath: path.posix.join("materials", assignmentId, entry.name),
		});
	}

	return { assignmentId, hasPdf, hasKey, hasInputData, files };
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
	return err instanceof Error && "code" in err;
}
