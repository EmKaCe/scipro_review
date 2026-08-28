/**
 * @file Teacher backup — one-file export/import of the whole data directory.
 *
 *   GET  /api/backup            → download <backup>.zip of DATA_DIR
 *   POST /api/backup (multipart "file") → restore a backup zip into DATA_DIR
 *
 * This is the machine-migration path (teacher → teacher, or same teacher on
 * a new computer). It is deliberately separate from the per-submission YAML
 * exports: those carry grading state only, this carries everything including
 * notebooks and plagiarism results.
 */

import { error } from "@sveltejs/kit";
import type { RequestEvent } from "@sveltejs/kit";

import { buildBackupZip, countDataFiles, restoreBackupZip } from "$lib/server/backup-service";
import { parseMultipartFormData } from "$lib/server/form-data";

/** Download a zip of the whole data directory. */
export async function GET(): Promise<Response> {
	const zip = await buildBackupZip();
	const fileCount = await countDataFiles();
	const date = new Date().toISOString().slice(0, 10);
	// Copy into a plain ArrayBuffer-backed view (fflate may return a
	// SharedArrayBuffer-backed view; undici accepts Uint8Array bodies).
	const bytes = new Uint8Array(zip.byteLength);
	bytes.set(zip);
	return new Response(bytes, {
		headers: {
			"Content-Type": "application/zip",
			"Content-Disposition": `attachment; filename="sci-pro-teacher-backup-${date}.zip"`,
			"X-Backup-File-Count": String(fileCount),
		},
	});
}

/** Restore a backup zip into the data directory (multipart field "file"). */
export async function POST(event: RequestEvent): Promise<Response> {
	const formData = await parseMultipartFormData(event, "Expected multipart form data");
	const file = formData.get("file");
	if (!(file instanceof File)) {
		throw error(400, "Missing 'file' field (a .zip backup)");
	}
	if (file.size === 0) {
		throw error(400, "Empty backup file");
	}
	if (file.size > 200 * 1024 * 1024) {
		throw error(400, "Backup too large (max 200 MB)");
	}

	const bytes = new Uint8Array(await file.arrayBuffer());
	try {
		const restored = await restoreBackupZip(bytes);
		return Response.json({ restored, fileName: file.name });
	} catch (e) {
		throw error(
			400,
			e instanceof Error
				? `Could not restore backup: ${e.message}`
				: "Could not restore backup",
		);
	}
}
