/**
 * @file Copilot reference + ops-read tools (Phase 4b).
 *
 * Read-only inspection tools the copilot agent uses to ground its answers:
 *
 *   get-reference-key      — bounded view of the assignment's key notebook
 *                            (<DATA_DIR>/materials/<assignment>/key.ipynb).
 *                            Never returns the raw file — per-cell source is
 *                            capped at SOURCE_PREVIEW_LINES lines.
 *   get-plagiarism-report  — cached plagiarism pairs for an assignment
 *                            (data/plagiarism/<assignment>.json), with the
 *                            derived severity + resolved review status and an
 *                            unreviewed pair count.
 *   get-pipeline-status    — live batch-process progress (process-progress.ts)
 *                            with computed per-notebook + total elapsed.
 *   get-executor-logs      — recent executor pipeline log lines via the same
 *                            ExecutorClient.fetchLogs() the /api/executor/logs
 *                            route proxies (limit clamped 1..1000, default 200).
 *
 * All four tools are permission "auto" (read-only, no side effects) and do no
 * I/O at module top level — everything happens inside run().
 */

import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import type { CopilotRegistry, CopilotTool } from "../registry";
import { getExecutorClient } from "../../executor-client";
import { assertSafeSegment, getDataDir } from "../../metadata";
import { readPlagiarismResult } from "../../plagiarism/cache";
import { classifyPair, reviewStatusOf, type PlagiarismPair } from "../../plagiarism/structural";
import { getProcessRun } from "../../process-progress";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const SOURCE_PREVIEW_LINES = 40;
const TRUNCATION_MARKER = "… (truncated)";

/** First ~40 lines of a cell source, with an explicit truncation marker. */
function previewSource(source: string): { sourcePreview: string; sourceTruncated: boolean } {
	const lines = source.split("\n");
	if (lines.length <= SOURCE_PREVIEW_LINES) {
		return { sourcePreview: source, sourceTruncated: false };
	}
	return {
		sourcePreview: `${lines.slice(0, SOURCE_PREVIEW_LINES).join("\n")}\n${TRUNCATION_MARKER}`,
		sourceTruncated: true,
	};
}

/** Normalize a Jupyter cell source (string or array of lines) to one string. */
function cellSourceOf(source: unknown): string {
	if (Array.isArray(source)) return source.join("");
	if (typeof source === "string") return source;
	return "";
}

// ---------------------------------------------------------------------------
// get-reference-key
// ---------------------------------------------------------------------------

/** Bounded per-cell summary — never the raw cell payload. */
interface ReferenceKeyCellSummary {
	/** 0-based position in the notebook. */
	index: number;
	cell_type: "code" | "markdown";
	/** First SOURCE_PREVIEW_LINES lines of the cell source. */
	sourcePreview: string;
	/** True when the source was longer than the preview (marker appended). */
	sourceTruncated: boolean;
	/** Markdown text preview — present for markdown cells only. */
	text?: string;
}

interface ReferenceKeyResult {
	assignmentId: string;
	/** True when a key notebook was found and parsed. */
	found: boolean;
	/** Human-readable note when the key is missing or unreadable. */
	note?: string;
	cellCount: number;
	cells: ReferenceKeyCellSummary[];
}

/** True for key.ipynb or the <name>_key.ipynb convention used in sample data. */
function isKeyNotebook(name: string): boolean {
	const lower = name.toLowerCase();
	return lower === "key.ipynb" || lower.endsWith("_key.ipynb");
}

/**
 * Locate the assignment's key notebook: key.ipynb first (canonical upload
 * name), then any `<name>_key.ipynb` in the materials root. Returns null
 * when no key exists.
 */
async function resolveKeyPath(assignmentId: string): Promise<string | null> {
	const materialsRoot = path.join(getDataDir(), "materials", assignmentId);
	const primary = path.join(materialsRoot, "key.ipynb");
	try {
		await access(primary);
		return primary;
	} catch {
		// Fall through to the <name>_key.ipynb convention.
	}
	try {
		const entries = await readdir(materialsRoot, { withFileTypes: true });
		const key = entries.find((entry) => entry.isFile() && isKeyNotebook(entry.name));
		return key ? path.join(materialsRoot, key.name) : null;
	} catch {
		return null; // materials dir missing entirely
	}
}

