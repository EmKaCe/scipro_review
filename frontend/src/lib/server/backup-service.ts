/**
 * @file Teacher backup service — one-file export/import of the whole data
 * directory (assignments, criteria, materials, submissions incl. notebooks,
 * metadata, plagiarism results).
 *
 * Format: ZIP (via fflate — no new runtime deps beyond the tiny pure-JS
 * archive lib). Notebooks are stored as files inside the archive, never
 * embedded in YAML. Restore is guarded against path traversal and rejects
 * absolute/`..` entry names.
 *
 * Migration story: teacher switches machines → download backup → restore on
 * the new machine. The per-submission YAML exports are NOT the migration
 * vehicle (they carry grading state, not notebooks); this archive is.
 */

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { unzipSync, zipSync } from "fflate";

import { getDataDir } from "./metadata";

// ---------------------------------------------------------------------------
// Zip
// ---------------------------------------------------------------------------

/** Recursively collect { relativePath, absolutePath } files under a dir. */
async function collectFiles(
	root: string,
	dir: string,
	prefix: string,
	files: { name: string; abs: string }[],
): Promise<void> {
	const entries = await readdir(dir, { withFileTypes: true });
	entries.sort((a, b) => a.name.localeCompare(b.name));
	for (const entry of entries) {
		const abs = path.join(dir, entry.name);
		const name = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) {
			await collectFiles(root, abs, name, files);
		} else if (entry.isFile()) {
			files.push({ name, abs });
		}
		// Symlinks are skipped — restoring them would be a security hazard.
	}
}

/** Build a backup zip of the whole DATA_DIR. */
export async function buildBackupZip(): Promise<Uint8Array> {
	const root = getDataDir();
	const files: { name: string; abs: string }[] = [];
	await collectFiles(root, root, "", files);

	const contents: Record<string, Uint8Array> = {};
	for (const file of files) {
		contents[file.name] = await readFile(file.abs);
	}
	return zipSync(contents, { level: 6 });
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

/** Restore a backup zip into DATA_DIR. Returns the number of restored files. */
export async function restoreBackupZip(zipBytes: Uint8Array): Promise<number> {
	const entries = unzipSync(zipBytes);
	const root = getDataDir();

	let restored = 0;
	// fflate returns an object keyed by entry name; names are already
	// normalized by the parser, but guard anyway (defense in depth).
	for (const [name, data] of Object.entries(entries)) {
		if (!isSafeEntryName(name)) {
			throw new Error(`Backup contains an unsafe path: "${name}"`);
		}
		const target = path.join(root, name);
		if (target !== root && !target.startsWith(root + path.sep)) {
			throw new Error(`Backup path escapes the data directory: "${name}"`);
		}
		await mkdir(path.dirname(target), { recursive: true });
		await writeFile(target, data);
		restored += 1;
	}
	return restored;
}

/** Reject absolute paths, traversal, drive letters, and hidden escapes. */
function isSafeEntryName(name: string): boolean {
	if (name === "" || name.startsWith("/") || name.startsWith("\\")) return false;
	if (/^[A-Za-z]:/.test(name)) return false;
	const parts = name.split(/[\\/]/);
	for (const part of parts) {
		if (part === ".." || part === ".") return false;
	}
	return true;
}

// ---------------------------------------------------------------------------
// File-count helper (used by the GET route header/logging)
// ---------------------------------------------------------------------------

/** Count files under DATA_DIR (for logging/verification). */
export async function countDataFiles(): Promise<number> {
	const root = getDataDir();
	const files: { name: string; abs: string }[] = [];
	await collectFiles(root, root, "", files);
	return files.length;
}
