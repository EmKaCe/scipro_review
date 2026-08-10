/**
 * @file Copilot pre-evaluation tools.
 *
 *   pre-evaluate      — run the pre-evaluation service for one submission
 *                       (permission "auto"; writes the `preEval` block into
 *                       results.json) and return the envelope wrapped as a
 *                       "grade" suggestion so the teacher can apply the
 *                       suggested scores in one click. The agent loop unwraps
 *                       the marker, so the model still sees the full envelope.
 *   draft-notes        — run the SAME service without persisting, returning
 *                       the feedback draft as a "draft" suggestion
 *                       (permission "approval" — an LLM call the teacher
 *                       should be aware of).
 *   pre-evaluate-all  — loop every submission of an assignment, pre-evaluate
 *                       each row, persist each envelope, and return a
 *                       per-submission summary (permission "approval" AND
 *                       listed in ALWAYS_ASK_COST — N LLM calls = cost guard;
 *                       never auto-runs unattended).
 *
 * Both tools keep the "idempotent skip-existing" registration pattern of the
 * other tool modules. Failures on individual rows of pre-evaluate-all do NOT
 * abort the loop — the row is reported with ok:false and its error message.
 *
 * This module runs only on the SvelteKit server (`$lib/server/`).
 */

import { z } from "zod";

import { suggestionResult, type SuggestionResult } from "../agent";
import { resolveAssignmentId } from "$lib/server/assignments";
import { listSubmissions } from "$lib/server/metadata";
import { setPreEvaluation } from "$lib/server/results-store";
import { preEvaluateSubmission } from "../pre-evaluation";
import type { CopilotRegistry, CopilotTool, ToolContext } from "../registry";

// ---------------------------------------------------------------------------
// Arg schemas
// ---------------------------------------------------------------------------

const preEvaluateArgsSchema = z.object({
	/** Student id of the submission. Falls back to ctx.submissionId. */
	submissionId: z.string().optional(),
	/** Assignment id; falls back to ctx.assignmentId, then the first enabled one. */
	assignmentId: z.string().optional(),
});
type PreEvaluateArgs = z.infer<typeof preEvaluateArgsSchema>;

const preEvaluateAllArgsSchema = z.object({
	/** Assignment id; falls back to ctx.assignmentId, then the first enabled one. */
	assignmentId: z.string().optional(),
});
type PreEvaluateAllArgs = z.infer<typeof preEvaluateAllArgsSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Same fallback chain as the context tools: arg, then ctx, then first enabled. */
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

// ---------------------------------------------------------------------------
// pre-evaluate
// ---------------------------------------------------------------------------

const preEvaluateTool: CopilotTool<PreEvaluateArgs, SuggestionResult> = {
	name: "pre-evaluate",
	description:
		"Pre-evaluate ONE submission: compare its executed cells against the reference key, suggest a grade per dimension, draft student feedback, and summarize the notebook. " +
		"Persists the pre-evaluation into the stored results and returns it wrapped as a 'grade' suggestion the teacher can apply. " +
		"markers is null when the assignment has no reference key notebook.",
	permission: "auto",
	inputSchema: preEvaluateArgsSchema,
	run: async (args, ctx) => {
		const submissionId = args.submissionId?.trim() || ctx.submissionId?.trim();
		if (!submissionId) {
			throw new Error(
				"pre-evaluate requires a submissionId (tool argument or submission context)",
			);
		}
		const assignmentId = await resolveAssignmentIdForTool(
			args.assignmentId,
			ctx,
			"pre-evaluate",
		);

		const envelope = await preEvaluateSubmission({ submissionId, assignmentId });
		await setPreEvaluation(assignmentId, submissionId, {
			...envelope,
			evaluatedAt: new Date().toISOString(),
		});
		// 4e: return the envelope as a suggestion card. The agent loop unwraps
		// the marker for the model, so the LLM still sees the full envelope.
		return suggestionResult({
			kind: "grade",
			title: "Grade suggestion ready",
			body: envelope.notebookSummary || "Pre-evaluation complete.",
			actionLabel: "Apply suggested scores",
			data: envelope,
		});
	},
};

