/**
 * @file Rubric-fidelity scorer (Wave 4 — Mastra audit §4).
 *
 * A Mastra `createScorer` that judges whether the copilot's proposed grading
 * (dimension scores + rubric selections + feedback) is faithful to the
 * assignment's rubric. Wired as `agent.scorers.rubricFidelity` with low-rate
 * sampling (0.1) so it produces a continuous quality signal without slowing
 * every turn.
 *
 * The judge is the SAME KI Connect model the copilot uses (createModel) —
 * no new credentials, no new provider. The scorer degrades gracefully: if
 * the judge LLM call fails, the scorer returns a neutral score rather than
 * throwing (a quality signal must never break the chat loop).
 *
 * This module runs only on the SvelteKit server (`$lib/server/`).
 */

import { z } from "zod";
import { createScorer } from "@mastra/core/evals";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/** The grading proposal the scorer evaluates (mirrors the grading tools' shapes). */
export const rubricFidelityInputSchema = z.object({
	/** Dimension id → proposed score (points, pre-weighting). */
	dimensions: z.record(z.string(), z.number().finite()).optional(),
	/** Criterion key → proposed rubric option key. */
	rubric: z.record(z.string(), z.string()).optional(),
	/** Free-form feedback text. */
	feedback: z.string().optional(),
	/** Assignment id (for the judge to ground against the rubric). */
	assignmentId: z.string().optional(),
});

export type RubricFidelityInput = z.infer<typeof rubricFidelityInputSchema>;

/** The scorer's output: a 0-1 fidelity score plus a reason. */
export const rubricFidelityOutputSchema = z.object({
	score: z.number().min(0).max(1),
	reason: z.string(),
});

export type RubricFidelityOutput = z.infer<typeof rubricFidelityOutputSchema>;

// ---------------------------------------------------------------------------
// Judge instructions
// ---------------------------------------------------------------------------

const JUDGE_INSTRUCTIONS = [
	"You are a grading-quality judge for a scientific-programming course.",
	"Evaluate whether the copilot's proposed grading is FAITHFUL to the assignment's rubric.",
	"",
	"Check each dimension score against the rubric's max_points:",
	"- A score above the dimension's max_points is over-scoring (flag it).",
	"- A score far below what the rubric criteria justify is under-scoring (flag it).",
	"- Scores should be consistent with the rubric selections: if the rubric says",
	"  'good use of sklearn' but the dimension score is near the floor, that is a",
	"  contradiction.",
	"",
	"Check the rubric selections against the criteria:",
	"- A selected option must be a real option of that criterion.",
	"- Selections that contradict each other (e.g. both 'imports alphabetized' and",
	"  'imports not alphabetized') are a fidelity failure.",
	"",
	"Check the feedback text:",
	"- Feedback must match the selections (praise what is checked, note what is not).",
	"- Feedback that contradicts the scores or selections is a fidelity failure.",
	"",
	"Score 1.0 for a fully faithful proposal, 0.0 for one that contradicts the",
	"rubric. Be strict but fair: minor wording issues are not fidelity failures.",
	"Return a JSON object with 'score' (0-1) and 'reason' (one short paragraph).",
].join("\n");

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build the rubric-fidelity scorer for the copilot agent.
 *
 * The judge reuses the copilot's KI Connect model — pass the SAME model
 * object the agent uses (createModel(settings) in agent.ts). The scorer is
 * constructed lazily by buildAgent — never at module top level (tests must
 * not require a model).
 */
export function createRubricFidelityScorer(model: unknown) {
	return createScorer({
		id: "rubric-fidelity",
		description:
			"Judges whether the copilot's proposed grading (dimension scores, rubric selections, feedback) is faithful to the assignment's rubric.",
		judge: {
			model: model as never,
			instructions: JUDGE_INSTRUCTIONS,
		},
		type: {
			input: rubricFidelityInputSchema,
			output: rubricFidelityOutputSchema,
		},
	});
}
