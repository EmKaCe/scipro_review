/**
 * @file POST /api/submissions/upload — multipart upload, classify, persist.
 *
 * Form fields:
 *   files[]        — one or more uploaded files (required)
 *   assignmentId   — target assignment (required)
 *   kinds          — optional JSON object mapping file name -> UploadKind
 *                    override, e.g. {"notes.pdf": "material-data"}
 *   kind_<name>    — alternative per-file override field
 *
 * Files are classified via file-service.classifyFile (student notebooks ->
 * submissions/, data files -> materials/<assignment>/input_data/, everything
 * else -> materials/<assignment>/). Overrides may only move a file between
 * material-data and material-file; forcing "submission" requires a student
 * file name (<semester>_<n>.ipynb) and is otherwise rejected.
 *
 * Submission files are also upserted into the batch metadata (new records
 * start "pending"; re-uploads replace the notebook, reset status to
 * "pending" and clear stale execution results). Material files only land on
 * disk — the assignments materials endpoints manage their listing.
 */

import { error, json } from "@sveltejs/kit";
import type { RequestEvent } from "@sveltejs/kit";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { assignmentExists } from "$lib/server/assignments";
import {
	classifyFile,
	validateSubmissionFile,
	type ClassifiedFile,
	type UploadKind,
} from "$lib/server/file-service";
import { getDataDir, upsertSubmission } from "$lib/server/metadata";
import { clearResult } from "$lib/server/results-store";
import { parseMultipartFormData } from "$lib/server/form-data";
import type { SubmissionUploadResult } from "$lib/services/submissions-api";

const VALID_KINDS: ReadonlySet<string> = new Set<UploadKind>([
	"submission",
	"material-data",
	"material-file",
]);

export async function POST(event: RequestEvent): Promise<Response> {
	const form = await parseMultipartFormData(event, "Expected multipart/form-data body");

	const assignmentId = String(form.get("assignmentId") ?? "").trim();
	if (!assignmentId) {
		throw error(400, "Missing assignmentId field");
	}
	if (!(await assignmentExists(assignmentId))) {
		throw error(404, `Assignment "${assignmentId}" not found`);
	}

	// Duck-typed File check: FormData entries may come from another realm
	// (undici vs jsdom), so `instanceof File` is unreliable under test.
	const files = form
		.getAll("files")
		.filter((entry): entry is File => typeof entry === "object" && entry !== null);
	if (files.length === 0) {
		throw error(400, "No files provided (field name: files)");
	}

	const overrides = parseKindOverrides(form);

	// One bad file must not abort the batch: failures are reported per-file
	// (error entry) and the remaining files are still processed.
	const persisted: SubmissionUploadResult[] = [];
	for (const file of files) {
		try {
			const classification = applyKindOverride(
				classifyFile(file.name, assignmentId),
				overrides.get(file.name),
			);
			const data = new Uint8Array(await file.arrayBuffer());

			// Submissions are validated BEFORE they are persisted: a corrupt
			// notebook never lands on disk or in the batch metadata, and the
			// per-file error surfaces in the response for the UI to show.
			if (classification.kind === "submission") {
				const validation = validateSubmissionFile(file.name, Buffer.from(data));
				if (!validation.valid) {
					persisted.push({
						fileName: file.name,
						kind: "submission",
						replaced: false,
						bytes: data.byteLength,
						error: validation.error ?? "Invalid submission file",
					});
					continue;
				}
			}

			const replaced = await persistClassified(classification, data);

			if (classification.kind === "submission") {
				const record = await upsertSubmission(assignmentId, classification.studentId!, {
					semester: classification.semester,
					fileName: classification.fileName,
					notebookPath: classification.relativePath,
					status: "pending",
					error: null,
				});
				await clearResult(assignmentId, classification.studentId!);
				persisted.push({
					fileName: file.name,
					kind: classification.kind,
					studentId: record.studentId,
					semester: record.semester,
					replaced,
					bytes: data.byteLength,
					notebookPath: record.notebookPath,
				});
			} else {
				persisted.push({
					fileName: file.name,
					kind: classification.kind,
					replaced,
					bytes: data.byteLength,
					relativePath: classification.relativePath,
				});
			}
		} catch (err) {
			persisted.push({
				fileName: file.name,
				kind: "material-file", // kind is meaningless for failed files; UI shows the error row
				replaced: false,
				bytes: 0,
				error: errorMessage(err),
			});
		}
	}

	return json({ assignmentId, results: persisted });
}

