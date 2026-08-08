/**
 * @file Copilot OPS write tools (Phase 4d) — teacher operational actions.
 *
 *   process-submission     — execute ONE submission via the same path as
 *                            POST /api/submissions/[id]/process (permission
 *                            "approval").
 *   process-all            — batch-execute every pending + error submission of
 *                            an assignment, mirroring POST
 *                            /api/submissions/process (permission "approval"
 *                            AND listed in ALWAYS_ASK_COST — a batch of
 *                            executor runs is expensive; never unattended).
 *   run-plagiarism-check   — run the structural plagiarism comparison for an
 *                            assignment (the same service calls the check
 *                            route makes) and cache the result (approval).
 *   update-plagiarism-review — persist a pair's review status, matching the
 *                            PATCH /api/plagiarism/results body shape
 *                            (approval).
 *   archive-submission     — soft-archive a submission like POST
 *                            /api/submissions/[id]/archive (approval AND
 *                            destructive: true — HARD_DENY semantics; the
 *                            approval card is always shown).
 *
 * All five are permission "approval" (never auto), do no I/O at module top
 * level, and run() may throw — the agent loop converts failures into
 * tool-result ok:false. Both process tools refuse to start while a batch is
 * already running (process-progress.ts `running`).
 *
 * The batch/single execution loops replicate the route bodies (the routes
 * inline the logic; extracting a shared service would be a larger refactor —
 * the sanctioned alternative is to replicate the calls the routes make).
 *
 * This module runs only on the SvelteKit server (`$lib/server/`).
 */

import { z } from "zod";

import { assignmentExists, getAssignmentById, resolveAssignmentId } from "$lib/server/assignments";
import { getExecutorClient } from "$lib/server/executor-client";
import {
	archiveSubmission,
	getSubmission,
	listSubmissions,
	updateStatus,
	upsertSubmission,
} from "$lib/server/metadata";
import {
	setStudentPairReviewStatus,
	updatePairReviewStatus,
	writePlagiarismResult,
	type PlagiarismResult,
} from "$lib/server/plagiarism/cache";
import {
	compareAll,
	flagPairs,
	loadAssignmentNotebooks,
	type PairReviewStatus,
} from "$lib/server/plagiarism/structural";
import {
	beginProcessRun,
	endProcessRun,
	getProcessRun,
	updateProcessRun,
} from "$lib/server/process-progress";
import {
	deriveCellSummary,
	setResult,
	type StoredExecutionResult,
} from "$lib/server/results-store";
import { loadSettings } from "$lib/server/settings";

import type { CopilotRegistry, CopilotTool, ToolContext } from "../registry";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Same fallback chain as the other tool modules: arg, then ctx, then first enabled. */
async function resolveAssignmentIdForTool(
	arg: string | undefined,
	ctx: ToolContext,
	toolName: string,
): Promise<string> {
	const assignmentId =
		arg?.trim() || ctx.assignmentId?.trim() || (await resolveAssignmentId(null));
	if (!assignmentId) {
		throw new Error(`${toolName}: no assignmentId given and no assignment is configured`);
	}
	return assignmentId;
}

/**
 * Both process tools are mutually exclusive with a running batch: the batch
 * loop owns process-progress state and submission statuses, so a second
 * concurrent run would corrupt the pipeline. Refuse loudly instead.
 */
function assertNoBatchRunning(toolName: string): void {
	if (getProcessRun().running) {
		throw new Error(
			`${toolName}: a batch process is already running — wait for it to finish (see get-pipeline-status) before starting another`,
		);
	}
}

/** First cell-level error message, or null when all cells executed. */
function firstCellError(cells: unknown[]): string | null {
	for (const cell of cells) {
		const error = (cell as { error?: string | null }).error;
		if (typeof error === "string" && error.length > 0) return error;
	}
	return null;
}

const EMPTY_PREPROCESSING = {
	cellsModified: 0,
	totalEdits: 0,
	editTypes: {},
	llmPreprocessing: "skipped",
	llmAnalysis: false,
} as const;

// ---------------------------------------------------------------------------
// process-submission
// ---------------------------------------------------------------------------