const getReferenceKeyTool: CopilotTool<{ assignmentId: string }, ReferenceKeyResult> = {
	name: "get-reference-key",
	description:
		"Return a bounded summary of the assignment's reference key notebook: cell count and, per cell, " +
		"the type, a preview of the first ~40 source lines (truncation-marked) and the markdown text. " +
		"Useful to compare a submission's approach against the intended solution. Returns a note when " +
		"no key notebook has been uploaded.",
	permission: "auto",
	inputSchema: z.object({ assignmentId: z.string().min(1) }),
	run: async (args) => {
		const { assignmentId } = args;
		assertSafeSegment(assignmentId, "assignmentId");

		const keyPath = await resolveKeyPath(assignmentId);
		if (!keyPath) {
			return {
				assignmentId,
				found: false,
				note: `Reference key notebook not found under ${path.join(getDataDir(), "materials", assignmentId)} — upload key.ipynb via the assignment materials endpoint first`,
				cellCount: 0,
				cells: [],
			};
		}

		let raw: string;
		try {
			raw = await readFile(keyPath, "utf-8");
		} catch (err) {
			return {
				assignmentId,
				found: false,
				note: `Reference key notebook at ${keyPath} could not be read: ${(err as Error).message}`,
				cellCount: 0,
				cells: [],
			};
		}

		let notebook: unknown;
		try {
			notebook = JSON.parse(raw);
		} catch (err) {
			return {
				assignmentId,
				found: false,
				note: `Reference key notebook at ${keyPath} is not valid JSON: ${(err as Error).message}`,
				cellCount: 0,
				cells: [],
			};
		}

		const cells = (notebook as { cells?: unknown } | null)?.cells;
		if (!Array.isArray(cells)) {
			return {
				assignmentId,
				found: false,
				note: `Reference key notebook at ${keyPath} has no cells array (not a Jupyter notebook)`,
				cellCount: 0,
				cells: [],
			};
		}

		const summaries: ReferenceKeyCellSummary[] = cells.map(
			(cell: unknown, index: number): ReferenceKeyCellSummary => {
				const rawCell = (cell ?? {}) as { cell_type?: unknown; source?: unknown };
				const cellType = rawCell.cell_type === "markdown" ? "markdown" : "code";
				const source = cellSourceOf(rawCell.source);
				const { sourcePreview, sourceTruncated } = previewSource(source);
				const summary: ReferenceKeyCellSummary = {
					index,
					cell_type: cellType,
					sourcePreview,
					sourceTruncated,
				};
				if (cellType === "markdown") summary.text = sourcePreview;
				return summary;
			},
		);

		return { assignmentId, found: true, cellCount: cells.length, cells: summaries };
	},
};

// ---------------------------------------------------------------------------
// get-plagiarism-report
// ---------------------------------------------------------------------------

interface PlagiarismPairSummary {
	studentA: string;
	studentB: string;
	/** Derived severity: high | medium | low | none (classifyPair). */
	severity: "high" | "medium" | "low" | "none";
	/** 0..1 — fraction of the smaller notebook's cells with a match. */
	cellOverlap: number;
	/** 0..1 — Jaccard of whole-notebook token n-gram sets. */
	notebookOverlap: number;
	/** unreviewed | accepted | dismissed | ignored (absent = unreviewed). */
	reviewStatus: "unreviewed" | "accepted" | "dismissed" | "ignored";
}

interface PlagiarismReportResult {
	assignmentId: string;
	/** True when a cached result exists. */
	found: boolean;
	/** Human-readable note when no check has been run. */
	note?: string;
	status?: "pending" | "checking" | "done" | "error";
	generatedAt?: string;
	totalPairs?: number;
	comparedSubmissions?: string[];
	semanticChecked?: boolean;
	pairs: PlagiarismPairSummary[];
	/** Number of pairs still marked unreviewed. */
	unreviewedCount: number;
}

function summarizePair(pair: PlagiarismPair): PlagiarismPairSummary {
	return {
		studentA: pair.studentA,
		studentB: pair.studentB,
		severity: classifyPair(pair),
		cellOverlap: pair.cellOverlap,
		notebookOverlap: pair.notebookOverlap,
		reviewStatus: reviewStatusOf(pair),
	};
}

