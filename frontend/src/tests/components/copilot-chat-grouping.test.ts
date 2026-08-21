/**
 * @file P10-A — unit tests for the transcript phase-grouping helper.
 *
 * Pure-function tests (no jsdom needed): tool-call/tool-result/approval
 * messages group under their plan-phase headers via PLAN_PHASE_BY_TOOL,
 * unknown tools fall back to gather-context (grouped only when a matching
 * step exists), text/suggestion/error stay ungrouped, and empty phases
 * emit no group.
 */

import { describe, expect, it } from "vitest";
import type { CopilotMessage } from "$lib/components/submissions/copilot-store.svelte.js";
import type { CopilotPlanStep } from "$lib/components/submissions/copilot-store.svelte.js";
import {
	PLAN_FALLBACK_PHASE_ID,
	groupMessagesByPhase,
	phaseForMessage,
} from "$lib/components/submissions/copilot/grouping.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function msg(
	id: string,
	kind: CopilotMessage["kind"],
	overrides: Partial<CopilotMessage> = {},
): CopilotMessage {
	return {
		id,
		role: "assistant",
		content: "",
		timestamp: 1000,
		type: "text",
		kind,
		...overrides,
	};
}

function step(id: string, status: CopilotPlanStep["status"] = "completed"): CopilotPlanStep {
	return { id, label: id, status };
}

const STEPS: CopilotPlanStep[] = [
	step("analyze-code"),
	step("pre-evaluate"),
	step("execute-notebook"),
];

// ---------------------------------------------------------------------------
// phaseForMessage
// ---------------------------------------------------------------------------

describe("phaseForMessage", () => {
	it("maps tool-call messages via PLAN_PHASE_BY_TOOL", () => {
		expect(phaseForMessage(msg("m1", "tool-call", { tool: "analyze-code" }))).toBe(
			"analyze-code",
		);
		expect(phaseForMessage(msg("m2", "tool-call", { tool: "process-submission" }))).toBe(
			"execute-notebook",
		);
		expect(phaseForMessage(msg("m3", "tool-call", { tool: "search-docs" }))).toBe(
			"check-library-docs",
		);
	});

	it("maps tool-result and approval messages too", () => {
		expect(phaseForMessage(msg("r", "tool-result", { tool: "pre-evaluate" }))).toBe(
			"pre-evaluate",
		);
		expect(phaseForMessage(msg("a", "approval", { tool: "write-notes" }))).toBe(
			"apply-grading-changes",
		);
	});

	it("falls back to gather-context for unknown or missing tools", () => {
		expect(phaseForMessage(msg("m", "tool-call", { tool: "mystery-tool" }))).toBe(
			PLAN_FALLBACK_PHASE_ID,
		);
		expect(phaseForMessage(msg("m", "tool-result"))).toBe(PLAN_FALLBACK_PHASE_ID);
	});

	it("returns null for text, suggestion and error messages", () => {
		expect(phaseForMessage(msg("t", "text"))).toBeNull();
		expect(
			phaseForMessage(
				msg("s", "suggestion", {
					suggestion: {
						suggestionId: "s1",
						kind: "draft",
						title: "t",
						body: "b",
						actionLabel: "Apply",
					},
				}),
			),
		).toBeNull();
		expect(phaseForMessage(msg("e", "error"))).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// groupMessagesByPhase
// ---------------------------------------------------------------------------

describe("groupMessagesByPhase", () => {
	it("groups an analyze-code tool-call under the analyze-code step, preserving order", () => {
		const analyze = msg("a1", "tool-call", { tool: "analyze-code" });
		const analyzeResult = msg("a2", "tool-result", {
			tool: "analyze-code",
			ok: true,
			summary: "ok",
		});
		const pre = msg("p1", "tool-call", { tool: "pre-evaluate" });
		const messages = [analyze, pre, analyzeResult];

		const { groups, ungrouped } = groupMessagesByPhase(messages, [
			step("analyze-code"),
			step("pre-evaluate"),
		]);

		expect(groups.map((g) => g.step.id)).toEqual(["analyze-code", "pre-evaluate"]);
		expect(groups[0].messages.map((m) => m.id)).toEqual(["a1", "a2"]);
		expect(groups[1].messages.map((m) => m.id)).toEqual(["p1"]);
		expect(ungrouped).toEqual([]);
	});

	it("follows plan-step order, not first-use order", () => {
		const { groups } = groupMessagesByPhase(
			[
				msg("p1", "tool-call", { tool: "pre-evaluate" }),
				msg("a1", "tool-call", { tool: "analyze-code" }),
			],
			[step("analyze-code"), step("pre-evaluate")],
		);
		expect(groups.map((g) => g.step.id)).toEqual(["analyze-code", "pre-evaluate"]);
	});

	it("groups an unknown tool under gather-context when that step exists", () => {
		const mystery = msg("m1", "tool-call", { tool: "mystery-tool" });
		const { groups, ungrouped } = groupMessagesByPhase(
			[mystery],
			[step(PLAN_FALLBACK_PHASE_ID)],
		);
		expect(groups.map((g) => g.step.id)).toEqual([PLAN_FALLBACK_PHASE_ID]);
		expect(groups[0].messages.map((m) => m.id)).toEqual(["m1"]);
		expect(ungrouped).toEqual([]);
	});

	it("sends unknown-phase messages to ungrouped when no gather-context step exists", () => {
		const mystery = msg("m1", "tool-call", { tool: "mystery-tool" });
		const { groups, ungrouped } = groupMessagesByPhase([mystery], STEPS);
		expect(groups).toEqual([]);
		expect(ungrouped.map((m) => m.id)).toEqual(["m1"]);
	});

	it("keeps text, suggestion and error messages ungrouped in order", () => {
		const text = msg("t1", "text", { content: "hi", role: "teacher" });
		const suggestion = msg("s1", "suggestion", {
			suggestion: {
				suggestionId: "s1",
				kind: "draft",
				title: "Draft",
				body: "b",
				actionLabel: "Apply",
			},
		});
		const error = msg("e1", "error", { content: "boom" });
		const analyze = msg("a1", "tool-call", { tool: "analyze-code" });

		const { groups, ungrouped } = groupMessagesByPhase(
			[text, analyze, suggestion, error],
			STEPS,
		);

		expect(groups.map((g) => g.step.id)).toEqual(["analyze-code"]);
		expect(ungrouped.map((m) => m.id)).toEqual(["t1", "s1", "e1"]);
	});

	it("emits no group for steps without messages", () => {
		const { groups } = groupMessagesByPhase(
			[msg("a1", "tool-call", { tool: "analyze-code" })],
			[step("analyze-code"), step("pre-evaluate"), step("execute-notebook")],
		);
		expect(groups.map((g) => g.step.id)).toEqual(["analyze-code"]);
	});

	it("returns empty groups and all messages ungrouped for no plan steps", () => {
		const analyze = msg("a1", "tool-call", { tool: "analyze-code" });
		const text = msg("t1", "text", { content: "hi" });
		const { groups, ungrouped } = groupMessagesByPhase([analyze, text], []);
		expect(groups).toEqual([]);
		expect(ungrouped.map((m) => m.id)).toEqual(["a1", "t1"]);
	});
});