// ---------------------------------------------------------------------------
// draft-notes
// ---------------------------------------------------------------------------

/**
 * Draft student feedback notes: runs the same pre-evaluation service as
 * pre-evaluate but does NOT persist — the teacher gets a "draft" suggestion
 * carrying the feedback draft to review before anything is stored.
 */
const draftNotesTool: CopilotTool<PreEvaluateArgs, unknown> = {
	name: "draft-notes",
	description:
		"Draft student feedback notes for ONE submission by running the pre-evaluation service (compare cells against the reference key, suggest a grade, draft feedback). " +
		"Returns a 'draft' suggestion with the feedback text; nothing is persisted by this tool.",
	permission: "approval",
	inputSchema: preEvaluateArgsSchema,
	run: async (args, ctx) => {
		const submissionId = args.submissionId?.trim() || ctx.submissionId?.trim();
		if (!submissionId) {
			throw new Error(
				"draft-notes requires a submissionId (tool argument or submission context)",
			);
		}
		const assignmentId = await resolveAssignmentIdForTool(
			args.assignmentId,
			ctx,
			"draft-notes",
		);

		const envelope = await preEvaluateSubmission({ submissionId, assignmentId });
		return suggestionResult({
			kind: "draft",
			title: "Feedback draft ready",
			body: envelope.feedbackDraft,
			actionLabel: "Use feedback draft",
			data: { notes: envelope.feedbackDraft },
		});
	},
};

// ---------------------------------------------------------------------------
// pre-evaluate-all
// ---------------------------------------------------------------------------

interface PreEvaluateAllRow {
	studentId: string;
	ok: boolean;
	/** Set when the row failed; failures never abort the loop. */
	error?: string;
}

const preEvaluateAllTool: CopilotTool<PreEvaluateAllArgs, unknown> = {
	name: "pre-evaluate-all",
	description:
		"Pre-evaluate EVERY submission of an assignment (one KI Connect call per submission — expensive). " +
		"Persists each envelope into the stored results and returns a per-submission summary with totals; " +
		"rows that fail (e.g. not executed yet) are reported with ok:false and do not abort the loop.",
	permission: "approval",
	inputSchema: preEvaluateAllArgsSchema,
	run: async (args, ctx) => {
		const assignmentId = await resolveAssignmentIdForTool(
			args.assignmentId,
			ctx,
			"pre-evaluate-all",
		);

		const records = await listSubmissions(assignmentId);
		const rows: PreEvaluateAllRow[] = [];
		let succeeded = 0;

		for (const record of records) {
			if (ctx.signal.aborted) {
				throw new Error(
					`pre-evaluate-all aborted after ${rows.length} of ${records.length} submissions`,
				);
			}
			try {
				const envelope = await preEvaluateSubmission({
					submissionId: record.studentId,
					assignmentId,
				});
				await setPreEvaluation(assignmentId, record.studentId, {
					...envelope,
					evaluatedAt: new Date().toISOString(),
				});
				succeeded += 1;
				rows.push({ studentId: record.studentId, ok: true });
			} catch (err) {
				rows.push({
					studentId: record.studentId,
					ok: false,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}

		return {
			assignmentId,
			total: rows.length,
			succeeded,
			failed: rows.length - succeeded,
			results: rows,
		};
	},
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** Register the pre-evaluation tools (pre-evaluate, draft-notes, pre-evaluate-all). */
export function registerPreevalTools(registry: CopilotRegistry): void {
	// Idempotent: skip tools already registered (buildAgent can re-run after
	// __resetAgentForTests, and the registry rejects duplicate names).
	const existing = new Set(registry.list().map((t) => t.name));
	for (const tool of [preEvaluateTool, draftNotesTool, preEvaluateAllTool]) {
		if (!existing.has(tool.name)) registry.register(tool);
	}
}
