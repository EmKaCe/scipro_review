/**
 * @file File-backed turn-snapshot store (P3 — per-submission checkpoints).
 *
 * Before a copilot turn's FIRST grading write, the agent loop snapshots the
 * submission's grading state (rubric / dimensions / notes / feedback) and
 * persists it here, so the teacher can revert the WHOLE turn with one
 * button. The snapshot is exactly what getSubmission returns for the
 * grading fields — the same shape the save API accepts as a patch.
 *
 * DESIGN NOTE: checkpoints are persisted for AUDIT — they are write-only in
 * production. The revert path uses the IN-MEMORY snapshot delivered by the
 * stream's `checkpoint` event (the client holds it for the turn's
 * lifetime), NOT loadCheckpoint/listCheckpoints; a page reload therefore
 * loses the Revert button even though the file exists. That is accepted:
 * the files are the audit trail of what each turn's pre-write state was.
 *
 * Layout under DATA_DIR (same "files are the database" pattern as
 * file-memory.ts — atomic tmp+rename writes, assertSafeSegment guards):
 *   copilot/checkpoints/<threadId>/<turnId>.json   — one snapshot per file
 *
 * This module runs only on the SvelteKit server (`$lib/server/`).
 */

import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { assertSafeSegment, getDataDir } from "$lib/server/metadata";
import type { CategoryFeedback } from "$lib/types/evaluation";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A submission's grading state at one point in time — the pre-turn snapshot
 * the revert button restores. Mirrors GradingState minus the bookkeeping
 * fields (updatedAt / autofixDispositions are not part of the revert patch).
 */
export interface GradingSnapshot {
	/** Rubric selections: criterion key -> selected option key. */
	rubric: Record<string, string>;
	/** Dimension scores: dimension id -> slider value (points deducted). */
	dimensions: Record<string, number>;
	/** Free-form teacher notes (null when the submission has no notes). */
	notes: string | null;
	/** Per-category feedback (v2 CategoryFeedback shape, keyed by category key). */
	feedback: Record<string, CategoryFeedback>;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function checkpointsDir(threadId: string): string {
	assertSafeSegment(threadId, "threadId");
	return path.join(getDataDir(), "copilot", "checkpoints", threadId);
}

function checkpointFile(threadId: string, turnId: string): string {
	assertSafeSegment(threadId, "threadId");
	assertSafeSegment(turnId, "turnId");
	return path.join(checkpointsDir(threadId), `${turnId}.json`);
}

// ---------------------------------------------------------------------------
// JSON helpers (atomic writes, same pattern as file-memory.ts)
// ---------------------------------------------------------------------------

async function readJson<T>(file: string): Promise<T | null> {
	try {
		const raw = await readFile(file, "utf8");
		return JSON.parse(raw) as T;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw err;
	}
}

async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
	await mkdir(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	await writeFile(tmp, JSON.stringify(data, null, "\t"));
	await rename(tmp, file);
}

// ---------------------------------------------------------------------------
// Store API
// ---------------------------------------------------------------------------

/**
 * Persist one turn's pre-write grading snapshot. Overwrites any earlier
 * snapshot for the same (threadId, turnId) — a turn id is unique per run,
 * so this only happens on a re-run of the same id (never in practice).
 */
export async function saveCheckpoint(
	threadId: string,
	turnId: string,
	snapshot: GradingSnapshot,
): Promise<void> {
	await writeJsonAtomic(checkpointFile(threadId, turnId), snapshot);
}

/**
 * Load a turn's snapshot, or null when no checkpoint exists for that turn
 * (missing file / never snapshotted).
 */
export async function loadCheckpoint(
	threadId: string,
	turnId: string,
): Promise<GradingSnapshot | null> {
	return readJson<GradingSnapshot>(checkpointFile(threadId, turnId));
}

/**
 * List the turn ids that have checkpoints for a thread (sorted
 * lexicographically — turn ids are UUIDs, so this is not chronological;
 * callers that need order should sort by their own metadata). Returns []
 * when the thread has no checkpoints yet.
 */
export async function listCheckpoints(threadId: string): Promise<string[]> {
	assertSafeSegment(threadId, "threadId");
	let files: string[];
	try {
		files = await readdir(checkpointsDir(threadId));
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw err;
	}
	return files
		.filter((f) => f.endsWith(".json"))
		.map((f) => f.slice(0, -".json".length))
		.sort();
}

/** Remove a thread's checkpoint directory (housekeeping; force-safe). */
export async function deleteThreadCheckpoints(threadId: string): Promise<void> {
	assertSafeSegment(threadId, "threadId");
	await rm(checkpointsDir(threadId), { recursive: true, force: true });
}
