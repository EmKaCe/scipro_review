/**
 * @file results.json CRUD for executed submission batches.
 *
 * One results.json per assignment, stored at:
 *   <DATA_DIR>/submissions/<assignmentId>/results.json
 *
 * The file maps studentId -> stored execution result (the frontend-shaped
 * ExecutionResult from executor-client.ts). Batch execution stores summary
 * entries without cells (the executor's /execute/batch response carries no
 * cell data); single execution stores the full cell list.
 *
 * Written atomically (temp file + rename) like metadata.json.
 *
 * This module runs only on the SvelteKit server (`$lib/server/`).
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ExecutionResult } from "./executor-client";
import { assertSafeSegment, getDataDir } from "./metadata";
import type { PreEvaluation } from "./copilot/pre-evaluation";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Pre-evaluation envelope as persisted on a stored execution result: the
 * {@link PreEvaluation} wire contract plus when it was produced.
 */
export type StoredPreEvaluation = PreEvaluation & { evaluatedAt: string };

/**
 * Stored execution result; `error` is set when execution failed. `preEval`
 * is present once the copilot's pre-evaluation has been persisted for the
 * submission — older stored results without it stay valid.
 */
export type StoredExecutionResult = ExecutionResult & {
	error?: string | null;
	preEval?: StoredPreEvaluation;
};

/** results.json contents — a map keyed by studentId. */
export type ResultsFile = Record<string, StoredExecutionResult>;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Absolute path of the assignment results file. */
export function getResultsPath(assignmentId: string): string {
	assertSafeSegment(assignmentId, "assignmentId");
	return path.join(getDataDir(), "submissions", assignmentId, "results.json");
}

// ---------------------------------------------------------------------------
// Read / write
// ---------------------------------------------------------------------------

/** Read the assignment results file; {} when absent or corrupt. */
export async function readResults(assignmentId: string): Promise<ResultsFile> {
	const filePath = getResultsPath(assignmentId);
	let raw: string;
	try {
		raw = await readFile(filePath, "utf-8");
	} catch (err) {
		if (isNodeError(err) && err.code === "ENOENT") {
			return {};
		}
		throw err;
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
			return {};
		}
		return parsed as ResultsFile;
	} catch {
		// Corrupt results file — treat as absent; a re-run will overwrite it.
		return {};
	}
}

/** Atomically persist the assignment results file. */
export async function writeResults(assignmentId: string, results: ResultsFile): Promise<void> {
	const filePath = getResultsPath(assignmentId);
	await mkdir(path.dirname(filePath), { recursive: true });
	const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
	await writeFile(tmpPath, JSON.stringify(results, null, 2), "utf-8");
	await rename(tmpPath, filePath);
}

/** Store (or replace) the result for one student. */
export async function setResult(
	assignmentId: string,
	studentId: string,
	result: StoredExecutionResult,
): Promise<void> {
	assertSafeSegment(studentId, "studentId");
	const results = await readResults(assignmentId);
	results[studentId] = result;
	await writeResults(assignmentId, results);
}

/** Remove the result for one student (e.g. on re-upload). */
export async function clearResult(assignmentId: string, studentId: string): Promise<void> {
	assertSafeSegment(studentId, "studentId");
	const results = await readResults(assignmentId);
	if (!(studentId in results)) {
		return;
	}
	delete results[studentId];
	await writeResults(assignmentId, results);
}

/**
 * Persist (or replace) the pre-evaluation envelope for one submission.
 *
 * Requires an existing stored execution result — pre-evaluation is built
 * from executed cells, so there is nothing to attach the envelope to when
 * the submission was never executed (or only batch-executed without cell
 * data). Throws a helpful Error in that case instead of fabricating a row.
 */
export async function setPreEvaluation(
	assignmentId: string,
	studentId: string,
	preEval: StoredPreEvaluation,
): Promise<void> {
	assertSafeSegment(studentId, "studentId");
	const results = await readResults(assignmentId);
	const existing = results[studentId];
	if (!existing) {
		throw new Error(
			`Cannot store pre-evaluation for "${studentId}": no stored execution result in assignment "${assignmentId}"`,
		);
	}
	results[studentId] = { ...existing, preEval };
	await writeResults(assignmentId, results);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Human-readable cell summary for a stored result, e.g. "12 cells" or
 * "12 cells, 2 errors". Returns undefined when there is nothing to summarize
 * (no stored result, or a success with zero cells).
 */
export function deriveCellSummary(
	result: StoredExecutionResult | null | undefined,
): string | undefined {
	if (!result) {
		return undefined;
	}
	if (!result.success) {
		return "execution failed";
	}
	const total = result.totalCells ?? (Array.isArray(result.cells) ? result.cells.length : 0);
	if (total === 0) {
		return undefined;
	}
	const errors = result.errorCells ?? 0;
	return errors > 0
		? `${total} cells, ${errors} error${errors === 1 ? "" : "s"}`
		: `${total} cells`;
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
	return err instanceof Error && "code" in err;
}