const processSubmissionArgsSchema = z.object({
	/** Student id of the submission. Falls back to ctx.submissionId. */
	submissionId: z.string().optional(),
	/** Assignment id; falls back to ctx.assignmentId, then the first enabled one. */
	assignmentId: z.string().optional(),
});
type ProcessSubmissionArgs = z.infer<typeof processSubmissionArgsSchema>;

interface ProcessSubmissionResult {
	submissionId: string;
	assignmentId: string;
	success: true;
	status: "executed";
	totalCells: number;
	executedCells: number;
	errorCells: number;
	durationSeconds: number;
	/** Automatic autofix re-run tallies from the executor. */
	autofix: { attempts: number; succeeded: number };
	cellSummary?: string;
}

/**
 * Execute ONE submission: identical semantics to POST
 * /api/submissions/[id]/process — resolves the record, transitions
 * -> executing -> executed | error, stores the full result, and throws with
 * the failure message (after marking the record error) when execution fails.
 */
const processSubmissionTool: CopilotTool<ProcessSubmissionArgs, ProcessSubmissionResult> = {
	name: "process-submission",
	description:
		"Execute ONE submission through the notebook executor (same behavior as the per-submission process endpoint): " +
		"runs the notebook, stores the execution result, and transitions the record pending/error/executed -> executed, " +
		"or -> error when execution fails (the tool then throws). Refuses to start while a batch process is running. " +
		"Returns a summary with cell counts, duration, autofix tallies and the derived cell summary.",
	permission: "approval",
	inputSchema: processSubmissionArgsSchema,
	run: async (args, ctx) => {
		const submissionId = args.submissionId?.trim() || ctx.submissionId?.trim();
		if (!submissionId) {
			throw new Error(
				"process-submission requires a submissionId (tool argument or submission context)",
			);
		}
		const assignmentId = await resolveAssignmentIdForTool(
			args.assignmentId,
			ctx,
			"process-submission",
		);
		assertNoBatchRunning("process-submission");
		if (ctx.signal.aborted) {
			throw new Error("process-submission aborted before execution started");
		}

		if (!(await assignmentExists(assignmentId))) {
			throw new Error(`process-submission: assignment "${assignmentId}" not found`);
		}
		const record = await getSubmission(assignmentId, submissionId);
		if (!record) {
			throw new Error(
				`process-submission: submission "${submissionId}" not found in assignment "${assignmentId}"`,
			);
		}
		if (record.status === "executing") {
			throw new Error(
				`process-submission: submission "${submissionId}" is already executing`,
			);
		}

		const assignment = await getAssignmentById(assignmentId);
		const assignmentContext = assignment?.title ?? null;

		try {
			await updateStatus(assignmentId, submissionId, "executing");
			const result = await getExecutorClient().executeNotebook({
				notebookPath: record.notebookPath,
				assignmentContext,
			});

			await updateStatus(assignmentId, submissionId, "executed");
			await setResult(assignmentId, submissionId, { ...result, error: null });
			const updated = await upsertSubmission(assignmentId, submissionId, {
				cellSummary: deriveCellSummary(result),
				error: null,
			});

			return {
				submissionId,
				assignmentId,
				success: true,
				status: "executed",
				totalCells: result.totalCells,
				executedCells: result.executedCells,
				errorCells: result.errorCells,
				durationSeconds: result.durationSeconds,
				autofix: result.autofix,
				cellSummary: updated.cellSummary,
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			try {
				await updateStatus(assignmentId, submissionId, "error");
				await upsertSubmission(assignmentId, submissionId, { error: message });
			} catch {
				// record may already be in the error state — keep the original error
			}
			throw new Error(
				`process-submission: execution failed for "${submissionId}": ${message}`,
				{ cause: err },
			);
		}
	},
};

// ---------------------------------------------------------------------------
// process-all
// ---------------------------------------------------------------------------

const processAllArgsSchema = z.object({
	/** Assignment id; falls back to ctx.assignmentId, then the first enabled one. */
	assignmentId: z.string().optional(),
});
type ProcessAllArgs = z.infer<typeof processAllArgsSchema>;

interface ProcessAllRow {
	studentId: string;
	success: boolean;
	/** Set when the row failed; a row failure never aborts the loop. */
	error: string | null;
}

interface ProcessAllResult {
	assignmentId: string;
	/** Number of runnable targets (pending + error). */
	submitted: number;
	succeeded: number;
	failed: number;
	totalDurationSeconds: number;
	autofixAttempts: number;
	autofixSucceeded: number;
	results: ProcessAllRow[];
}

/**
 * Batch-execute every pending + error submission of an assignment — the same
 * per-notebook loop as POST /api/submissions/process: each row runs one at a
 * time through the executor with the per-notebook HTTP budget, transitions
 * executing -> executed | error as it finishes, and writes progress to
 * process-progress.ts (the dashboard / get-pipeline-status observe it live).
 * One failing row never aborts the others.
 */
const processAllTool: CopilotTool<ProcessAllArgs, ProcessAllResult> = {
	name: "process-all",
	description:
		"Batch-execute EVERY pending (first run) and error (retry) submission of an assignment through the notebook executor " +
		"(expensive — one executor call per notebook; always approval-gated). Runs notebooks one at a time with live progress " +
		"via the process pipeline; each row is isolated, so a failing notebook does not abort the others. " +
		"Returns a per-submission summary with totals. Refuses to start while a batch process is already running.",
	permission: "approval",
	inputSchema: processAllArgsSchema,
	run: async (args, ctx) => {
		const assignmentId = await resolveAssignmentIdForTool(
			args.assignmentId,
			ctx,
			"process-all",
		);
		assertNoBatchRunning("process-all");
		if (ctx.signal.aborted) {
			throw new Error("process-all aborted before the batch started");
		}

		if (!(await assignmentExists(assignmentId))) {
			throw new Error(`process-all: assignment "${assignmentId}" not found`);
		}

		const records = await listSubmissions(assignmentId);
		// Runnable targets: pending (first run) and error (retry after a
		// failed run). Executing/executed/graded/archived are left untouched.
		const targets = records.filter((r) => r.status === "pending" || r.status === "error");

		if (targets.length === 0) {
			return {
				assignmentId,
				submitted: 0,
				succeeded: 0,
				failed: 0,
				totalDurationSeconds: 0,
				autofixAttempts: 0,
				autofixSucceeded: 0,
				results: [],
			};
		}

		const client = getExecutorClient();
		const settings = await loadSettings();
		const results: ProcessAllRow[] = [];
		const startedAt = Date.now();
		let autofixAttempts = 0;
		let autofixSucceeded = 0;

		beginProcessRun(assignmentId, targets.length);
		try {
			for (const target of targets) {
				if (ctx.signal.aborted) {
					throw new Error(
						`process-all aborted after ${results.length} of ${targets.length} submissions`,
					);
				}
				// pending/error -> executing so the pipeline shows the run in progress.
				await updateStatus(assignmentId, target.id, "executing");
				updateProcessRun({
					currentStudentId: target.id,
					currentStartedAt: Date.now(),
				});

				try {
					const execution = await client.executeNotebook(
						{
							notebookPath: target.notebookPath,
							// assignmentContext intentionally omitted — a batch run
							// stays deterministic (same as the batch route).
						},
						undefined,
						// A batch row gets the per-notebook budget (settings), not
						// the tighter single-request default.
						{ requestTimeoutMs: settings.executor.notebookTimeoutMs },
					);
					const duration = execution.durationSeconds;
					autofixAttempts += execution.autofix.attempts;
					autofixSucceeded += execution.autofix.succeeded;

					if (execution.success) {
						await updateStatus(assignmentId, target.id, "executed");
						const stored: StoredExecutionResult = {
							success: true,
							notebookPath: target.notebookPath,
							cells: execution.cells,
							fixedCells: execution.fixedCells,
							totalCells: execution.totalCells,
							executedCells: execution.executedCells,
							errorCells: execution.errorCells,
							durationSeconds: duration,
							preprocessing: execution.preprocessing ?? EMPTY_PREPROCESSING,
							modifiedFiles: execution.modifiedFiles ?? [],
							autofix: execution.autofix,
						};
						await setResult(assignmentId, target.id, stored);
						await upsertSubmission(assignmentId, target.id, {
							cellSummary: deriveCellSummary(stored),
							error: null,
						});
						results.push({ studentId: target.id, success: true, error: null });
					} else {
						const message = firstCellError(execution.cells) ?? "Execution failed";
						await updateStatus(assignmentId, target.id, "error");
						await upsertSubmission(assignmentId, target.id, { error: message });
						await setResult(assignmentId, target.id, {
							success: false,
							notebookPath: target.notebookPath,
							cells: execution.cells,
							fixedCells: execution.fixedCells,
							totalCells: execution.totalCells,
							executedCells: execution.executedCells,
							errorCells: execution.errorCells,
							durationSeconds: duration,
							preprocessing: execution.preprocessing ?? EMPTY_PREPROCESSING,
							modifiedFiles: execution.modifiedFiles ?? [],
							error: message,
							autofix: execution.autofix,
						});
						results.push({ studentId: target.id, success: false, error: message });
					}
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					await updateStatus(assignmentId, target.id, "error");
					await upsertSubmission(assignmentId, target.id, { error: message });
					results.push({ studentId: target.id, success: false, error: message });
				}
				updateProcessRun({
					done: results.length,
					autofixAttempts,
					autofixSucceeded,
				});
			}
		} finally {
			endProcessRun();
		}

		const totalDurationSeconds = (Date.now() - startedAt) / 1000;

		return {
			assignmentId,
			submitted: targets.length,
			succeeded: results.filter((r) => r.success).length,
			failed: results.filter((r) => !r.success).length,
			totalDurationSeconds,
			autofixAttempts,
			autofixSucceeded,
			results,
		};
	},
};

// ---------------------------------------------------------------------------
// run-plagiarism-check
// ---------------------------------------------------------------------------

const runPlagiarismCheckArgsSchema = z.object({
	/** Assignment id; falls back to ctx.assignmentId, then the first enabled one. */
	assignmentId: z.string(),
});
type RunPlagiarismCheckArgs = z.infer<typeof runPlagiarismCheckArgsSchema>;

/** Summary of a completed check — the cached result shape plus flagged count. */
type RunPlagiarismCheckResult = PlagiarismResult & { flaggedCount: number };

/**
 * Run the structural plagiarism comparison for an assignment — the same
 * service calls the POST /api/plagiarism/check route makes (load notebooks,
 * compareAll, flagPairs) — and persist the result to the plagiarism cache.
 * The semantic (LLM) pass is not run by this tool (structural only, same as
 * the route's default).
 */
const runPlagiarismCheckTool: CopilotTool<RunPlagiarismCheckArgs, RunPlagiarismCheckResult> = {
	name: "run-plagiarism-check",
	description:
		"Run the plagiarism comparison for an assignment: load all submission notebooks, run the structural " +
		"(token n-gram) pairwise comparison, keep the flagged pairs, and cache the result. " +
		'Returns the cached-result shape (status "done", flagged pairs with overlap scores, compared submissions). ' +
		"Use get-plagiarism-report afterwards to see derived severity + review status per pair.",
	permission: "approval",
	inputSchema: runPlagiarismCheckArgsSchema,
	run: async (args, ctx) => {
		const assignmentId = args.assignmentId.trim();
		if (ctx.signal.aborted) {
			throw new Error("run-plagiarism-check aborted before the comparison started");
		}
		if (!(await assignmentExists(assignmentId))) {
			throw new Error(`run-plagiarism-check: assignment "${assignmentId}" not found`);
		}

		const notebooks = await loadAssignmentNotebooks(assignmentId);
		const allPairs = compareAll(notebooks);
		const flagged = flagPairs(allPairs);

		const result: PlagiarismResult = {
			status: "done",
			assignmentId,
			generatedAt: new Date().toISOString(),
			pairs: flagged,
			totalPairs: allPairs.length,
			comparedSubmissions: notebooks.map((n) => n.studentId).sort(),
			semanticChecked: false,
		};

		await writePlagiarismResult(assignmentId, result);
		return { ...result, flaggedCount: flagged.length };
	},
};

// ---------------------------------------------------------------------------
// update-plagiarism-review
// ---------------------------------------------------------------------------

const REVIEW_STATUSES = ["unreviewed", "accepted", "dismissed", "ignored"] as const;

const updatePlagiarismReviewArgsSchema = z.object({
	/** Assignment id; falls back to ctx.assignmentId, then the first enabled one. */
	assignmentId: z.string().optional(),
	/** First student of the pair (either order accepted, same as the PATCH route). */
	studentA: z.string().min(1),
	/** Second student of the pair (either order accepted, same as the PATCH route). */
	studentB: z.string().min(1),
	/** New review state of the pair. */
	reviewStatus: z.enum(REVIEW_STATUSES),
});
type UpdatePlagiarismReviewArgs = z.infer<typeof updatePlagiarismReviewArgsSchema>;

interface UpdatePlagiarismReviewResult {
	assignmentId: string;
	studentA: string;
	studentB: string;
	reviewStatus: PairReviewStatus;
	/** The updated pair as persisted in the cache. */
	pair: {
		studentA: string;
		studentB: string;
		cellOverlap: number;
		notebookOverlap: number;
		flags: string[];
		matchedCells: number;
		reviewStatus: PairReviewStatus;
	};
}

/**
 * Persist one pair's review status — same body shape as PATCH
 * /api/plagiarism/results (studentA/studentB either order + reviewStatus).
 * Throws when the assignment has no cached check or the pair does not exist.
 */
const updatePlagiarismReviewTool: CopilotTool<
	UpdatePlagiarismReviewArgs,
	UpdatePlagiarismReviewResult
> = {
	name: "update-plagiarism-review",
	description:
		'Set the review status of one plagiarism pair ("unreviewed" | "accepted" | "dismissed" | "ignored") for an assignment, ' +
		"matching the results PATCH endpoint — studentA + studentB identify the pair (either order accepted). " +
		"Persists the status in the cached plagiarism results and returns the updated pair. " +
		"Throws when no check has been run or the pair does not exist.",
	permission: "approval",
	inputSchema: updatePlagiarismReviewArgsSchema,
	run: async (args, ctx) => {
		const { studentA, studentB, reviewStatus } = args;
		const assignmentId = await resolveAssignmentIdForTool(
			args.assignmentId,
			ctx,
			"update-plagiarism-review",
		);
		if (ctx.signal.aborted) {
			throw new Error("update-plagiarism-review aborted before persisting");
		}
		if (!(await assignmentExists(assignmentId))) {
			throw new Error(`update-plagiarism-review: assignment "${assignmentId}" not found`);
		}

		const updated = await updatePairReviewStatus(
			assignmentId,
			studentA,
			studentB,
			reviewStatus,
		);
		if (!updated) {
			throw new Error(
				`update-plagiarism-review: pair "${studentA}" ↔ "${studentB}" not found in plagiarism results for "${assignmentId}" — run run-plagiarism-check first`,
			);
		}

		const pair = updated.pairs.find(
			(p) =>
				(p.studentA === studentA && p.studentB === studentB) ||
				(p.studentA === studentB && p.studentB === studentA),
		);
		if (!pair) {
			// updatePairReviewStatus persisted a matching pair; this only
			// happens if the cache changed between the two reads.
			throw new Error(
				`update-plagiarism-review: pair "${studentA}" ↔ "${studentB}" disappeared from the cached results`,
			);
		}

		return {
			assignmentId,
			studentA: pair.studentA,
			studentB: pair.studentB,
			reviewStatus: pair.reviewStatus ?? reviewStatus,
			pair: {
				studentA: pair.studentA,
				studentB: pair.studentB,
				cellOverlap: pair.cellOverlap,
				notebookOverlap: pair.notebookOverlap,
				flags: pair.flags,
				matchedCells: pair.matchedCells.length,
				reviewStatus: pair.reviewStatus ?? reviewStatus,
			},
		};
	},
};

// ---------------------------------------------------------------------------
// archive-submission
// ---------------------------------------------------------------------------

const archiveSubmissionArgsSchema = z.object({
	/** Student id of the submission. Falls back to ctx.submissionId. */
	submissionId: z.string().optional(),
	/** Assignment id; falls back to ctx.assignmentId, then the first enabled one. */
	assignmentId: z.string().optional(),
});
type ArchiveSubmissionArgs = z.infer<typeof archiveSubmissionArgsSchema>;

interface ArchiveSubmissionResult {
	assignmentId: string;
	submissionId: string;
	archived: true;
	status: "archived";
	/** Pre-archive status, restored by a later restore action. */
	archivedFrom: string;
	/** The persisted record (status, error, cellSummary, …). */
	record: {
		status: string;
		archivedFrom?: string;
		error?: string | null;
		cellSummary?: string;
	};
}

/**
 * Soft-archive a submission — same semantics as POST
 * /api/submissions/[id]/archive: the record is hidden from the active batch
 * (dashboard, Process All, plagiarism checks) but the notebook + grading stay
 * on disk; the pre-archive status is remembered for a later restore. The
 * student's plagiarism pairs are marked ignored (best-effort, like the route).
 * Destructive: declared destructive: true so the approval policy always asks.
 */
const archiveSubmissionTool: CopilotTool<ArchiveSubmissionArgs, ArchiveSubmissionResult> = {
	name: "archive-submission",
	description:
		"Archive (soft-remove) ONE submission from the active batch: it disappears from the dashboard, batch processing and " +
		"plagiarism checks, while the notebook and grading stay on disk and the pre-archive status is remembered (restorable). " +
		"Destructive teacher action — always requires explicit approval.",
	permission: "approval",
	destructive: true,
	inputSchema: archiveSubmissionArgsSchema,
	run: async (args, ctx) => {
		const submissionId = args.submissionId?.trim() || ctx.submissionId?.trim();
		if (!submissionId) {
			throw new Error(
				"archive-submission requires a submissionId (tool argument or submission context)",
			);
		}
		const assignmentId = await resolveAssignmentIdForTool(
			args.assignmentId,
			ctx,
			"archive-submission",
		);
		if (ctx.signal.aborted) {
			throw new Error("archive-submission aborted before archiving");
		}
		if (!(await assignmentExists(assignmentId))) {
			throw new Error(`archive-submission: assignment "${assignmentId}" not found`);
		}
		const existing = await getSubmission(assignmentId, submissionId);
		if (!existing) {
			throw new Error(
				`archive-submission: submission "${submissionId}" not found in assignment "${assignmentId}"`,
			);
		}
		if (existing.status === "archived") {
			throw new Error(`archive-submission: submission "${submissionId}" is already archived`);
		}

		const record = await archiveSubmission(assignmentId, submissionId);

		// Archive -> the student's plagiarism pairs stop blocking other
		// exports (marked ignored). Best-effort, same as the route.
		await setStudentPairReviewStatus(assignmentId, submissionId, "ignored").catch(() => {
			// cache read/write failures must not fail the archive itself
		});

		return {
			assignmentId,
			submissionId,
			archived: true,
			status: "archived",
			archivedFrom: record.archivedFrom ?? existing.status,
			record: {
				status: record.status,
				archivedFrom: record.archivedFrom,
				error: record.error,
				cellSummary: record.cellSummary,
			},
		};
	},
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** Register the OPS write tools (process, plagiarism, archive). */
export function registerOpsTools(registry: CopilotRegistry): void {
	// Idempotent: skip tools already registered (buildAgent can re-run after
	// __resetAgentForTests, and the registry rejects duplicate names).
	const existing = new Set(registry.list().map((t) => t.name));
	for (const tool of [
		processSubmissionTool,
		processAllTool,
		runPlagiarismCheckTool,
		updatePlagiarismReviewTool,
		archiveSubmissionTool,
	]) {
		if (!existing.has(tool.name)) registry.register(tool);
	}
}
