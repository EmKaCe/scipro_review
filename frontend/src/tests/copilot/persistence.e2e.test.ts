// @vitest-environment node
/**
 * @file Persistence e2e — the definitive proof for Issue A.
 *
 * Two turns with the SAME threadId must (1) persist thread + messages under
 * DATA_DIR/copilot/memory/ and (2) recall earlier turns into the model input,
 * including across a simulated server restart (fresh agent singleton).
 *
 * The Mastra Agent runs for real against the scripted AI SDK v2 mock; the
 * memory resource resolves via the `mastra__resourceId` requestContext key
 * set in runChat (A.1) and the threadId is passed through (A.2 sends it).
 */

import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import { __resetAgentForTests, streamChat } from "$lib/server/copilot/agent";

const STREAM_START: V2Part = { type: "stream-start" };
const FINISH_STOP: V2Part = {
	type: "finish",
	finishReason: "stop",
	usage: { inputTokens: 1, outputTokens: 1 },
};

/** One plain text turn: stream-start / text-start / text-delta / text-end / finish(stop). */
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
// Fixture + helpers
// ---------------------------------------------------------------------------

let dataDir: string;

async function fileExists(file: string): Promise<boolean> {
	try {
		await access(file);
		return true;
	} catch {
		return false;
	}
}

/** The submission must exist so the server can resolve its assignment. */
async function writeFixture() {
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
}

beforeEach(async () => {
	dataDir = await mkdtemp(path.join(tmpdir(), "copilot-persist-"));
	process.env.DATA_DIR = dataDir;
	mockControl.script = [];
	mockControl.receivedCalls = [];
	await writeFixture();
	__resetAgentForTests();
});

