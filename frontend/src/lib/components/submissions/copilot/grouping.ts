/**
 * @file P10-A — phase grouping for the copilot transcript (pure helper).
 *
 * Groups tool-call / tool-result / approval messages under their plan-phase
 * headers so the chat reads as "phase → its tool cards" instead of a flat
 * stream. Text, suggestion and error messages stay ungrouped.
 *
 * Purely functional: no Svelte, no store state — unit-testable without jsdom.
 */

import type { CopilotMessage } from "../copilot-store.svelte.js";
import type { CopilotPlanStep } from "../copilot-store.svelte.js";

/**
 * Fallback phase for tools that have no dedicated plan step.
 * Mirrors `PLAN_FALLBACK_PHASE_ID` in copilot-store.svelte.ts (line 399).
 */
export const PLAN_FALLBACK_PHASE_ID = "gather-context";

/**
 * Tool → phase-id mapping.
 *
 * MIRRORS `PLAN_PHASE_BY_TOOL` in copilot-store.svelte.ts (lines 384-398) —
 * that map is a non-exported module-level const, so it is duplicated here
 * rather than exported from the store. Keep the two in sync.
 */
const PLAN_PHASE_BY_TOOL: Record<string, string> = {
	"process-submission": "execute-notebook",
	"process-all": "execute-notebook",
	"pre-evaluate": "pre-evaluate",
	"pre-evaluate-all": "pre-evaluate",
	"draft-notes": "pre-evaluate",
	"set-rubric-item": "apply-grading-changes",
	"save-grading": "apply-grading-changes",
	"update-grade-dimension": "apply-grading-changes",
	"write-notes": "apply-grading-changes",
	"run-plagiarism-check": "plagiarism-check",
	"analyze-code": "analyze-code",
	"compare-to-key": "compare-to-key",
	"search-docs": "check-library-docs",
};

/**
 * The phase id a message belongs to, or `null` when it must stay ungrouped.
 *
 * tool-call | tool-result | approval → `PLAN_PHASE_BY_TOOL[msg.tool]` with the
 * fallback phase when the tool is unknown/missing; everything else (text,
 * suggestion, error) → `null`.
 */
export function phaseForMessage(msg: CopilotMessage): string | null {
	if (msg.kind === "tool-call" || msg.kind === "tool-result" || msg.kind === "approval") {
		return PLAN_PHASE_BY_TOOL[msg.tool ?? ""] ?? PLAN_FALLBACK_PHASE_ID;
	}
	return null;
}

/** Messages belonging to one plan phase, in transcript order. */
export interface PhaseGroup {
	/** The plan step this group renders under. */
	step: CopilotPlanStep;
	/** The phase's tool-call / tool-result / approval messages, in order. */
	messages: CopilotMessage[];
}

/** Grouped transcript: phase groups in plan order + leftover messages. */
export interface GroupedTranscript {
	/** Non-empty phase groups, in `steps` order. */
	groups: PhaseGroup[];
	/** Ungrouped messages (text/suggestion/error, or unknown phases with no
	 * matching step), in transcript order. */
	ungrouped: CopilotMessage[];
}

/**
 * Partition `messages` under the plan phases named by `steps`.
 *
 * - Iterates `steps` in order; each group collects the messages whose
 *   `phaseForMessage` equals the step id (transcript order preserved).
 * - Steps with no messages produce NO group.
 * - Messages with a `null` phase, or whose phase id does not appear in
 *   `steps`, land in `ungrouped` (transcript order preserved).
 */
export function groupMessagesByPhase(
	messages: CopilotMessage[],
	steps: CopilotPlanStep[],
): GroupedTranscript {
	const groups: PhaseGroup[] = [];
	for (const step of steps) {
		const phaseMessages = messages.filter((msg) => phaseForMessage(msg) === step.id);
		if (phaseMessages.length > 0) {
			groups.push({ step, messages: phaseMessages });
		}
	}
	const stepIds = new Set(steps.map((s) => s.id));
	const ungrouped = messages.filter((msg) => {
		const phase = phaseForMessage(msg);
		return phase === null || !stepIds.has(phase);
	});
	return { groups, ungrouped };
}
