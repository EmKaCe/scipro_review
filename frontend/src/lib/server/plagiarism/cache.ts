/**
 * @file data/plagiarism/<assignment>.json cache for plagiarism results.
 *
 * The check route writes the completed comparison here (atomically, same
 * pattern as metadata.json / results.json); the results route reads it.
 *
 * Environment:
 *   DATA_DIR — data root (default: ./data, i.e. /app/data in Docker)
 *
 * This module runs only on the SvelteKit server (`$lib/server/`).
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { assertSafeSegment, getDataDir } from "../metadata";

import type { PairReviewStatus, PlagiarismPair } from "./structural";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Cached plagiarism comparison for one assignment (Phase 3d data model). */
export interface PlagiarismResult {
	status: "pending" | "checking" | "done" | "error";
	assignmentId: string;
	/** ISO timestamp of the check run. */
	generatedAt: string;
	/** Flagged pairs, sorted by cellOverlap descending. */
	pairs: PlagiarismPair[];
	/** Total number of unique pairs compared (flagged + below threshold). */
	totalPairs: number;
	/** studentIds included in the comparison, sorted. */
	comparedSubmissions: string[];
	/** True when the semantic (LLM) pass ran and produced scores. */
	semanticChecked?: boolean;
	/** Error detail when status is "error". */
	error?: string;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Absolute path of the plagiarism cache file for an assignment. */
export function getPlagiarismCachePath(assignmentId: string): string {
	assertSafeSegment(assignmentId, "assignmentId");
	return path.join(getDataDir(), "plagiarism", `${assignmentId}.json`);
}

// ---------------------------------------------------------------------------
// Read / write
// ---------------------------------------------------------------------------

/** Read the cached result; null when absent or corrupt. */
export async function readPlagiarismResult(assignmentId: string): Promise<PlagiarismResult | null> {
	const filePath = getPlagiarismCachePath(assignmentId);
	let raw: string;
	try {
		raw = await readFile(filePath, "utf-8");
	} catch (err) {
		if (isNodeError(err) && err.code === "ENOENT") {
			return null;
		}
		throw err;
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return null;
		}
		return parsed as PlagiarismResult;
	} catch {
		// Corrupt cache — treat as absent; a re-run will overwrite it.
		return null;
	}
}

/** Atomically persist a plagiarism result. */
export async function writePlagiarismResult(
	assignmentId: string,
	result: PlagiarismResult,
): Promise<void> {
	const filePath = getPlagiarismCachePath(assignmentId);
	await mkdir(path.dirname(filePath), { recursive: true });
	const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
	await writeFile(tmpPath, JSON.stringify(result, null, 2), "utf-8");
	await rename(tmpPath, filePath);
}

/**
 * Set the review status of one pair in the cached result (P3-1) and persist
 * the updated result atomically. The pair is matched by its canonical
 * (studentA, studentB) ordering; the reversed order is accepted too.
 *
 * Returns the updated result, or null when the assignment has no cache or
 * the pair does not exist.
 */
export async function updatePairReviewStatus(
	assignmentId: string,
	studentA: string,
	studentB: string,
	reviewStatus: PairReviewStatus,
): Promise<PlagiarismResult | null> {
	const result = await readPlagiarismResult(assignmentId);
	if (!result) return null;

	const pair = result.pairs.find(
		(p) =>
			(p.studentA === studentA && p.studentB === studentB) ||
			(p.studentA === studentB && p.studentB === studentA),
	);
	if (!pair) return null;

	pair.reviewStatus = reviewStatus;
	await writePlagiarismResult(assignmentId, result);
	return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
	return err instanceof Error && "code" in err;
}
