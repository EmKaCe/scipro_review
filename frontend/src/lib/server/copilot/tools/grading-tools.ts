/**
 * @file Copilot GRADING WRITE tools — the agent's sanctioned way
 * to persist teacher grading state, mirroring exactly what the teacher's own
 * Save action does (`POST /api/submissions/[id]/save`).
 *
 * Four tools (all `permission: "approval"` — every invocation mutates
 * teacher data, so the approval policy always shows a card):
 *
 *   set-rubric-item        — set one rubric selection (criterion key ->
 *                            option key) in the submission's grading state.
 *   update-grade-dimension — set one dimension slider value (bounded
 *                            [0, 1000], finite).
 *   write-notes            — set the top-level free-form notes.
 *   save-grading           — persist a MERGE of rubric / dimensions /
 *                            feedback / notes (fields absent from the args
 *                            are left untouched).
 *
 * All four resolve submissionId/assignmentId with the context-tools
 * fallback chain (args, then ctx, then the first enabled assignment) and
 * persist through metadata.saveGrading — the same service the save route
 * calls. Tools NEVER re-HTTP the route. Return values are bounded,
 * JSON-serializable summaries of the updated grading state.
 *
 * This module runs only on the SvelteKit server (`$lib/server/`).
 */

import { z } from "zod";

import { resolveAssignmentId } from "$lib/server/assignments";
import { saveGrading, type SubmissionRecord } from "$lib/server/metadata";
import type { CategoryFeedback } from "$lib/types/evaluation";
import type { CopilotRegistry, CopilotTool, ToolContext } from "../registry";

// ---------------------------------------------------------------------------
// Arg schemas
// ---------------------------------------------------------------------------

/** Shared target args: the submission to grade, resolved via fallbacks. */
const gradingTargetArgs = z.object({
	/** Student id of the submission. Falls back to ctx.submissionId. */
	submissionId: z.string().optional(),
	/** Assignment id; falls back to ctx.assignmentId, then the first enabled one. */
	assignmentId: z.string().optional(),
});

const setRubricItemArgsSchema = gradingTargetArgs.extend({
	/** Rubric criterion key, e.g. "clarity". */
	criterionKey: z.string().min(1),
	/** Rubric option key to select for that criterion, e.g. "good". */
	optionKey: z.string().min(1),
});
type SetRubricItemArgs = z.infer<typeof setRubricItemArgsSchema>;

const updateGradeDimensionArgsSchema = gradingTargetArgs.extend({
	/** Grading dimension id, e.g. "code_quality_design". */
	dimensionId: z.string().min(1),
	/** Dimension score (points). Must be finite and within [0, 1000]. */
	value: z.number().finite().min(0).max(1000),
});
type UpdateGradeDimensionArgs = z.infer<typeof updateGradeDimensionArgsSchema>;

const writeNotesArgsSchema = gradingTargetArgs.extend({
	/** Free-form teacher notes; an empty string clears the notes. */
	notes: z.string(),
});
type WriteNotesArgs = z.infer<typeof writeNotesArgsSchema>;

/** One rubric category's feedback — same shape the save route validates. */
const categoryFeedbackSchema = z.object({
	checked: z.array(z.string()),
	comments: z.record(z.string(), z.string()),
	deductions: z.record(z.string(), z.number().finite()),
	notes: z.string(),
});

const saveGradingArgsSchema = gradingTargetArgs.extend({
	/** Rubric selections to merge: criterion key -> option key. */
	rubric: z.record(z.string(), z.string()).optional(),
	/** Dimension scores to merge: dimension id -> finite number. */
	dimensions: z.record(z.string(), z.number().finite()).optional(),
	/** Per-category feedback to merge: category key -> CategoryFeedback. */
	feedback: z.record(z.string(), categoryFeedbackSchema).optional(),
	/** Free-form notes; an empty string clears the notes. */
	notes: z.string().optional(),
});
type SaveGradingArgs = z.infer<typeof saveGradingArgsSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Same fallback chain as the context tools: arg, then ctx, then first enabled. */
async function resolveGradingTarget(
	args: { submissionId?: string; assignmentId?: string },
	ctx: ToolContext,
	toolName: string,
): Promise<{ submissionId: string; assignmentId: string }> {
	const submissionId = args.submissionId?.trim() || ctx.submissionId?.trim();
	if (!submissionId) {
		throw new Error(
			`${toolName} requires a submissionId (tool argument or submission context)`,
		);
	}
	const assignmentId =
		args.assignmentId?.trim() || ctx.assignmentId?.trim() || (await resolveAssignmentId(null));
	if (!assignmentId) {
		throw new Error(`${toolName}: no assignmentId given and no assignment is configured`);
	}
	return { submissionId, assignmentId };
}

/**
 * Bounded, JSON-serializable summary of a submission's grading state after a
 * write. Includes the full rubric/dimensions maps (small, keyed by fixed
 * criteria) but only a count for feedback (comments can be verbose) and the
 * raw notes string.
 */
