/**
 * @file Copilot analysis tools — per-cell explanation, error interpretation,
 *       and task-level comparison against the reference key.
 *
 * Three read-only tools (all permission "auto", no side effects):
 *
 *   analyze-code   — explain one executed cell (source + output/error) and
 *                    answer an optional teacher question.
 *   explain-error  — interpret one cell's execution error in plain language
 *                    for a teacher: likely cause, relation to earlier cells,
 *                    one concrete next step.
 *   compare-to-key — task-level comparison of the submission's executed
 *                    cells against the reference key notebook at
 *                    <DATA_DIR>/materials/<assignmentId>/ (key.ipynb).
 *
 * All three call KI Connect chatCompletion with a strict JSON envelope and
 * throw a helpful Error when KI Connect fails (throws, or returns nothing
 * usable) — the agent loop surfaces failures as tool-result ok:false and
 * never fabricates a result. Prompts stay bounded: full cell sources are
 * capped, comparison/context cells are previews.
 *
 * This module runs only on the SvelteKit server (`$lib/server/`).
 */

import { readFile, readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";

import { z } from "zod";

import type { ExecutedCell } from "$lib/server/executor-client";
import { getKiConnectClient } from "$lib/server/ki-connect";
import { assertSafeSegment, getDataDir, readMetadata } from "$lib/server/metadata";
import { readResults, type StoredExecutionResult } from "$lib/server/results-store";
import type { CopilotRegistry, CopilotTool, ToolContext } from "$lib/server/copilot/registry";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Cap on a cell source shown in full (analyze-code / explain-error). */
const MAX_FULL_SOURCE_CHARS = 4000;
/** Cap on output/error/traceback text shown in full. */
const MAX_OUTPUT_CHARS = 2000;
/** Cap on one cell source preview (comparison + earlier-cell context). */
const MAX_PREVIEW_CHARS = 400;
/** Cap on previewed cells so comparison prompts stay bounded. */
const MAX_PREVIEW_CELLS = 25;
/** Cap on earlier-cell context previews for explain-error. */
const MAX_CONTEXT_CELLS = 5;

const ANALYZE_SYSTEM_PROMPT =
	"You are an expert programming teaching assistant explaining a Jupyter notebook cell from a student submission. " +
	"Explain what the code does, note any issues, and answer the teacher's question. " +
	"Respond with a JSON object containing exactly one field: explanation (a markdown string).";

const EXPLAIN_ERROR_SYSTEM_PROMPT =
	"You are an expert programming teaching assistant interpreting an execution error in a Jupyter notebook cell from a student submission. " +
	"Explain the error in plain language for a teacher: the likely cause, how it relates to earlier cells, and one concrete next step the student can take. " +
	"Respond with a JSON object containing exactly one field: explanation (a markdown string).";

const COMPARE_SYSTEM_PROMPT =
	"You are an expert programming teaching assistant comparing a student's Jupyter notebook submission with the reference key for a Scientific Programming assignment. " +
	"Describe, in plain language for a teacher, what the reference key does for this task and how the student's approach differs from it. " +
	"Frame the comparison neutrally: a different approach is a different way of solving the same problem, not inherently wrong. " +
	"Respond with a JSON object containing exactly one field: comparison (a markdown string).";

// ---------------------------------------------------------------------------
// Args schemas (Zod 4)
// ---------------------------------------------------------------------------

const analyzeCodeArgsSchema = z.object({
	submissionId: z.string().optional(),
	cellIndex: z.number().int().nonnegative().optional(),
	question: z.string().optional(),
});
type AnalyzeCodeArgs = z.infer<typeof analyzeCodeArgsSchema>;

const explainErrorArgsSchema = z.object({
	submissionId: z.string().optional(),
	cellIndex: z.number().int().nonnegative(),
});
type ExplainErrorArgs = z.infer<typeof explainErrorArgsSchema>;

const compareToKeyArgsSchema = z.object({
	submissionId: z.string().optional(),
	taskTitle: z.string().optional(),
});
type CompareToKeyArgs = z.infer<typeof compareToKeyArgsSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Truncate long text with an ellipsis marker so prompts stay bounded. */
function truncate(text: string, maxChars: number, marker = "\n… [truncated]"): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}${marker}`;
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
	return err instanceof Error && "code" in err;
}

/** True for key.ipynb or the <name>_key.ipynb convention (mirrors the materials route). */
function isKeyNotebookName(name: string): boolean {
	const lower = name.toLowerCase();
	return lower === "key.ipynb" || lower.endsWith("_key.ipynb");
}

function assertNotAborted(ctx: ToolContext): void {
	if (ctx.signal.aborted) {
		throw new Error("Tool call aborted before it could run");
	}
}

interface ResolvedTarget {
	assignmentId: string;
	submissionId: string;
}

/**
 * Resolve the target submission: the explicit arg wins, otherwise the
 * context submissionId. The assignment comes from the context when wired,
 * otherwise by scanning the metadata.json files under the submissions dir.
 */
async function resolveTarget(
	argsSubmissionId: string | undefined,
	ctx: ToolContext,
): Promise<ResolvedTarget> {
	const submissionId = argsSubmissionId || ctx.submissionId;
	if (!submissionId) {
		throw new Error(
			"No submissionId provided — pass it in the tool arguments or run the tool from a submission context",
		);
	}
	const assignmentId = ctx.assignmentId ?? (await findAssignmentForSubmission(submissionId));
	return { assignmentId, submissionId };
}

/**
 * Find which assignment a submission belongs to by scanning each assignment's
 * metadata.json for the student id. Throws a clear error when no assignment
 * knows the submission.
 */
async function findAssignmentForSubmission(submissionId: string): Promise<string> {
	const submissionsRoot = path.join(getDataDir(), "submissions");
	let entries: Dirent[];
	try {
		entries = await readdir(submissionsRoot, { withFileTypes: true });
	} catch (err) {
		if (isNodeError(err) && err.code === "ENOENT") {
			throw new Error(
				`No submissions directory found under DATA_DIR — cannot resolve submission "${submissionId}" to an assignment`,
				{ cause: err },
			);
		}
		throw err;
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		try {
			const records = await readMetadata(entry.name);
			if (submissionId in records) return entry.name;
		} catch {
			// Unreadable/corrupt metadata — skip this assignment and keep scanning.
			continue;
		}
	}
	throw new Error(`Submission "${submissionId}" was not found in any assignment under DATA_DIR`);
}

async function loadStoredResult(
	assignmentId: string,
	submissionId: string,
): Promise<StoredExecutionResult> {
	const results = await readResults(assignmentId);
	const result = results[submissionId];
	if (!result) {
		throw new Error(
			`No stored execution result for submission "${submissionId}" in assignment "${assignmentId}" — execute the notebook first`,
		);
	}
	return result;
}

function executedCellsOf(result: StoredExecutionResult): ExecutedCell[] {
	return Array.isArray(result.cells) ? result.cells : [];
}

/** Default cell when none is requested: first errored code cell, else first code cell. */
function pickDefaultCellIndex(cells: ExecutedCell[]): number {
	if (cells.length === 0) {
		throw new Error("The submission has no executed cells to analyze");
	}
	const errored = cells.find((c) => c.type === "code" && c.error);
	if (errored) return errored.index;
	const firstCode = cells.find((c) => c.type === "code");
	return firstCode?.index ?? cells[0]!.index;
}

function getExecutedCell(
	cells: ExecutedCell[],
	cellIndex: number,
	submissionId: string,
): ExecutedCell {
	const cell = cells.find((c) => c.index === cellIndex);
	if (!cell) {
		throw new Error(
			`Cell ${cellIndex} not found in submission "${submissionId}" (${cells.length} executed cell${
				cells.length === 1 ? "" : "s"
			} available)`,
		);
	}
	return cell;
}

/** One cell, fully: bounded source plus output/error (analyze-code). */
function formatCellForPrompt(cell: ExecutedCell): string {
	const language = cell.type === "code" ? "python" : "markdown";
	const lines: string[] = [
		`Cell ${cell.index} (${cell.type}):`,
		"",
		`\`\`\`${language}`,
		truncate(cell.source, MAX_FULL_SOURCE_CHARS),
		"```",
	];
	if (cell.output.trim().length > 0 || !cell.error) {
		lines.push(
			"",
			"Output:",
			"```",
			truncate(cell.output || "(no output)", MAX_OUTPUT_CHARS),
			"```",
		);
	}
	if (cell.error) {
		lines.push("", "Error:", "```", truncate(cell.error, MAX_OUTPUT_CHARS), "```");
	}
	return lines.join("\n");
}