afterEach(async () => {
	delete process.env.DATA_DIR;
	__resetAgentForTests();
	await rm(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("copilot persistence e2e (Issue A)", () => {
	it("persists thread + messages for two turns with the same threadId", async () => {
		mockControl.script = [textTurn("first reply"), textTurn("second reply")];
		const s1 = await streamChat({
			submissionId: "2026SS_00",
			message: "first",
			threadId: "t-1",
		});
		for await (const _ of s1) {
			// consume
		}
		const s2 = await streamChat({
			submissionId: "2026SS_00",
			message: "second",
			threadId: "t-1",
		});
		for await (const _ of s2) {
			// consume
		}

		// Both the thread record and the message list were written to disk.
		expect(
			await fileExists(path.join(dataDir, "copilot", "memory", "threads", "t-1.json")),
		).toBe(true);
		expect(
			await fileExists(path.join(dataDir, "copilot", "memory", "messages", "t-1.json")),
		).toBe(true);
		// Recall: the second turn's LLM input includes the first user message.
		// (The AI SDK v2 doStream options carry the message list under `prompt`,
		// not `input`.)
		const lastCall = mockControl.receivedCalls.at(-1) as { prompt?: unknown };
		expect(JSON.stringify(lastCall.prompt)).toContain("first");
	});

	it("recalls history after a server restart (fresh agent singleton, same threadId)", async () => {
		mockControl.script = [textTurn("reply one")];
		const s1 = await streamChat({
			submissionId: "2026SS_00",
			message: "hello one",
			threadId: "t-2",
		});
		for await (const _ of s1) {
			// consume
		}
		__resetAgentForTests(); // simulates server restart — file adapter re-instantiated on same dir
		mockControl.script = [textTurn("reply two")];
		const s2 = await streamChat({
			submissionId: "2026SS_00",
			message: "hello two",
			threadId: "t-2",
		});
		for await (const _ of s2) {
			// consume
		}
		const lastCall = mockControl.receivedCalls.at(-1) as { prompt?: unknown };
		expect(JSON.stringify(lastCall.prompt)).toContain("hello one");
	});

	it("lastMessages window: with copilot.last_messages: 2 the third turn sees the 2nd user message but NOT the 1st", async () => {
		// A tiny window makes the rolling recall observable: after two
		// turns there are 4 stored messages; the third turn's model input
		// must contain only the last 2 (2nd user message + 1st reply).
		await writeFile(path.join(dataDir, "settings.yaml"), "copilot:\n  last_messages: 2\n");
		mockControl.script = [
			textTurn("reply one"),
			textTurn("reply two"),
			textTurn("reply three"),
		];
		for (const message of ["first", "second", "third"]) {
			const s = await streamChat({
				submissionId: "2026SS_00",
				message,
				threadId: "t-window",
			});
			for await (const _ of s) {
				// consume
			}
		}

		const thirdCall = mockControl.receivedCalls.at(-1) as { prompt?: unknown };
		const prompt = JSON.stringify(thirdCall.prompt);
		// The window dropped the oldest stored messages — the 1st user
		// message is out of the model's input; the 2nd is still in it.
		expect(prompt).toContain("second");
		expect(prompt).not.toContain("first");
		// Sanity: the current turn is always present.
		expect(prompt).toContain("third");
	});

	it("auto-compacts an outgrown thread and injects the summary as a system message (V.5)", async () => {
		// lastMessages: 2 + autoCompact: true — the brief's exact scenario.
		await writeFile(
			path.join(dataDir, "settings.yaml"),
			"copilot:\n  last_messages: 2\n  auto_compact: true\n",
		);
		const threadId = "t-compact";
		// Script order: one chat reply per turn; from turn 3 on, compaction
		// runs at the START of the turn (summarizer call) BEFORE the chat
		// call. The summarizer's output must be bullet-formatted — the
		// Observer extracts list items as the summary.
		mockControl.script = [
			textTurn("reply one"),
			textTurn("reply two"),
			textTurn("- Turn 3 summary: window crossed"),
			textTurn("reply three"),
			textTurn("- Turn 4 summary: window rolled again"),
			textTurn("reply four"),
			textTurn("- Turn 5 summary: window rolled yet again"),
			textTurn("reply five"),
		];
		const run = async (message: string) => {
			const s = await streamChat({ submissionId: "2026SS_00", message, threadId });
			for await (const _ of s) {
				// consume
			}
		};
		const meta = async (): Promise<Record<string, unknown>> => {
			const raw = await readFile(
				path.join(dataDir, "copilot", "memory", "threads", `${threadId}.json`),
				"utf8",
			);
			return (JSON.parse(raw) as { metadata: Record<string, unknown> }).metadata;
		};

		await run("first"); // 0 -> 2 stored messages
		await run("second"); // 2 -> 4
		// Turn 3's start count (4) first reaches 2 * lastMessages — the
		// crossing turn compacts BEFORE answering, then answers WITH the
		// fresh summary. (Each turn stores 2 messages — user + assistant —
		// so the threshold is crossed at turn 3's start, not turn 4's.)
		await run("third");
		let m = await meta();
		expect(m.summary).toBe("- Turn 3 summary: window crossed");
		expect(m.summaryCount).toBe(1);
		expect(m.summarizedUpTo).toBe(4);
		expect(typeof m.lastSummaryAt).toBe("string");

		// The thread grew by lastMessages (2) again -> re-compact on turn 4.
		await run("fourth");
		m = await meta();
		expect(m.summaryCount).toBe(2);
		expect(m.summarizedUpTo).toBe(6);

		// Turn 5: compaction again, and the summary reaches the LLM via
		// opts.system (assertion 2 of the brief — "the summary text is in
		// the model input"). System messages are never persisted, so the
		// stored message list is NOT bloated by the summary.
		await run("fifth");
		m = await meta();
		expect(m.summaryCount).toBe(3);
		const lastCall = mockControl.receivedCalls.at(-1) as { prompt?: unknown };
		const prompt = JSON.stringify(lastCall.prompt);
		expect(prompt).toContain("Summary of the earlier conversation");
		expect(prompt).toContain("- Turn 5 summary: window rolled yet again");
		// Sanity: raw messages are kept — the thread stays a full audit trail.
		const stored = await readFile(
			path.join(dataDir, "copilot", "memory", "messages", `${threadId}.json`),
			"utf8",
		);
		expect(JSON.parse(stored)).toHaveLength(10);
	});

	it("does NOT re-summarize until the thread grows by a full window again (V.5 gate)", async () => {
		// lastMessages: 4 — per-turn growth (2 stored messages) is HALF a
		// window, so the re-compaction gate is observable: after the first
		// compaction (turn 5, 8 messages = 2x window), turn 6 grows by only
		// 2 (< 4) and must NOT re-summarize; turn 7 (growth 4) re-compacts.
		await writeFile(
			path.join(dataDir, "settings.yaml"),
			"copilot:\n  last_messages: 4\n  auto_compact: true\n",
		);
		const threadId = "t-gate";
		mockControl.script = [
			textTurn("reply one"),
			textTurn("reply two"),
			textTurn("reply three"),
			textTurn("reply four"),
			textTurn("- Gate summary: crossed 2x window"),
			textTurn("reply five"),
			textTurn("reply six"),
			textTurn("- Gate summary: window grew again"),
			textTurn("reply seven"),
		];
		const run = async (message: string) => {
			const s = await streamChat({ submissionId: "2026SS_00", message, threadId });
			for await (const _ of s) {
				// consume
			}
		};
		const meta = async (): Promise<Record<string, unknown>> => {
			const raw = await readFile(
				path.join(dataDir, "copilot", "memory", "threads", `${threadId}.json`),
				"utf8",
			);
			return (JSON.parse(raw) as { metadata: Record<string, unknown> }).metadata;
		};

		for (const message of ["first", "second", "third", "fourth"]) await run(message); // 0 -> 8
		// Turn 5's start count (8) reaches 2 * lastMessages -> first compaction.
		await run("fifth");
		let m = await meta();
		expect(m.summaryCount).toBe(1);
		expect(m.summary).toBe("- Gate summary: crossed 2x window");

		// Turn 6: only 2 new messages since the summary (delta 2 < 4) — no
		// re-compaction, and NO summary is injected into the model input.
		await run("sixth");
		m = await meta();
		expect(m.summaryCount).toBe(1);
		const sixthCall = mockControl.receivedCalls.at(-1) as { prompt?: unknown };
		expect(JSON.stringify(sixthCall.prompt)).not.toContain(
			"Summary of the earlier conversation",
		);

		// Turn 7: the thread has grown by a full window (delta 4) — the gate
		// releases and the summary is refreshed.
		await run("seventh");
		m = await meta();
		expect(m.summaryCount).toBe(2);
		expect(m.summarizedUpTo).toBe(12);
		expect(m.summary).toBe("- Gate summary: window grew again");
	});
});
