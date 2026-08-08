// @vitest-environment node
/**
 * @file Unit tests for the copilot agent loop (agent.ts).
 *
 * The Mastra Agent runs for real; the LLM is a scripted AI SDK v2 language
 * model mock (proven live against @mastra/core@1.54.0 in the 4a.3 probe:
 * `stream()` rejects v1 mocks, so the mock must declare
 * specificationVersion "v2" and emit v2 parts).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Scripted v2 model mock (hoisted so vi.mock can reference it)
// ---------------------------------------------------------------------------

type V2Part = Record<string, unknown>;

const { mockModel, mockControl } = vi.hoisted(() => {
	const mockControl = {
		/** Per-doStream-call parts; shift()ed in order. */
		script: [] as V2Part[][],
		/** Every doStream call's options, for asserting what the model received. */
		receivedCalls: [] as unknown[],
	};
	const mockModel = {
		specificationVersion: "v2",
		provider: "mock",
		modelId: "mock-model",
		async doStream(options?: unknown) {
			mockControl.receivedCalls.push(options);
			const parts = mockControl.script.shift() ?? [
				{
					type: "finish",
					finishReason: "stop",
					usage: { inputTokens: 1, outputTokens: 1 },
				},
			];
			return {
				stream: new ReadableStream({
					start(controller) {
						for (const part of parts) controller.enqueue(part);
						controller.close();
					},
				}),
			};
		},
	};
	return { mockModel, mockControl };
});

vi.mock("@ai-sdk/openai-compatible", () => ({
	createOpenAICompatible: () => ({ chatModel: () => mockModel }),
}));

// ---------------------------------------------------------------------------
// Imports (after the mock is registered)
// ---------------------------------------------------------------------------

import {
	__resetAgentForTests,
	approveRun,
	registry,
	streamChat,
	suggestionResult,
	type CopilotStreamEvent,
} from "$lib/server/copilot/agent";

const STREAM_START: V2Part = { type: "stream-start" };
const FINISH_TOOL_CALLS: V2Part = {
	type: "finish",
	finishReason: "tool-calls",
	usage: { inputTokens: 1, outputTokens: 1 },
};
const FINISH_STOP: V2Part = {
	type: "finish",
	finishReason: "stop",
	usage: { inputTokens: 1, outputTokens: 1 },
};

function toolCallTurn(toolName: string, input: string, toolCallId = "call_1"): V2Part[] {
	return [STREAM_START, { type: "tool-call", toolCallId, toolName, input }, FINISH_TOOL_CALLS];
}