/** Bounded one-cell-per-block previews for multi-cell context. */
function formatCellPreviews(
	cells: Array<{ index?: number; type: string; source: string; error?: string | null }>,
	maxChars: number,
): string {
	const shown = cells.slice(0, MAX_PREVIEW_CELLS);
	const lines: string[] = [];
	for (const cell of shown) {
		lines.push(`[Cell ${cell.index ?? "?"}] ${cell.type}`);
		if (cell.error) lines.push(`error: ${truncate(cell.error, 200)}`);
		const preview = truncate(cell.source, maxChars);
		if (preview.trim().length > 0) lines.push(preview);
		lines.push("---");
	}
	if (cells.length > shown.length) {
		lines.push(`… ${cells.length - shown.length} more cell(s) omitted`);
	}
	return lines.join("\n");
}

/**
 * Call KI Connect chatCompletion with a strict JSON envelope and extract one
 * string field. Throws a helpful Error when the call fails or returns
 * nothing usable — the agent loop reports such failures as ok:false.
 */
async function callEnvelope(
	toolName: string,
	subject: string,
	system: string,
	user: string,
	field: "explanation" | "comparison",
): Promise<string> {
	let envelope: Record<string, unknown> | null | undefined;
	try {
		envelope = await getKiConnectClient().chatCompletion(system, user, 0.2, {
			type: "json_object",
		});
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		throw new Error(`KI Connect call failed for ${toolName} (${subject}): ${detail}`, {
			cause: err,
		});
	}
	const value = envelope?.[field];
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`KI Connect returned no ${field} for ${toolName} (${subject})`);
	}
	return value;
}