const getPlagiarismReportTool: CopilotTool<{ assignmentId: string }, PlagiarismReportResult> = {
	name: "get-plagiarism-report",
	description:
		"Return the cached plagiarism comparison for an assignment: each flagged pair with students, " +
		"derived severity (high/medium/low/none), cell + notebook overlap, and review status " +
		"(unreviewed/accepted/dismissed/ignored), plus the number of unreviewed pairs. Returns a note " +
		"when no check has been run yet.",
	permission: "auto",
	inputSchema: z.object({ assignmentId: z.string().min(1) }),
	run: async (args) => {
		const { assignmentId } = args;
		assertSafeSegment(assignmentId, "assignmentId");

		const result = await readPlagiarismResult(assignmentId);
		if (!result) {
			return {
				assignmentId,
				found: false,
				note: `No plagiarism results cached for "${assignmentId}" — run the plagiarism check first`,
				pairs: [],
				unreviewedCount: 0,
			};
		}

		const pairs = result.pairs.map(summarizePair);
		const unreviewedCount = pairs.filter((pair) => pair.reviewStatus === "unreviewed").length;

		return {
			assignmentId,
			found: true,
			status: result.status,
			generatedAt: result.generatedAt,
			totalPairs: result.totalPairs,
			comparedSubmissions: result.comparedSubmissions,
			semanticChecked: result.semanticChecked ?? false,
			pairs,
			unreviewedCount,
		};
	},
};

// ---------------------------------------------------------------------------
// get-pipeline-status
// ---------------------------------------------------------------------------

interface PipelineStatusResult {
	/** True while a batch process run is in flight. */
	running: boolean;
	assignmentId: string | null;
	/** Notebooks settled (executed or error). */
	done: number;
	/** Total notebooks targeted by the run. */
	total: number;
	/** Student id of the notebook currently executing (null when idle). */
	currentNotebook: string | null;
	/** Epoch ms since the current notebook started (null when idle). */
	currentElapsedMs: number | null;
	/** Epoch ms since the run started (null when idle). */
	totalElapsedMs: number | null;
	/** Automatic autofix re-run tallies; null when the run had none. */
	autoFixCounts: { attempts: number; succeeded: number } | null;
}

const getPipelineStatusTool: CopilotTool<Record<string, never>, PipelineStatusResult> = {
	name: "get-pipeline-status",
	description:
		"Return the current batch process pipeline state: running flag, done/total notebook counts, " +
		"the notebook currently executing, per-notebook + total elapsed time, automatic autofix re-run " +
		"tallies, and the final counts of the last completed run.",
	permission: "auto",
	inputSchema: z.object({}),
	run: async () => {
		const state = getProcessRun();
		const now = Date.now();
		return {
			running: state.running,
			assignmentId: state.assignmentId,
			done: state.done,
			total: state.total,
			currentNotebook: state.currentStudentId,
			currentElapsedMs:
				state.running && state.currentStartedAt !== null
					? now - state.currentStartedAt
					: null,
			totalElapsedMs: state.startedAt !== null ? now - state.startedAt : null,
			autoFixCounts:
				state.autofixAttempts > 0 || state.autofixSucceeded > 0
					? { attempts: state.autofixAttempts, succeeded: state.autofixSucceeded }
					: null,
		};
	},
};

// ---------------------------------------------------------------------------
// get-executor-logs
// ---------------------------------------------------------------------------

const LOG_LIMIT_MIN = 1;
const LOG_LIMIT_MAX = 1000;
const LOG_LIMIT_DEFAULT = 200;

/** Clamp a requested log limit into the executor's accepted range. */
function clampLogLimit(limit: number | undefined): number {
	if (limit === undefined || !Number.isFinite(limit)) return LOG_LIMIT_DEFAULT;
	return Math.max(LOG_LIMIT_MIN, Math.min(Math.floor(limit), LOG_LIMIT_MAX));
}

const getExecutorLogsTool: CopilotTool<{ limit?: number }, unknown> = {
	name: "get-executor-logs",
	description:
		"Return recent pipeline log lines from the notebook executor (preprocessing, execution, " +
		"autofix, LLM calls), oldest → newest. Optional limit (clamped 1..1000, default 200); the " +
		"result includes entries + a truncated flag.",
	permission: "auto",
	inputSchema: z.object({ limit: z.number().optional() }),
	run: async (args) => {
		const limit = clampLogLimit(args.limit);
		// Same path as GET /api/executor/logs — the route proxies
		// getExecutorClient().fetchLogs(clamped) verbatim.
		const logs = await getExecutorClient().fetchLogs(limit);
		return { ...logs, limit };
	},
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register the reference + ops-read tools on a copilot registry. Call once at
 * server startup (agent.ts wires the grading tools separately).
 */
export function registerReferenceTools(registry: CopilotRegistry): void {
	// Idempotent: skip tools already registered (buildAgent can re-run after
	// __resetAgentForTests, and the registry rejects duplicate names).
	const existing = new Set(registry.list().map((t) => t.name));
	for (const tool of [
		getReferenceKeyTool,
		getPlagiarismReportTool,
		getPipelineStatusTool,
		getExecutorLogsTool,
	]) {
		if (!existing.has(tool.name)) registry.register(tool);
	}
}
