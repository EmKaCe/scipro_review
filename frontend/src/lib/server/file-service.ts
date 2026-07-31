/**
 * @file Upload classification + persistence for the canonical data layout.
 *
 * Classification (by file name + extension):
 *   submissions:  <semester>_<n>*.ipynb  -> data/submissions/<assignment>/<studentId>.ipynb
 *   material-data: csv/xlsx/txt/...      -> data/materials/<assignment>/input_data/
 *   material-file: pdf / key.ipynb / etc -> data/materials/<assignment>/
 *
 * studentId + semester are derived from the file name, e.g. "2026SS_03" ->
 * studentId "2026SS_03", semester "2026SS". Re-uploads of the same studentId
 * replace the existing notebook (dedup by studentId).
 *
 * Environment:
 *   DATA_DIR — data root (default: ./data, i.e. /app/data in Docker)
 *
 * This module runs only on the SvelteKit server (`$lib/server/`).
 */

import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { assertSafeSegment, getDataDir } from "./metadata";

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export type UploadKind = "submission" | "material-data" | "material-file";

/** Extensions treated as assignment input data (copied into the sandbox). */
const DATA_EXTENSIONS = new Set([
	"csv",
	"tsv",
	"txt",
	"dat",
	"xlsx",
	"xls",
	"json",
	"npz",
	"npy",
	"pkl",
	"pickle",
	"parquet",
	"h5",
	"hdf5",
	"mat",
	"zip",
	"gz",
]);

/** Student submission file names: semester prefix + number, e.g. "2026SS_03". */
const STUDENT_FILENAME_RE = /^(\d{4}(?:SS|WS))_(\d{2,})/;

export interface ClassifiedFile {
	kind: UploadKind;
	assignmentId: string;
	/** Derived for submissions, e.g. "2026SS_03". */
	studentId?: string;
	/** Derived semester, e.g. "2026SS". */
	semester?: string;
	/** Original uploaded file name. */
	fileName: string;
	/** Destination relative to DATA_DIR, e.g. "submissions/soil/2026SS_03.ipynb". */
	relativePath: string;
	/** Absolute destination path. */
	absolutePath: string;
	/** Top-level destination directory name within DATA_DIR. */
	destination: "submissions" | "materials";
}

export interface PersistResult {
	file: ClassifiedFile;
	/** True when a file with the same studentId/name already existed. */
	replaced: boolean;
	/** Bytes written. */
	bytes: number;
}

/**
 * Classify an uploaded file for the given assignment.
 * Pure (no I/O) — returns the destination layout without writing anything.
 */
export function classifyFile(fileName: string, assignmentId: string): ClassifiedFile {
	assertSafeSegment(assignmentId, "assignmentId");

	const baseName = path.basename(fileName);
	const ext = path.extname(baseName).slice(1).toLowerCase();

	// Submissions: notebooks with a student-id file name pattern.
	if (ext === "ipynb") {
		const match = STUDENT_FILENAME_RE.exec(baseName);
		if (match) {
			const semester = match[1]!;
			const studentId = `${semester}_${match[2]!}`;
			assertSafeSegment(studentId, "studentId");
			return {
				kind: "submission",
				assignmentId,
				studentId,
				semester,
				fileName: baseName,
				relativePath: path.join("submissions", assignmentId, `${studentId}.ipynb`),
				absolutePath: path.join(
					getDataDir(),
					"submissions",
					assignmentId,
					`${studentId}.ipynb`,
				),
				destination: "submissions",
			};
		}
		// Non-student notebooks (e.g. key.ipynb) are assignment materials.
		return {
			kind: "material-file",
			assignmentId,
			fileName: baseName,
			relativePath: path.join("materials", assignmentId, baseName),
			absolutePath: path.join(getDataDir(), "materials", assignmentId, baseName),
			destination: "materials",
		};
	}

	// Data files land in the assignment's input_data/ (sandbox source).
	if (DATA_EXTENSIONS.has(ext)) {
		return {
			kind: "material-data",
			assignmentId,
			fileName: baseName,
			relativePath: path.join("materials", assignmentId, "input_data", baseName),
			absolutePath: path.join(
				getDataDir(),
				"materials",
				assignmentId,
				"input_data",
				baseName,
			),
			destination: "materials",
		};
	}

	// Everything else (pdf, py, png, ...) goes to the assignment materials root.
	return {
		kind: "material-file",
		assignmentId,
		fileName: baseName,
		relativePath: path.join("materials", assignmentId, baseName),
		absolutePath: path.join(getDataDir(), "materials", assignmentId, baseName),
		destination: "materials",
	};
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Classify and persist an uploaded file. Creates parent directories and
 * overwrites any existing file at the destination (dedup by studentId for
 * submissions). Returns the classification plus whether a file was replaced.
 */
export async function persistUpload(
	fileName: string,
	data: ArrayBuffer | Uint8Array | string,
	assignmentId: string,
): Promise<PersistResult> {
	const file = classifyFile(fileName, assignmentId);

	const content: Uint8Array =
		typeof data === "string"
			? new TextEncoder().encode(data)
			: data instanceof Uint8Array
				? data
				: new Uint8Array(data);

	const existed = await fileExists(file.absolutePath);
	await mkdir(path.dirname(file.absolutePath), { recursive: true });
	await writeFile(file.absolutePath, content);

	return { file, replaced: existed, bytes: content.byteLength };
}

/** Relative notebook path for the executor, e.g. "submissions/soil/2026SS_03.ipynb". */
export function getSubmissionNotebookPath(assignmentId: string, studentId: string): string {
	assertSafeSegment(assignmentId, "assignmentId");
	assertSafeSegment(studentId, "studentId");
	return path.join("submissions", assignmentId, `${studentId}.ipynb`);
}

/** Absolute path to a stored submission notebook. */
export function getSubmissionNotebookAbsolutePath(assignmentId: string, studentId: string): string {
	return path.join(getDataDir(), getSubmissionNotebookPath(assignmentId, studentId));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await access(filePath);
		return true;
	} catch {
		return false;
	}
}
