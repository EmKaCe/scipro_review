/**
 * @file POST /api/submissions/[id]/autofix/verify — verify a suggested fix
 *       in FULL notebook context.
 *
 * The manual "Suggest fix" flow gets the same guarantee as the automatic
 * autofix stage: the patch is verified by re-running the WHOLE notebook in
 * a fresh sandbox (a single-cell re-run loses kernel state built by
 * earlier cells — the `_00` regression). The notebook context is the
 * stored execution result (results.json), so the teacher never sends the
 * notebook and nothing is ever mutated.
 *
 * Body (JSON):
 *   cellIndex     — 0-based index of the cell being patched (must be a
 *                   code cell)
 *   patchedSource — the fixed source to verify (must parse as Python)
 *
 * Query param:
 *   assignment? — target assignment (default: first enabled assignment)
 *
 * Response: the executor's AutoFixRunResponse shape (fixed, re_run_output,
 * re_run_error, fixed_cells, totals). HTTP budget = the per-notebook
 * setting (settings.executor.notebookTimeoutMs) — a whole-notebook re-run
 * can take as long as the original execution.
 */

import { error, json } from "@sveltejs/kit";
import type { RequestEvent } from "@sveltejs/kit";

import { assignmentExists, resolveAssignmentId } from "$lib/server/assignments";
import { getExecutorClient, type AutofixVerifyCell } from "$lib/server/executor-client";
import { getSubmission } from "$lib/server/metadata";
import { readResults } from "$lib/server/results-store";
import { loadSettings } from "$lib/server/settings";

/**
 * Build the notebook context for verification from the stored execution
 * result. Accepts both wire cells (snake_case `cell_type`) and
 * already-translated cells (camelCase `type`). Cells without a usable
 * source are skipped (they cannot participate in a re-run anyway).
 */
function storedCellsForVerify(raw: unknown): AutofixVerifyCell[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	const cells: AutofixVerifyCell[] = [];
	for (const item of raw) {
		if (item === null || typeof item !== "object") {
			continue;
		}
		const cell = item as Record<string, unknown>;
		const source = typeof cell.source === "string" ? cell.source : "";
		if (source === "") {
			continue;
		}
		const rawType =
			typeof cell.cell_type === "string"
				? cell.cell_type
				: typeof cell.type === "string"
					? cell.type
					: "code";
		cells.push({ source, cellType: rawType === "markdown" ? "markdown" : "code" });
	}
	return cells;
}

export async function POST(event: RequestEvent): Promise<Response> {
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

	let body: unknown;
	try {
		body = await event.request.json();
	} catch {
		throw error(400, "Expected a JSON body");
	}
	if (body === null || typeof body !== "object" || Array.isArray(body)) {
		throw error(400, "Expected a JSON object body");
	}
	const input = body as Record<string, unknown>;

	if (typeof input.cellIndex !== "number" || !Number.isInteger(input.cellIndex)) {
		throw error(400, "cellIndex must be an integer");
	}
	const cellIndex = input.cellIndex;
	if (typeof input.patchedSource !== "string" || input.patchedSource === "") {
		throw error(400, "patchedSource must be a non-empty string");
	}

	// The notebook context is the stored execution result — the authentic
	// executed state the teacher is reviewing (never the original file).
	const results = await readResults(assignmentId);
	const stored = results[studentId];
	const cells = storedCellsForVerify(stored?.cells);
	if (cellIndex < 0 || cellIndex >= cells.length) {
		throw error(400, `cellIndex ${cellIndex} out of range (${cells.length} stored cells)`);
	}
	if (cells[cellIndex].cellType !== "code") {
		throw error(400, "Target cell is not a code cell — refusing to verify");
	}

	const settings = await loadSettings();
	const result = await getExecutorClient().verifyAutofix(
		{
			cells,
			targetCellIndex: cellIndex,
			patchedSource: input.patchedSource,
			assignmentId,
			// Per-cell execution timeout from settings, like the process path.
			timeout: settings.executor.cellTimeoutS,
		},
		// Whole-notebook re-runs need the per-notebook HTTP budget.
		settings.executor.notebookTimeoutMs,
	);
	return json(result);
}
