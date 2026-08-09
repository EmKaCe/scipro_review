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

import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
		const s1 = await streamChat({ submissionId: "2026SS_00", message: "first", threadId: "t-1" });
		for await (const _ of s1) {
			// consume
		}
		const s2 = await streamChat({ submissionId: "2026SS_00", message: "second", threadId: "t-1" });
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
		const s1 = await streamChat({ submissionId: "2026SS_00", message: "hello one", threadId: "t-2" });
		for await (const _ of s1) {
			// consume
		}
		__resetAgentForTests(); // simulates server restart — file adapter re-instantiated on same dir
		mockControl.script = [textTurn("reply two")];
		const s2 = await streamChat({ submissionId: "2026SS_00", message: "hello two", threadId: "t-2" });
		for await (const _ of s2) {
			// consume
		}
		const lastCall = mockControl.receivedCalls.at(-1) as { prompt?: unknown };
		expect(JSON.stringify(lastCall.prompt)).toContain("hello one");
	});
});
