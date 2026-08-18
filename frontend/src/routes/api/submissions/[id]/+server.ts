/**
 * @file /api/submissions/[id] — full detail + deletion for one submission.
 *
 * GET    — metadata record plus executed cells. Cells come from the
 *          assignment's results.json (data/submissions/<assignment>/results.json);
 *          entries written by the batch endpoint carry no cell data, so `cells` is []
 *          until a single-submission process run stores them. Stored wire-shaped
 *          cells (cell_index) are translated via executor-client.translateCell;
 *          already-translated cells pass through.
 * DELETE — permanently remove the submission: metadata entry, notebook file,
 *          stored execution result, and plagiarism pairs. Destructive — the
 *          UI requires a confirm step before calling this.
 *
 * Query param (both):
 *   assignment? — target assignment (default: first enabled assignment)
 */

import { unlink } from "node:fs/promises";

import { error, json } from "@sveltejs/kit";
import type { RequestEvent } from "@sveltejs/kit";

import { assignmentExists, resolveAssignmentId } from "$lib/server/assignments";
import {
	translateCell,
	type ExecutedCell,
	type ExecutorCellResult,
} from "$lib/server/executor-client";
import { getSubmissionNotebookAbsolutePath } from "$lib/server/file-service";
import { getSubmission, removeSubmission } from "$lib/server/metadata";
import { removeStudentFromPlagiarism } from "$lib/server/plagiarism/cache";
import { readResults, clearResult } from "$lib/server/results-store";
import {
	loadCohortNorms,
	overTickFromStored,
} from "$lib/server/copilot/over-tick";
import type { CellInfo } from "$lib/types/submissions";

export async function GET(event: RequestEvent): Promise<Response> {
	const studentId = event.params.id;
	if (!studentId) {
		throw error(400, "Missing submission id");
	}
	const assignmentId = await resolveAssignmentId(event.url.searchParams.get("assignment"));
	if (!assignmentId) {
		throw error(404, "No assignments configured");
	}
	if (!(await assignmentExists(assignmentId))) {
		throw error(404, `Assignment "${assignmentId}" not found`);
	}

	const record = await getSubmission(assignmentId, studentId);
	if (!record) {
		throw error(404, `Submission "${studentId}" not found in assignment "${assignmentId}"`);
	}

	const results = await readResults(assignmentId);
	const stored = results[studentId];
	const cells = normalizeStoredCells(stored?.cells);
	// The verified fixed execution (when present) is normalized the same way
	// as `cells` — same indices, separate array, so the UI can toggle per cell.
	const fixedCells = normalizeStoredCells(stored?.fixedCells);
	// The pre-evaluation envelope is stored with snake_case `cell_index`
	// (server contract) and served in the camelCase wire shape the client's
	// PreEvalData expects — markers: null keeps the UI's pending state.
	const preEval = stored?.preEval
		? {
				...stored.preEval,
				markers: stored.preEval.markers
					? stored.preEval.markers.map((m) => ({
							cellIndex: m.cell_index,
							marker: m.marker,
							reason: m.reason,
						}))
					: null,
			}
		: undefined;
	// Over-tick guard (review-diff workflow): full advisory result for the
	// review-page extras panel. Absent norms degrade to no flags.
	const norms = await loadCohortNorms(assignmentId).catch(() => null);
	const overTick = norms ? overTickFromStored(stored, norms) : null;

	return json({ ...record, cells, fixedCells, preEval, overTick });
}

export async function DELETE(event: RequestEvent): Promise<Response> {
	const studentId = event.params.id;
	if (!studentId) {
		throw error(400, "Missing submission id");
	}
	const assignmentId = await resolveAssignmentId(event.url.searchParams.get("assignment"));
	if (!assignmentId) {
		throw error(404, "No assignments configured");
	}
	if (!(await assignmentExists(assignmentId))) {
		throw error(404, `Assignment "${assignmentId}" not found`);
	}
	const existing = await getSubmission(assignmentId, studentId);
	if (!existing) {
		throw error(404, `Submission "${studentId}" not found in assignment "${assignmentId}"`);
	}

	// Notebook file (best-effort — a missing file must not block removal).
	try {
		await unlink(getSubmissionNotebookAbsolutePath(assignmentId, studentId));
	} catch (err) {
		if (!isNodeError(err) || err.code !== "ENOENT") {
			throw error(500, `Failed to delete notebook file: ${(err as Error).message}`);
		}
	}

	// Execution result + plagiarism pairs involving this student.
	await clearResult(assignmentId, studentId);
	await removeStudentFromPlagiarism(assignmentId, studentId);

	// Metadata last: if anything above threw, the record stays consistent.
	await removeSubmission(assignmentId, studentId);

	return json({ deleted: studentId, assignmentId });
}

// ---------------------------------------------------------------------------
// Cell normalization
// ---------------------------------------------------------------------------

/**
 * Normalize stored cells to the frontend CellInfo shape. Accepts both wire
 * cells (executor snake_case, `cell_index`) and already-translated cells
 * (camelCase, `index`). Unknown entries are skipped.
 */
function normalizeStoredCells(raw: unknown): CellInfo[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	const cells: CellInfo[] = [];
	for (const item of raw) {
		if (item === null || typeof item !== "object") {
			continue;
		}
		const cell = item as Record<string, unknown>;
		if (typeof cell.cell_index === "number") {
			cells.push(toCellInfo(translateCell(cell as unknown as ExecutorCellResult)));
		} else if (typeof cell.index === "number") {
			cells.push(toCellInfo(cell as unknown as CellInfo));
		}
	}
	return cells;
}

/** Map an ExecutedCell (or already-translated CellInfo) onto the slimmer CellInfo surface. */
function toCellInfo(cell: CellInfo | ExecutedCell): CellInfo {
	return {
		index: cell.index,
		type: cell.type,
		source: cell.source,
		output: cell.output,
		error: cell.error ?? undefined,
		marker: cell.marker,
	};
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
	return err instanceof Error && "code" in err;
}