function textTurn(text: string): V2Part[] {
	return [
		STREAM_START,
		{ type: "text-start" },
		{ type: "text-delta", delta: text },
		{ type: "text-end" },
		FINISH_STOP,
	];
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let dataDir: string;
let executed: string[] = [];

beforeEach(async () => {
	dataDir = await mkdtemp(path.join(os.tmpdir(), "scipro-agent-"));
	process.env.DATA_DIR = dataDir;
	mockControl.script = [];
	mockControl.receivedCalls = [];
	executed = [];
	__resetAgentForTests();
});

afterEach(async () => {
	delete process.env.DATA_DIR;
	__resetAgentForTests();
	await rm(dataDir, { recursive: true, force: true });
});

async function collect(events: AsyncIterable<CopilotStreamEvent>): Promise<CopilotStreamEvent[]> {
	const out: CopilotStreamEvent[] = [];
	for await (const ev of events) out.push(ev);
	return out;
}

/** Consume a stream; on approval-request, resolve it with the given decision. */
async function collectWithApproval(
	events: AsyncIterable<CopilotStreamEvent>,
	decision: "approve" | "deny",
): Promise<CopilotStreamEvent[]> {
	const out: CopilotStreamEvent[] = [];
	for await (const ev of events) {
		out.push(ev);
		if (ev.type === "approval-request") {
			await approveRun({ runId: ev.runId, toolCallId: ev.toolCallId, decision });
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("copilot agent loop (agent.ts)", () => {
	it("runs an auto tool round-trip and streams events in order", async () => {
		registry.register({
			name: "echo_auto_1",
			description: "echoes a value",
			permission: "auto",
			inputSchema: z.object({ value: z.string() }),
			run: async (args: { value: string }) => {
				executed.push("echo_auto_1");
				return { echoed: args.value };
			},
		});
		mockControl.script = [
			toolCallTurn("echo_auto_1", JSON.stringify({ value: "hi" })),
			textTurn("Done"),
		];

		const events = await collect(await streamChat({ submissionId: "s1", message: "go" }));

		expect(executed).toEqual(["echo_auto_1"]);
		const kinds = events.map((e) => e.type);
		expect(kinds).toContain("tool-call");
		expect(kinds).toContain("tool-result");
		expect(kinds).toContain("message-delta");
		expect(kinds).toContain("message");
		expect(kinds[kinds.length - 1]).toBe("done");
		const toolCall = events.find((e) => e.type === "tool-call");
		expect(toolCall && toolCall.type === "tool-call" ? toolCall.tool : "").toBe("echo_auto_1");
		const toolResult = events.find((e) => e.type === "tool-result");
		expect(toolResult && toolResult.type === "tool-result" ? toolResult.ok : false).toBe(true);
		const msg = events.find((e) => e.type === "message");
		expect(msg && msg.type === "message" ? msg.content : "").toBe("Done");
		// No approval was requested for an auto tool.
		expect(kinds).not.toContain("approval-request");
	});

	it("suspends for approval, then approves and executes the tool", async () => {
		registry.register({
			name: "ask_approve_1",
			description: "needs approval",
			permission: "approval",
			inputSchema: z.object({}),
			run: async () => {
				executed.push("ask_approve_1");
				return { ok: true };
			},
		});
		mockControl.script = [toolCallTurn("ask_approve_1", "{}"), textTurn("Approved")];

		const events = await collectWithApproval(
			await streamChat({ submissionId: "s1", message: "go" }),
			"approve",
		);

		const approval = events.find((e) => e.type === "approval-request");
		expect(approval).toBeDefined();
		expect(approval && approval.type === "approval-request" ? approval.decision : "").toBe(
			"ask",
		);
		expect(approval && approval.type === "approval-request" ? approval.tool : "").toBe(
			"ask_approve_1",
		);
		// Approve → the tool body ran.
		expect(executed).toEqual(["ask_approve_1"]);
		const kinds = events.map((e) => e.type);
		expect(kinds[kinds.length - 1]).toBe("done");
	});

	it("denies the tool call — the tool body never runs", async () => {
		registry.register({
			name: "ask_deny_1",
			description: "needs approval",
			permission: "approval",
			inputSchema: z.object({}),
			run: async () => {
				executed.push("ask_deny_1");
				return { ok: true };
			},
		});
		mockControl.script = [toolCallTurn("ask_deny_1", "{}"), textTurn("Skipped")];

		const events = await collectWithApproval(
			await streamChat({ submissionId: "s1", message: "go" }),
			"deny",
		);

		expect(executed).toEqual([]);
		expect(events.some((e) => e.type === "approval-request")).toBe(true);
		const msg = events.find((e) => e.type === "message");
		expect(msg && msg.type === "message" ? msg.content : "").toBe("Skipped");
		expect(events[events.length - 1].type).toBe("done");
	});

	it("marks denied-by-policy tools as blocked; approve behaves as deny", async () => {
		await writeFile(
			path.join(dataDir, "settings.yaml"),
			[
				"copilot:",
				"  mode: ask",
				"  allowed_tools: []",
				"  deny_tools: [ask_blocked_1]",
				"  approval_ttl_seconds: 60",
				"  session_cap: 20",
				"",
			].join("\n"),
		);
		registry.register({
			name: "ask_blocked_1",
			description: "blocked by deny list",
			permission: "approval",
			inputSchema: z.object({}),
			run: async () => {
				executed.push("ask_blocked_1");
				return { ok: true };
			},
		});
		mockControl.script = [toolCallTurn("ask_blocked_1", "{}"), textTurn("Blocked")];

		// Even an explicit "approve" on a blocked call behaves as deny.
		const events = await collectWithApproval(
			await streamChat({ submissionId: "s1", message: "go" }),
			"approve",
		);

		const approval = events.find((e) => e.type === "approval-request");
		expect(approval && approval.type === "approval-request" ? approval.decision : "").toBe(
			"blocked",
		);
		expect(executed).toEqual([]);
		expect(events[events.length - 1].type).toBe("done");
	});

	it("auto-denies an unanswered approval after the TTL", async () => {
		await writeFile(
			path.join(dataDir, "settings.yaml"),
			[
				"copilot:",
				"  mode: ask",
				"  allowed_tools: []",
				"  deny_tools: []",
				"  approval_ttl_seconds: 1",
				"  session_cap: 20",
				"",
			].join("\n"),
		);
		registry.register({
			name: "ask_ttl_1",
			description: "times out",
			permission: "approval",
			inputSchema: z.object({}),
			run: async () => {
				executed.push("ask_ttl_1");
				return { ok: true };
			},
		});
		mockControl.script = [toolCallTurn("ask_ttl_1", "{}"), textTurn("Expired")];

		// No approveRun call — the TTL (1s) must auto-deny and continue.
		const events = await collect(await streamChat({ submissionId: "s1", message: "go" }));

		expect(executed).toEqual([]);
		const expiry = events.find((e) => e.type === "tool-result" && !e.ok);
		expect(expiry).toBeDefined();
		expect(events[events.length - 1].type).toBe("done");
	}, 15_000);

	it("contains tool errors: a throwing tool surfaces ok:false without crashing the loop", async () => {
		registry.register({
			name: "boom_1",
			description: "throws",
			permission: "auto",
			inputSchema: z.object({}),
			run: async () => {
				throw new Error("boom");
			},
		});
		mockControl.script = [toolCallTurn("boom_1", "{}"), textTurn("Recovered")];

		const events = await collect(await streamChat({ submissionId: "s1", message: "go" }));

		const toolResult = events.find((e) => e.type === "tool-result");
		expect(toolResult && toolResult.type === "tool-result" ? toolResult.ok : true).toBe(false);
		expect(events.some((e) => e.type === "error")).toBe(false);
		const msg = events.find((e) => e.type === "message");
		expect(msg && msg.type === "message" ? msg.content : "").toBe("Recovered");
		expect(events[events.length - 1].type).toBe("done");
	});

	it("rejects invalid tool args through the registry (typed error, no crash)", async () => {
		let invalidExecuted = 0;
		registry.register({
			name: "echo_strict_1",
			description: "echoes a string value",
			permission: "auto",
			inputSchema: z.object({ value: z.string() }),
			run: async (args: { value: string }) => {
				invalidExecuted += 1;
				return { echoed: args.value };
			},
		});
		// input is a number — the Zod schema expects a string.
		mockControl.script = [
			toolCallTurn("echo_strict_1", JSON.stringify({ value: 42 })),
			textTurn("Ok"),
		];

		const events = await collect(await streamChat({ submissionId: "s1", message: "go" }));

		// The tool body must NOT run; the failure surfaces as ok:false.
		expect(invalidExecuted).toBe(0);
		const toolResult = events.find((e) => e.type === "tool-result");
		expect(toolResult && toolResult.type === "tool-result" ? toolResult.ok : true).toBe(false);
		expect(events[events.length - 1].type).toBe("done");
	});

	it("stops cleanly when aborted before consumption (no done event)", async () => {
		registry.register({
			name: "echo_abort_1",
			description: "echoes",
			permission: "auto",
			inputSchema: z.object({ value: z.string() }),
			run: async (args: { value: string }) => ({ echoed: args.value }),
		});
		mockControl.script = [
			toolCallTurn("echo_abort_1", JSON.stringify({ value: "x" })),
			textTurn("Never"),
		];

		const controller = new AbortController();
		controller.abort();
		const events = await collect(
			await streamChat({ submissionId: "s1", message: "go", signal: controller.signal }),
		);

		expect(events).toEqual([]);
	});

	it("emits a suggestion event after the tool result when a tool returns the suggestion marker", async () => {
		const data = {
			markers: [
				{ cell_index: 0, marker: "different", reason: "Different but valid approach" },
			],
			gradeSuggestion: {
				dimensions: { code_quality_design: 4 },
				justification: "Solid work overall.",
			},
			feedbackDraft: "**Nice job** — keep it up.",
			notebookSummary: "The notebook computes a soil quality index.",
		};
		registry.register({
			name: "suggest_grade_1",
			description: "emits a grade suggestion",
			permission: "auto",
			inputSchema: z.object({}),
			run: async () =>
				suggestionResult({
					kind: "grade",
					title: "Grade suggestion ready",
					body: "The notebook computes a soil quality index.",
					actionLabel: "Apply suggested scores",
					data,
				}),
		});
		mockControl.script = [toolCallTurn("suggest_grade_1", "{}"), textTurn("Done")];

		const events = await collect(await streamChat({ submissionId: "s1", message: "go" }));

		// tool-result first, suggestion immediately after.
		const toolResultIndex = events.findIndex((e) => e.type === "tool-result");
		const suggestionIndex = events.findIndex((e) => e.type === "suggestion");
		expect(toolResultIndex).toBeGreaterThanOrEqual(0);
		expect(suggestionIndex).toBe(toolResultIndex + 1);

		const suggestion = events[suggestionIndex];
		expect(suggestion && suggestion.type === "suggestion" ? suggestion.kind : "").toBe("grade");
		expect(suggestion && suggestion.type === "suggestion" ? suggestion.title : "").toBe(
			"Grade suggestion ready",
		);
		expect(suggestion && suggestion.type === "suggestion" ? suggestion.actionLabel : "").toBe(
			"Apply suggested scores",
		);
		expect(
			suggestion && suggestion.type === "suggestion" ? suggestion.suggestionId : "",
		).toBeTruthy();
		// The suggestion event carries the structured apply data.
		expect(
			suggestion && suggestion.type === "suggestion" ? suggestion.data : undefined,
		).toEqual(data);

		// The tool-result summary reflects the UNWRAPPED raw value (no marker;
		// summarized JSON is truncated at 200 chars, so assert on an early key).
		const toolResult = events[toolResultIndex];
		const summary =
			toolResult && toolResult.type === "tool-result" ? (toolResult.summary ?? "") : "";
		expect(summary).not.toContain("__suggestion");
		expect(summary).toContain("gradeSuggestion");

		// The model's next input carries the RAW result WITHOUT the marker.
		expect(mockControl.receivedCalls.length).toBeGreaterThan(0);
		const lastCall = mockControl.receivedCalls[mockControl.receivedCalls.length - 1];
		const serialized = JSON.stringify(lastCall);
		expect(serialized).not.toContain("__suggestion");
		expect(serialized).toContain("feedbackDraft");
		expect(serialized).toContain("gradeSuggestion");

		expect(events[events.length - 1].type).toBe("done");
	});

	it("does not emit a suggestion event for a plain tool result", async () => {
		registry.register({
			name: "plain_result_1",
			description: "returns a plain object",
			permission: "auto",
			inputSchema: z.object({}),
			run: async () => ({ markers: [], gradeSuggestion: { dimensions: {} } }),
		});
		mockControl.script = [toolCallTurn("plain_result_1", "{}"), textTurn("Ok")];

		const events = await collect(await streamChat({ submissionId: "s1", message: "go" }));

		expect(events.some((e) => e.type === "suggestion")).toBe(false);
		expect(events[events.length - 1].type).toBe("done");
	});
});