/**
 * Extract a human-readable message from an unknown thrown value. SvelteKit's
 * `error()` throws an HttpError that is NOT an Error instance — its message
 * lives in body.message — so handle that shape explicitly.
 */
function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	if (typeof err === "object" && err !== null) {
		const body = (err as { body?: unknown }).body;
		if (typeof body === "string") return body;
		if (typeof body === "object" && body !== null) {
			const message = (body as { message?: unknown }).message;
			if (typeof message === "string") return message;
		}
	}
	return String(err);
}

// ---------------------------------------------------------------------------
// Kind overrides
// ---------------------------------------------------------------------------

/** Parse optional per-file kind overrides (`kinds` JSON + `kind_<name>` fields). */
function parseKindOverrides(form: FormData): Map<string, UploadKind> {
	const overrides = new Map<string, UploadKind>();

	const kindsRaw = form.get("kinds");
	if (kindsRaw) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(String(kindsRaw));
		} catch {
			throw error(400, "Invalid kinds field: expected a JSON object");
		}
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw error(400, "Invalid kinds field: expected a JSON object");
		}
		for (const [fileName, kind] of Object.entries(parsed as Record<string, unknown>)) {
			overrides.set(fileName, validateKind(String(kind), fileName));
		}
	}

	for (const entry of form.entries()) {
		const match = /^kind_(.+)$/.exec(entry[0]);
		if (match) {
			overrides.set(match[1]!, validateKind(String(entry[1]), match[1]!));
		}
	}

	return overrides;
}

function validateKind(kind: string, fileName: string): UploadKind {
	if (!VALID_KINDS.has(kind)) {
		throw error(
			400,
			`Invalid kind "${kind}" for "${fileName}": expected submission, material-data or material-file`,
		);
	}
	return kind as UploadKind;
}

/**
 * Apply a kind override to a classification. Overrides may move a file
 * between material-data and material-file, or confirm a submission. Forcing
 * "submission" on a file whose name has no student pattern is rejected.
 */
function applyKindOverride(
	classified: ClassifiedFile,
	override: UploadKind | undefined,
): ClassifiedFile {
	if (!override || override === classified.kind) {
		return classified;
	}
	if (override === "submission") {
		throw error(
			400,
			`Cannot classify "${classified.fileName}" as submission: file name must match <semester>_<n>.ipynb`,
		);
	}
	if (override === "material-data") {
		return {
			...classified,
			kind: "material-data",
			destination: "materials",
			relativePath: path.join(
				"materials",
				classified.assignmentId,
				"input_data",
				classified.fileName,
			),
			absolutePath: path.join(
				getDataDir(),
				"materials",
				classified.assignmentId,
				"input_data",
				classified.fileName,
			),
		};
	}
	return {
		...classified,
		kind: "material-file",
		destination: "materials",
		relativePath: path.join("materials", classified.assignmentId, classified.fileName),
		absolutePath: path.join(
			getDataDir(),
			"materials",
			classified.assignmentId,
			classified.fileName,
		),
	};
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Write an uploaded file at its classified destination. Mirrors
 * file-service.persistUpload but honors an already-adjusted classification
 * (persistUpload re-classifies internally and would ignore kind overrides).
 */
async function persistClassified(classified: ClassifiedFile, data: Uint8Array): Promise<boolean> {
	let existed = false;
	try {
		await access(classified.absolutePath);
		existed = true;
	} catch {
		// file does not exist yet
	}
	await mkdir(path.dirname(classified.absolutePath), { recursive: true });
	await writeFile(classified.absolutePath, data);
	return existed;
}
