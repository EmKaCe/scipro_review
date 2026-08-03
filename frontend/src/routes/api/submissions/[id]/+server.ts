/**
 * @file GET /api/submissions/[id] — full detail for one submission.
 *
 * Returns the metadata record plus executed cells. Cells come from the
 * assignment's results.json (data/submissions/<assignment>/results.json);
 * entries written by the batch endpoint carry no cell data, so `cells` is []
 * until a single-submission process run stores them. Stored wire-shaped
 * cells (cell_index) are translated via executor-client.translateCell;
 * already-translated cells pass through.
 */

import { error, json } from "@sveltejs/kit";
import type { RequestEvent } from "@sveltejs/kit";

import {
	translateCell,
	type ExecutedCell,
	type ExecutorCellResult,
} from "$lib/server/executor-client";
import { getSubmission } from "$lib/server/metadata";
import { readResults } from "$lib/server/results-store";
import type { CellInfo } from "$lib/types/submissions";
import { assignmentExists, resolveAssignmentId } from "$lib/server/assignments";

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
	const cells = normalizeStoredCells(results[studentId]?.cells);

	return json({ ...record, cells });
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