// ---------------------------------------------------------------------------
// Key notebook loading
// ---------------------------------------------------------------------------

interface KeyCell {
	type: "code" | "markdown";
	source: string;
}

/** Parse a Jupyter notebook JSON into {type, source} cells. */
function parseNotebookCells(parsed: unknown): KeyCell[] {
	if (
		!parsed ||
		typeof parsed !== "object" ||
		!Array.isArray((parsed as { cells?: unknown }).cells)
	) {
		throw new Error("Reference key is not a valid Jupyter notebook (missing cells array)");
	}
	const rawCells = (parsed as { cells: Array<{ cell_type?: unknown; source?: unknown }> }).cells;
	return rawCells.map((cell) => {
		const source = Array.isArray(cell.source)
			? cell.source.join("")
			: typeof cell.source === "string"
				? cell.source
				: "";
		return { type: cell.cell_type === "markdown" ? "markdown" : "code", source };
	});
}

/**
 * Load the reference key notebook for an assignment:
 * <DATA_DIR>/materials/<assignmentId>/key.ipynb (or <name>_key.ipynb).
 */
async function loadKeyCells(assignmentId: string): Promise<{ fileName: string; cells: KeyCell[] }> {
	assertSafeSegment(assignmentId, "assignmentId");
	const materialsRoot = path.join(getDataDir(), "materials", assignmentId);
	let entries: Dirent[];
	try {
		entries = await readdir(materialsRoot, { withFileTypes: true });
	} catch (err) {
		if (isNodeError(err) && err.code === "ENOENT") {
			throw new Error(
				`No reference key notebook found: no materials directory for assignment "${assignmentId}"`,
				{ cause: err },
			);
		}
		throw err;
	}
	const keyEntry = entries.find((e) => !e.isDirectory() && isKeyNotebookName(e.name));
	if (!keyEntry) {
		throw new Error(
			`No reference key notebook (key.ipynb) found in materials for assignment "${assignmentId}"`,
		);
	}
	const raw = await readFile(path.join(materialsRoot, keyEntry.name), "utf-8");
	return { fileName: keyEntry.name, cells: parseNotebookCells(JSON.parse(raw) as unknown) };
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

async function runAnalyzeCode(args: AnalyzeCodeArgs, ctx: ToolContext): Promise<string> {
	assertNotAborted(ctx);
	const { assignmentId, submissionId } = await resolveTarget(args.submissionId, ctx);
	const result = await loadStoredResult(assignmentId, submissionId);
	const cells = executedCellsOf(result);
	const cellIndex = args.cellIndex ?? pickDefaultCellIndex(cells);
	const cell = getExecutedCell(cells, cellIndex, submissionId);

	const userParts = [
		`Submission: ${submissionId} (assignment: ${assignmentId})`,
		formatCellForPrompt(cell),
	];
	if (args.question && args.question.trim().length > 0) {
		userParts.push("", `Teacher question: ${args.question.trim()}`);
	}
	return callEnvelope(
		"analyze-code",
		`cell ${cellIndex} of submission "${submissionId}"`,
		ANALYZE_SYSTEM_PROMPT,
		userParts.join("\n"),
		"explanation",
	);
}

async function runExplainError(args: ExplainErrorArgs, ctx: ToolContext): Promise<string> {
	assertNotAborted(ctx);
	const { assignmentId, submissionId } = await resolveTarget(args.submissionId, ctx);
	const result = await loadStoredResult(assignmentId, submissionId);
	const cells = executedCellsOf(result);
	const cell = getExecutedCell(cells, args.cellIndex, submissionId);
	if (!cell.error) {
		throw new Error(
			`Cell ${args.cellIndex} of submission "${submissionId}" did not produce an error — nothing to interpret`,
		);
	}

	const earlier = cells.filter((c) => c.index < args.cellIndex).slice(-MAX_CONTEXT_CELLS);
	const language = cell.type === "code" ? "python" : "markdown";
	const userParts = [
		`Submission: ${submissionId} (assignment: ${assignmentId})`,
		"Earlier cells (context, truncated):",
		earlier.length > 0 ? formatCellPreviews(earlier, MAX_PREVIEW_CHARS) : "(no earlier cells)",
		`Failing cell ${cell.index} (${cell.type}) source:`,
		"",
		`\`\`\`${language}`,
		truncate(cell.source, MAX_FULL_SOURCE_CHARS),
		"```",
		"",
		"Error:",
		"```",
		truncate(cell.error, MAX_OUTPUT_CHARS),
		"```",
	];
	if (Array.isArray(cell.traceback) && cell.traceback.length > 0) {
		userParts.push(
			"",
			"Traceback (truncated):",
			"```",
			truncate(cell.traceback.join("\n"), MAX_OUTPUT_CHARS),
			"```",
		);
	}
	return callEnvelope(
		"explain-error",
		`cell ${cell.index} of submission "${submissionId}"`,
		EXPLAIN_ERROR_SYSTEM_PROMPT,
		userParts.join("\n"),
		"explanation",
	);
}

async function runCompareToKey(args: CompareToKeyArgs, ctx: ToolContext): Promise<string> {
	assertNotAborted(ctx);
	const { assignmentId, submissionId } = await resolveTarget(args.submissionId, ctx);
	const result = await loadStoredResult(assignmentId, submissionId);
	const cells = executedCellsOf(result);
	const key = await loadKeyCells(assignmentId);

	const studentPreview = formatCellPreviews(cells, MAX_PREVIEW_CHARS);
	const keyPreview = formatCellPreviews(key.cells, MAX_PREVIEW_CHARS);
	const taskFocus = args.taskTitle?.trim() || "(whole notebook)";

	const userParts = [
		`Assignment: ${assignmentId}`,
		`Task focus: ${taskFocus}`,
		"",
		`Student submission "${submissionId}" — ${cells.length} executed cell(s), ${result.errorCells ?? 0} error(s):`,
		studentPreview || "(no executed cells)",
		"",
		`Reference key (materials/${assignmentId}/${key.fileName}) — ${key.cells.length} cell(s):`,
		keyPreview || "(empty key notebook)",
	];
	return callEnvelope(
		"compare-to-key",
		`submission "${submissionId}" vs key for assignment "${assignmentId}"`,
		COMPARE_SYSTEM_PROMPT,
		userParts.join("\n"),
		"comparison",
	);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const analyzeCodeTool: CopilotTool<AnalyzeCodeArgs, string> = {
	name: "analyze-code",
	description:
		"Explain one executed cell of the submission: what the code does, any issues, and an optional teacher question. Returns a markdown explanation.",
	permission: "auto",
	inputSchema: analyzeCodeArgsSchema,
	run: runAnalyzeCode,
};

const explainErrorTool: CopilotTool<ExplainErrorArgs, string> = {
	name: "explain-error",
	description:
		"Interpret the execution error of one cell of the submission in plain language for a teacher: likely cause, relation to earlier cells, and one concrete next step. Returns a markdown explanation.",
	permission: "auto",
	inputSchema: explainErrorArgsSchema,
	run: runExplainError,
};

const compareToKeyTool: CopilotTool<CompareToKeyArgs, string> = {
	name: "compare-to-key",
	description:
		"Compare the submission's executed cells with the reference key notebook of the assignment at the task level, in neutral language. Returns a markdown comparison.",
	permission: "auto",
	inputSchema: compareToKeyArgsSchema,
	run: runCompareToKey,
};

/** Register the copilot analysis tools (analyze-code, explain-error, compare-to-key). */
export function registerAnalysisTools(registry: CopilotRegistry): void {
	// Idempotent: skip tools already registered (buildAgent can re-run after
	// __resetAgentForTests, and the registry rejects duplicate names).
	const existing = new Set(registry.list().map((t) => t.name));
	for (const tool of [analyzeCodeTool, explainErrorTool, compareToKeyTool]) {
		if (!existing.has(tool.name)) registry.register(tool);
	}
}
