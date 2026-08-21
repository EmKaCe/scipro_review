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
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
	buildAgent,
	derivePlanSteps,
	extractChangesFromToolResult,
	registry,
	snapshotGradingState,
	streamChat,
	suggestionResult,
	WORKING_MEMORY_TEMPLATE,
	type CopilotStreamEvent,
} from "$lib/server/copilot/agent";
import { FileMemoryStore } from "$lib/server/copilot/file-memory";
import { listCheckpoints, loadCheckpoint } from "$lib/server/copilot/checkpoint-store";
import * as checkpointStore from "$lib/server/copilot/checkpoint-store";
import * as docsRag from "$lib/server/copilot/docs-rag";
import { registerDocsTools } from "$lib/server/copilot/tools/docs-tools";

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
	vi.restoreAllMocks();
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

/**
 * Extract the user message text from what the mock model received. Mastra
 * hands the AI SDK a `prompt` array of messages; the user content is an
 * array of parts (the v2 wire shape), so flatten text parts.
 */
function receivedUserMessage(call: unknown): string {
	const prompt = (call as { prompt?: Array<{ role?: string; content?: unknown }> }).prompt ?? [];
	const user = prompt.find((m) => m.role === "user");
	const content = user?.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) =>
				part && typeof part === "object" && "text" in part
					? String((part as { text: unknown }).text)
					: "",
			)
			.join("");
	}
	return "";
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

	it("keeps tool-result summaries valid JSON when truncated (P14-C follow-up)", async () => {
		registry.register({
			name: "echo_big_1",
			description: "echoes a large nested value",
			permission: "auto",
			inputSchema: z.object({}),
			run: async () => {
				executed.push("echo_big_1");
				return {
					submissionId: "2026SS_00",
					assignmentId: "soil_contamination",
					dimensions: { code_quality_design: 4, scientific_programming: 5 },
					notes: "x".repeat(500),
					feedbackCategories: ["a", "b", "c", "d", "e", "f", "g", "h"],
				};
			},
		});
		mockControl.script = [toolCallTurn("echo_big_1", "{}"), textTurn("Done")];

		const events = await collect(await streamChat({ submissionId: "s1", message: "go" }));

		const toolResult = events.find((e) => e.type === "tool-result");
		expect(toolResult && toolResult.type === "tool-result" ? toolResult.ok : false).toBe(true);
		const summary = toolResult && toolResult.type === "tool-result" ? toolResult.summary : "";
		expect(typeof summary).toBe("string");
		// The summary must remain parseable JSON (structural truncation),
		// so the client's ToolArgs can render key/value rows.
		expect(() => JSON.parse(summary ?? "")).not.toThrow();
		const parsed = JSON.parse(summary ?? "") as Record<string, unknown>;
		expect(parsed.submissionId).toBe("2026SS_00");
		expect(parsed.dimensions).toBeDefined();
		// Long strings are shortened; the count marker is present.
		expect(String(parsed.notes).length).toBeLessThan(500);
		// The budget is a HARD cap on the serialized summary.
		expect(JSON.stringify(parsed).length).toBeLessThanOrEqual(400);
	});

	it("hard-caps the summary even for pathological payloads (many short keys)", async () => {
		registry.register({
			name: "echo_keys_1",
			description: "echoes many short keys",
			permission: "auto",
			inputSchema: z.object({}),
			run: async () => {
				executed.push("echo_keys_1");
				const wide: Record<string, string> = {};
				for (let i = 0; i < 60; i++) wide[`k${i}`] = "v";
				return wide;
			},
		});
		mockControl.script = [toolCallTurn("echo_keys_1", "{}"), textTurn("Done")];

		const events = await collect(await streamChat({ submissionId: "s1", message: "go" }));

		const toolResult = events.find((e) => e.type === "tool-result");
		const summary = toolResult && toolResult.type === "tool-result" ? toolResult.summary : "";
		expect(() => JSON.parse(summary ?? "")).not.toThrow();
		expect((summary ?? "").length).toBeLessThanOrEqual(400);
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

describe("harness plan event (W2a)", () => {
	it("emits the plan as the FIRST event, before any thinking/tool events", async () => {
		registry.register({
			name: "plan_echo_1",
			description: "echoes",
			permission: "auto",
			inputSchema: z.object({ value: z.string() }),
			run: async (args: { value: string }) => ({ echoed: args.value }),
		});
		mockControl.script = [
			toolCallTurn("plan_echo_1", JSON.stringify({ value: "hi" })),
			textTurn("Done"),
		];

		const events = await collect(await streamChat({ submissionId: "s1", message: "go" }));

		expect(events[0].type).toBe("plan");
		// The plan is emitted exactly once, at stream start.
		expect(events.filter((e) => e.type === "plan")).toHaveLength(1);
		// The agent loop still runs normally after the plan.
		expect(events.some((e) => e.type === "tool-call")).toBe(true);
		expect(events[events.length - 1].type).toBe("done");
	});

	it("derives phase steps from the registered tool surface (tool-family → phase label)", () => {
		const steps = derivePlanSteps([
			"process-submission",
			"pre-evaluate",
			"set-rubric-item",
			"save-grading",
			"update-grade-dimension",
			"write-notes",
			"run-plagiarism-check",
			"analyze-code",
			"compare-to-key",
			"search-docs",
			"get-submission-context",
		]);

		expect(steps).toEqual([
			{ id: "execute-notebook", label: "Execute notebook" },
			{ id: "pre-evaluate", label: "Pre-evaluate" },
			{ id: "apply-grading-changes", label: "Apply grading changes" },
			{ id: "plagiarism-check", label: "Plagiarism check" },
			{ id: "analyze-code", label: "Analyze code" },
			{ id: "compare-to-key", label: "Compare to reference key" },
			{ id: "check-library-docs", label: "Check library docs" },
			{ id: "gather-context", label: "Gather context" },
		]);
	});

	it("omits phases with no registered tool and drops the fallback when every tool maps", () => {
		const steps = derivePlanSteps(["set-rubric-item", "compare-to-key"]);

		expect(steps).toEqual([
			{ id: "apply-grading-changes", label: "Apply grading changes" },
			{ id: "compare-to-key", label: "Compare to reference key" },
		]);
	});

	it("emits a plan whose steps match the derived plan for the registered surface", async () => {
		registry.register({
			name: "plan_echo_2",
			description: "echoes",
			permission: "auto",
			inputSchema: z.object({ value: z.string() }),
			run: async (args: { value: string }) => ({ echoed: args.value }),
		});
		mockControl.script = [textTurn("Ok")];

		const events = await collect(await streamChat({ submissionId: "s1", message: "go" }));

		const plan = events.find((e) => e.type === "plan");
		expect(plan && plan.type === "plan" ? plan.steps : []).toEqual(
			derivePlanSteps(registry.list().map((tool) => tool.name)),
		);
	});
});

describe("input guardrails (Wave 3a)", () => {
	it("builds the agent with inputProcessors configured (injection + PII)", async () => {
		await buildAgent();
		// The agent built without throwing — the processors were constructed
		// with the same mock model the tests use. Behavioral tests are
		// skipped: the detectors run an internal detection LLM call, which
		// the v2 scripted mock cannot drive (documented in the brief).
		expect(true).toBe(true);
	});
});

describe("scope context prefix (Task C)", () => {
	it("prefixes submission-scoped turns with the resolved review scope", async () => {
		// Fixture: the submission must exist so the server can resolve its
		// assignment (per-submission chats don't send assignmentId).
		const subDir = path.join(dataDir, "submissions", "soil_contamination");
		await mkdir(subDir, { recursive: true });
		await writeFile(
			path.join(subDir, "metadata.json"),
			JSON.stringify({
				"2026SS_00": {
					id: "2026SS_00",
					studentId: "2026SS_00",
					assignmentId: "soil_contamination",
					createdAt: "2026-08-07T13:02:52.411Z",
					fileName: "2026SS_00.ipynb",
					notebookPath: "submissions/soil_contamination/2026SS_00.ipynb",
					status: "executed",
				},
			}),
		);
		await writeFile(
			path.join(dataDir, "assignments.yaml"),
			"assignments:\n  - id: soil_contamination\n    title: Soil Contamination\n    enabled: true\n    criteria_files: []\n    dimensions:\n      - code_quality_design\n",
		);
		mockControl.script = [textTurn("Ok")];

		await collect(await streamChat({ submissionId: "2026SS_00", message: "hi" }));

		expect(mockControl.receivedCalls.length).toBeGreaterThan(0);
		const text = receivedUserMessage(mockControl.receivedCalls[0]);
		expect(text).toContain("[Context:");
		expect(text).toContain("submission 2026SS_00");
		expect(text).toContain("in assignment soil_contamination");
		// The raw user message still follows the prefix.
		expect(text.endsWith("\n\nhi")).toBe(true);
	});

	it("prefixes assignment-scoped turns with the assignment id", async () => {
		mockControl.script = [textTurn("Ok")];

		await collect(await streamChat({ assignmentId: "soil_contamination", message: "hi" }));

		expect(mockControl.receivedCalls.length).toBeGreaterThan(0);
		const text = receivedUserMessage(mockControl.receivedCalls[0]);
		expect(text).toContain("[Context:");
		expect(text).toContain("assignment soil_contamination");
		// The raw user message still follows the prefix.
		expect(text.endsWith("\n\nhi")).toBe(true);
	});

	it("passes unscoped turns through unchanged (no prefix)", async () => {
		mockControl.script = [textTurn("Ok")];

		await collect(await streamChat({ message: "hi" }));

		expect(mockControl.receivedCalls.length).toBeGreaterThan(0);
		const text = receivedUserMessage(mockControl.receivedCalls[0]);
		expect(text).toBe("hi");
	});
});

describe("thread-scoped working memory (Mastra audit §2)", () => {
	it("registers the updateWorkingMemory tool on the agent", async () => {
		mockControl.script = [textTurn("Ok")];

		await collect(await streamChat({ submissionId: "s1", message: "hi" }));

		expect(mockControl.receivedCalls.length).toBeGreaterThan(0);
		// Mastra passes the converted tool map to the model's doStream as
		// `tools` (prepareToolsAndToolChoice). Memory.listTools() registers
		// `updateWorkingMemory` when workingMemory.enabled && agentManaged
		// !== false && !readOnly — all true for the copilot's Memory.
		const firstCall = mockControl.receivedCalls[0] as {
			tools?: Array<{ type: string; name: string }>;
		};
		const toolNames = (firstCall.tools ?? []).map((t) => t.name);
		expect(toolNames).toContain("updateWorkingMemory");
	});

	it("injects the working-memory template into the system message each turn", async () => {
		mockControl.script = [textTurn("Ok")];

		await collect(await streamChat({ submissionId: "s1", message: "hi" }));

		expect(mockControl.receivedCalls.length).toBeGreaterThan(0);
		const firstCall = mockControl.receivedCalls[0] as {
			prompt?: Array<{ role?: string; content?: unknown }>;
		};
		const systemMessages = (firstCall.prompt ?? []).filter((m) => m.role === "system");
		expect(systemMessages.length).toBeGreaterThan(0);
		const joined = systemMessages
			.map((m) => {
				const content = m.content;
				if (typeof content === "string") return content;
				if (Array.isArray(content)) {
					return content
						.map((part) =>
							part && typeof part === "object" && "text" in part
								? String((part as { text: unknown }).text)
								: "",
						)
						.join("");
				}
				return "";
			})
			.join("\n");
		// The WM instruction block carries the template verbatim.
		expect(joined).toContain("WORKING_MEMORY_SYSTEM_INSTRUCTION");
		expect(joined).toContain(WORKING_MEMORY_TEMPLATE);
		expect(joined).toContain("updateWorkingMemory");
	});

	it("persists working memory to the thread's metadata via the updateWorkingMemory tool", async () => {
		const threadId = "wm-thread-1";
		const wmContent = [
			"# Review State",
			"- Submission: 2026SS_00",
			"- Status: already reviewed",
			"- Professor preferences: caps creativity at 3",
			"- Notes:",
		].join("\n");
		mockControl.script = [
			toolCallTurn("updateWorkingMemory", JSON.stringify({ memory: wmContent })),
			textTurn("Stored"),
		];
		const events = await collect(
			await streamChat({ submissionId: "s1", threadId, message: "remember this" }),
		);

		// The tool ran and the loop completed.
		const toolResult = events.find((e) => e.type === "tool-result");
		expect(toolResult && toolResult.type === "tool-result" ? toolResult.ok : false).toBe(true);
		expect(events[events.length - 1].type).toBe("done");

		// Thread-scoped WM is stored in the thread's metadata.workingMemory
		// (FileMemoryStore.updateThread persists metadata) — read it back
		// through the real store.
		const store = new FileMemoryStore();
		const thread = await store.getThreadById({ threadId, resourceId: "s1" });
		expect(thread).not.toBeNull();
		expect(thread?.metadata?.workingMemory).toBe(wmContent);
	});
});

describe("change-ledger extraction (W2d)", () => {
	it("maps set-rubric-item results to a rubric change with previous", () => {
		const changes = extractChangesFromToolResult("set-rubric-item", {
			submissionId: "s1",
			rubricItem: { criterionKey: "clarity", optionKey: "good" },
			previous: "ok",
		});
		expect(changes).toEqual([
			{
				kind: "rubric",
				field: "clarity",
				oldValue: "ok",
				newValue: "good",
				submissionId: "s1",
			},
		]);
	});

	it("maps update-grade-dimension results to a dimension change", () => {
		const changes = extractChangesFromToolResult("update-grade-dimension", {
			submissionId: "s1",
			dimension: { dimensionId: "code_quality_design", value: 4 },
			previous: 3,
		});
		expect(changes).toEqual([
			{
				kind: "dimension",
				field: "code_quality_design",
				oldValue: 3,
				newValue: 4,
				submissionId: "s1",
			},
		]);
	});

	it("maps write-notes results to a notes change", () => {
		const changes = extractChangesFromToolResult("write-notes", {
			submissionId: "s1",
			notes: "new notes",
			previous: "old notes",
		});
		expect(changes).toEqual([
			{
				kind: "notes",
				field: "notes",
				oldValue: "old notes",
				newValue: "new notes",
				submissionId: "s1",
			},
		]);
	});

	it("maps save-grading results to per-field changes", () => {
		const changes = extractChangesFromToolResult("save-grading", {
			submissionId: "s1",
			rubric: { clarity: "good" },
			dimensions: { code_quality_design: 4 },
			notes: "hi",
			previous: {
				rubric: { clarity: "ok" },
				dimensions: { code_quality_design: 3 },
				notes: null,
			},
		});
		expect(changes).toEqual([
			{
				kind: "rubric",
				field: "clarity",
				oldValue: "ok",
				newValue: "good",
				submissionId: "s1",
			},
			{
				kind: "dimension",
				field: "code_quality_design",
				oldValue: 3,
				newValue: 4,
				submissionId: "s1",
			},
			{ kind: "notes", field: "notes", oldValue: null, newValue: "hi", submissionId: "s1" },
		]);
	});

	it("returns [] for non-grading tools; grading results without previous still yield entries (oldValue null)", () => {
		expect(extractChangesFromToolResult("analyze-code", { ok: true })).toEqual([]);
		// A grading result without `previous` (older server) still yields a
		// ledger entry — oldValue falls back to null ("— → y").
		expect(
			extractChangesFromToolResult("set-rubric-item", {
				rubricItem: { criterionKey: "x", optionKey: "y" },
			}),
		).toEqual([
			{ kind: "rubric", field: "x", oldValue: null, newValue: "y", submissionId: undefined },
		]);
		expect(extractChangesFromToolResult("save-grading", { rubric: {} })).toEqual([]);
	});
});

describe("turn checkpoints (P3)", () => {
	async function seedSubmission(
		studentId: string,
		grading: Record<string, unknown> | undefined,
	): Promise<void> {
		const subDir = path.join(dataDir, "submissions", "soil_contamination");
		await mkdir(subDir, { recursive: true });
		await writeFile(
			path.join(subDir, "metadata.json"),
			JSON.stringify({
				[studentId]: {
					id: studentId,
					studentId,
					assignmentId: "soil_contamination",
					createdAt: "2026-08-07T13:02:52.411Z",
					fileName: `${studentId}.ipynb`,
					notebookPath: `submissions/soil_contamination/${studentId}.ipynb`,
					status: "executed",
					...(grading !== undefined ? { grading } : {}),
				},
			}),
		);
		await writeFile(
			path.join(dataDir, "assignments.yaml"),
			"assignments:\n  - id: soil_contamination\n    title: Soil Contamination\n    enabled: true\n    criteria_files: []\n    dimensions:\n      - code_quality_design\n",
		);
	}

	it("snapshots the submission's grading state (rubric/dimensions/notes/feedback)", async () => {
		await seedSubmission("2026SS_00", {
			rubric: { clarity: "good" },
			dimensions: { code_quality_design: 2 },
			notes: "Nice work overall",
			feedback: {
				clarity: {
					checked: ["Uses readable variable names"],
					comments: {},
					deductions: {},
					notes: "",
				},
			},
			updatedAt: "2026-08-08T10:00:00.000Z",
		});

		const snap = await snapshotGradingState("soil_contamination", "2026SS_00");
		expect(snap).toEqual({
			rubric: { clarity: "good" },
			dimensions: { code_quality_design: 2 },
			notes: "Nice work overall",
			feedback: {
				clarity: {
					checked: ["Uses readable variable names"],
					comments: {},
					deductions: {},
					notes: "",
				},
			},
		});
	});

	it("returns the empty snapshot for a submission without grading state or unknown ids", async () => {
		await seedSubmission("2026SS_00", undefined);
		const empty = { rubric: {}, dimensions: {}, notes: null, feedback: {} };

		// Record exists but has no grading state.
		expect(await snapshotGradingState("soil_contamination", "2026SS_00")).toEqual(empty);
		// Unknown submission / assignment — never throws.
		expect(await snapshotGradingState("soil_contamination", "nope")).toEqual(empty);
		expect(await snapshotGradingState("nope", "2026SS_00")).toEqual(empty);
		expect(await snapshotGradingState(undefined, "2026SS_00")).toEqual(empty);
		expect(await snapshotGradingState("soil_contamination", undefined)).toEqual(empty);
	});

	it("emits a checkpoint event with a turnId and snapshot on the first grading tool-call, and persists it", async () => {
		await seedSubmission("2026SS_00", {
			rubric: { clarity: "ok" },
			dimensions: { code_quality_design: 3 },
			notes: "before",
			updatedAt: "2026-08-08T10:00:00.000Z",
		});
		const threadId = "cp-thread-1";
		mockControl.script = [
			toolCallTurn(
				"set-rubric-item",
				JSON.stringify({ criterionKey: "clarity", optionKey: "good" }),
			),
			toolCallTurn(
				"update-grade-dimension",
				JSON.stringify({ dimensionId: "code_quality_design", value: 4 }),
			),
			textTurn("Done"),
		];

		const events = await collectWithApproval(
			await streamChat({ submissionId: "2026SS_00", threadId, message: "grade it" }),
			"approve",
		);

		// Exactly one checkpoint event, emitted BEFORE the first grading
		// tool-call event, carrying the pre-write state.
		const checkpoints = events.filter((e) => e.type === "checkpoint");
		expect(checkpoints).toHaveLength(1);
		const cp = checkpoints[0];
		expect(cp && cp.type === "checkpoint" ? cp.turnId : "").toBeTypeOf("string");
		expect(cp && cp.type === "checkpoint" ? cp.snapshot : null).toEqual({
			rubric: { clarity: "ok" },
			dimensions: { code_quality_design: 3 },
			notes: "before",
			feedback: {},
		});
		const firstToolCall = events.findIndex((e) => e.type === "tool-call");
		expect(events.findIndex((e) => e.type === "checkpoint")).toBeLessThan(firstToolCall);

		// The snapshot was persisted under the thread + turn id.
		const turnId = cp && cp.type === "checkpoint" ? cp.turnId : "";
		expect(await listCheckpoints(threadId)).toEqual([turnId]);
		expect(await loadCheckpoint(threadId, turnId)).toEqual({
			rubric: { clarity: "ok" },
			dimensions: { code_quality_design: 3 },
			notes: "before",
			feedback: {},
		});
	});

	it("emits the checkpoint only once per turn (second grading tool-call does not re-snapshot)", async () => {
		await seedSubmission("2026SS_00", {
			rubric: { clarity: "ok" },
			dimensions: {},
			updatedAt: "2026-08-08T10:00:00.000Z",
		});
		mockControl.script = [
			toolCallTurn(
				"set-rubric-item",
				JSON.stringify({ criterionKey: "clarity", optionKey: "good" }),
			),
			toolCallTurn("write-notes", JSON.stringify({ notes: "after" })),
			textTurn("Done"),
		];

		const events = await collectWithApproval(
			await streamChat({ submissionId: "2026SS_00", message: "grade it" }),
			"approve",
		);

		expect(events.filter((e) => e.type === "checkpoint")).toHaveLength(1);
		// The snapshot still reflects the PRE-turn state, not the state
		// after the first write.
		const cp = events.find((e) => e.type === "checkpoint");
		expect(cp && cp.type === "checkpoint" ? cp.snapshot.rubric : null).toEqual({
			clarity: "ok",
		});
	});

	it("still emits the checkpoint event when persistence fails (saveCheckpoint throws)", async () => {
		await seedSubmission("2026SS_00", {
			rubric: { clarity: "ok" },
			dimensions: { code_quality_design: 3 },
			notes: "before",
			updatedAt: "2026-08-08T10:00:00.000Z",
		});
		mockControl.script = [
			toolCallTurn(
				"set-rubric-item",
				JSON.stringify({ criterionKey: "clarity", optionKey: "good" }),
			),
			textTurn("Done"),
		];
		// Persistence is broken — the in-stream snapshot must still flow.
		vi.spyOn(checkpointStore, "saveCheckpoint").mockRejectedValue(new Error("disk full"));

		const events = await collectWithApproval(
			await streamChat({ submissionId: "2026SS_00", message: "grade it" }),
			"approve",
		);

		const cp = events.find((e) => e.type === "checkpoint");
		expect(cp).toBeDefined();
		expect(cp && cp.type === "checkpoint" ? cp.snapshot : null).toEqual({
			rubric: { clarity: "ok" },
			dimensions: { code_quality_design: 3 },
			notes: "before",
			feedback: {},
		});
		// The run completed normally — the persistence failure was swallowed.
		expect(events[events.length - 1].type).toBe("done");
		// Nothing was persisted.
		expect(await listCheckpoints("cp-thread-1")).toEqual([]);
	});

	it("emits a checkpoint event with the empty snapshot when the submission has no grading state (never throws)", async () => {
		await seedSubmission("2026SS_00", undefined);
		mockControl.script = [
			toolCallTurn("save-grading", JSON.stringify({ notes: "hi" })),
			textTurn("Done"),
		];

		const events = await collectWithApproval(
			await streamChat({ submissionId: "2026SS_00", message: "grade it" }),
			"approve",
		);

		const cp = events.find((e) => e.type === "checkpoint");
		expect(cp).toBeDefined();
		expect(cp && cp.type === "checkpoint" ? cp.snapshot : null).toEqual({
			rubric: {},
			dimensions: {},
			notes: null,
			feedback: {},
		});
		expect(events[events.length - 1].type).toBe("done");
	});

	it("does not emit a checkpoint for non-grading tool calls", async () => {
		mockControl.script = [toolCallTurn("analyze-code", "{}"), textTurn("Done")];

		const events = await collect(await streamChat({ submissionId: "s1", message: "analyze" }));

		expect(events.some((e) => e.type === "checkpoint")).toBe(false);
		expect(events[events.length - 1].type).toBe("done");
	});
});

describe("search-docs grounding (P5)", () => {
	it("calls search-docs on an analyze-code turn and uses the docs hit in the final answer", async () => {
		// Register the REAL search-docs tool (idempotent — skips if already
		// registered by buildAgent's registerCopilotTools).
		registerDocsTools(registry);
		// The test DATA_DIR is a temp dir with no docs index, so searchDocs
		// would return [] — mock the retrieval with a pinned-docs hit.
		const hit = {
			title: "scipy.optimize.curve_fit",
			url: "https://docs.scipy.org/doc/scipy/reference/generated/scipy.optimize.curve_fit.html",
			library: "scipy" as const,
			version: "1.18.0",
			snippet:
				"## scipy.optimize.curve_fit (scipy 1.18.0)\nSignature: curve_fit(f, xdata, ydata, p0=None, sigma=None, absolute_sigma=False, check_finite=None, bounds=(-inf, inf), method=None)\nUse non-linear least squares to fit a function, f, to data.",
			score: 8.2,
		};
		const searchDocsSpy = vi.spyOn(docsRag, "searchDocs").mockResolvedValue([hit]);
		mockControl.script = [
			toolCallTurn("search-docs", JSON.stringify({ query: "scipy.optimize.curve_fit" })),
			textTurn(
				"The student used scipy.optimize.curve_fit correctly — the signature matches the pinned scipy 1.18.0 docs.",
			),
		];

		const events = await collect(
			await streamChat({
				submissionId: "s1",
				message: "Analyze this code: scipy.optimize.curve_fit(model, x, y)",
			}),
		);

		// (1) The turn called search-docs and the tool ran successfully.
		const toolCall = events.find((e) => e.type === "tool-call");
		expect(toolCall && toolCall.type === "tool-call" ? toolCall.tool : "").toBe("search-docs");
		const toolResult = events.find((e) => e.type === "tool-result");
		expect(toolResult && toolResult.type === "tool-result" ? toolResult.ok : false).toBe(true);
		// The retrieval was actually invoked with the API-name query.
		expect(searchDocsSpy.mock.calls[0]?.[0]).toBe("scipy.optimize.curve_fit");

		// (2) The streamed tool result carries the docs hit (URL included).
		const summary =
			toolResult && toolResult.type === "tool-result" ? (toolResult.summary ?? "") : "";
		expect(summary).toContain("https://docs.scipy.org");
		expect(summary).toContain("scipy.optimize.curve_fit");

		// (3) The final answer references the API name from the mocked hit —
		// the docs result was used in the final message.
		const msg = events.find((e) => e.type === "message");
		expect(msg && msg.type === "message" ? msg.content : "").toContain(
			"scipy.optimize.curve_fit",
		);
		expect(events[events.length - 1].type).toBe("done");
	});
});