function summarizeGrading(record: SubmissionRecord) {
	return {
		submissionId: record.studentId,
		assignmentId: record.assignmentId,
		rubric: record.grading?.rubric ?? {},
		dimensions: record.grading?.dimensions ?? {},
		notes: record.grading?.notes ?? null,
		feedbackCategories: Object.keys(record.grading?.feedback ?? {}).length,
		updatedAt: record.grading?.updatedAt ?? record.updatedAt,
	};
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const setRubricItemTool: CopilotTool<SetRubricItemArgs> = {
	name: "set-rubric-item",
	description:
		"Set one rubric selection for a submission (criterion key -> option key), exactly like the teacher ticking a rubric checkbox. " +
		"Persists through the same save path as the teacher's Save action; other grading state (dimensions, notes, feedback) is untouched.",
	permission: "approval",
	inputSchema: setRubricItemArgsSchema,
	run: async (args, ctx) => {
		const { submissionId, assignmentId } = await resolveGradingTarget(
			args,
			ctx,
			"set-rubric-item",
		);
		const record = await saveGrading(assignmentId, submissionId, {
			rubric: { [args.criterionKey]: args.optionKey },
		});
		return {
			...summarizeGrading(record),
			rubricItem: { criterionKey: args.criterionKey, optionKey: args.optionKey },
		};
	},
};

const updateGradeDimensionTool: CopilotTool<UpdateGradeDimensionArgs> = {
	name: "update-grade-dimension",
	description:
		"Set one grading dimension score for a submission (dimension id -> value in [0, 1000]), exactly like the teacher dragging a grading slider. " +
		"Persists through the same save path as the teacher's Save action; other grading state is untouched.",
	permission: "approval",
	inputSchema: updateGradeDimensionArgsSchema,
	run: async (args, ctx) => {
		const { submissionId, assignmentId } = await resolveGradingTarget(
			args,
			ctx,
			"update-grade-dimension",
		);
		const record = await saveGrading(assignmentId, submissionId, {
			dimensions: { [args.dimensionId]: args.value },
		});
		return {
			...summarizeGrading(record),
			dimension: { dimensionId: args.dimensionId, value: args.value },
		};
	},
};

const writeNotesTool: CopilotTool<WriteNotesArgs> = {
	name: "write-notes",
	description:
		"Write the free-form teacher notes for a submission (an empty string clears them), exactly like the teacher's notes field. " +
		"Persists through the same save path as the teacher's Save action; other grading state is untouched.",
	permission: "approval",
	inputSchema: writeNotesArgsSchema,
	run: async (args, ctx) => {
		const { submissionId, assignmentId } = await resolveGradingTarget(args, ctx, "write-notes");
		const record = await saveGrading(assignmentId, submissionId, { notes: args.notes });
		return summarizeGrading(record);
	},
};

const saveGradingTool: CopilotTool<SaveGradingArgs> = {
	name: "save-grading",
	description:
		"Persist a MERGE of grading state for a submission: rubric selections, dimension scores, per-category feedback, and/or notes, exactly like the teacher's Save action. " +
		"Only the fields present in the arguments are written — all other grading state survives untouched. Returns the updated grading summary.",
	permission: "approval",
	inputSchema: saveGradingArgsSchema,
	run: async (args, ctx) => {
		const { submissionId, assignmentId } = await resolveGradingTarget(
			args,
			ctx,
			"save-grading",
		);

		const grading: Partial<{
			rubric: Record<string, string>;
			dimensions: Record<string, number>;
			feedback: Record<string, CategoryFeedback>;
			notes: string;
		}> = {};
		const persisted: string[] = [];
		if (args.rubric !== undefined) {
			grading.rubric = args.rubric;
			persisted.push("rubric");
		}
		if (args.dimensions !== undefined) {
			grading.dimensions = args.dimensions;
			persisted.push("dimensions");
		}
		if (args.feedback !== undefined) {
			grading.feedback = args.feedback as Record<string, CategoryFeedback>;
			persisted.push("feedback");
		}
		if (args.notes !== undefined) {
			grading.notes = args.notes;
			persisted.push("notes");
		}

		const record = await saveGrading(assignmentId, submissionId, grading);
		return { ...summarizeGrading(record), persisted };
	},
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** Register the four grading write tools on the given registry (all approval). */
export function registerGradingTools(registry: CopilotRegistry): void {
	// Idempotent: skip tools already registered (buildAgent can re-run after
	// __resetAgentForTests, and the registry rejects duplicate names).
	const existing = new Set(registry.list().map((t) => t.name));
	for (const tool of [
		setRubricItemTool,
		updateGradeDimensionTool,
		writeNotesTool,
		saveGradingTool,
	]) {
		if (!existing.has(tool.name)) registry.register(tool);
	}
}
