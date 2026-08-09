// @vitest-environment node
/**
 * @file Unit + integration tests for automatic compaction (Task V.2).
 *
 * Unit tests drive maybeCompactThread against a real FileMemoryStore on a
 * temp DATA_DIR with an injected fake `summarize`. The integration test
 * runs the DEFAULT summarize path — Mastra's Observational-Memory Observer
 * over the repo's v2 mock model — and proves a real summary is produced and
 * written to thread metadata.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MastraDBMessage, StorageThreadType } from "@mastra/core/memory";
import type { SummarizeModel } from "@mastra/memory";

import { FileMemoryStore } from "$lib/server/copilot/file-memory";
import { maybeCompactThread } from "$lib/server/copilot/compaction";
import { resolveSummarySizeTokens } from "$lib/server/copilot/model-context";
import type { CopilotSettings } from "$lib/server/settings";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let dataDir: string;
let store: FileMemoryStore;

const DEFAULT_MODEL_ID = "qwen3-30b-a3b-instruct-2507";

function settings(overrides: Partial<CopilotSettings> = {}): CopilotSettings {
	return {
		mode: "ask",
		allowedTools: [],
		denyTools: [],
		approvalTtlSeconds: 60,
		sessionCap: 20,
		lastMessages: 4,
		autoCompact: true,
		...overrides,
	};
}

function thread(
	id: string,
	resourceId: string,
	metadata?: Record<string, unknown>,
): StorageThreadType {
	return {
		id,
		resourceId,
		createdAt: new Date("2026-08-01T10:00:00Z"),
		updatedAt: new Date("2026-08-01T10:00:00Z"),
		...(metadata ? { metadata } : {}),
	};
}

/** A V2 text-only stored message (the shape Mastra actually writes). */
function textMessage(
	id: string,
	threadId: string,
	resourceId: string,
	role: "user" | "assistant",
	text: string,
	createdAt: Date,
): MastraDBMessage {
	return {
		id,
		threadId,
		resourceId,
		role,
		content: { format: 2, parts: [{ type: "text", text }] },
		createdAt,
	};
}

/** Seed a thread with `count` alternating user/assistant messages. */
async function seedThread(count: number, threadId = "t-1", resourceId = "sub-1"): Promise<void> {
	await store.saveThread({ thread: thread(threadId, resourceId) });
	const messages: MastraDBMessage[] = [];
	for (let i = 0; i < count; i++) {
		messages.push(
			textMessage(
				`m-${i}`,
				threadId,
				resourceId,
				i % 2 === 0 ? "user" : "assistant",
				`Message ${i}`,
				new Date(Date.UTC(2026, 7, 1, 10, i)),
			),
		);
	}
	await store.saveMessages({ messages });
}

async function readThread(threadId = "t-1"): Promise<StorageThreadType | null> {
	return store.getThreadById({ threadId });
}

/** Fake summarizer that records calls. */
function fakeSummarize(summary = "Summarized content") {
	return vi.fn(async () => ({ summary }));
}

beforeEach(async () => {
	dataDir = await mkdtemp(path.join(tmpdir(), "copilot-compaction-"));
	process.env.DATA_DIR = dataDir;
	store = new FileMemoryStore();
});

afterEach(async () => {
	delete process.env.DATA_DIR;
	await rm(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

describe("maybeCompactThread (V.2)", () => {
	it("does not compact below the 2x window threshold", async () => {
		await seedThread(6); // lastMessages=4 → needs >= 8
		const summarize = fakeSummarize();

		const result = await maybeCompactThread({
			threadId: "t-1",
			resourceId: "sub-1",
			settings: settings(),
			model: {} as SummarizeModel,
			modelId: DEFAULT_MODEL_ID,
			summarize,
		});

		expect(result).toEqual({ compacted: false });
		expect(summarize).not.toHaveBeenCalled();
		expect((await readThread())?.metadata?.summaryCount).toBeUndefined();
	});

	it("compacts for the first time at 2 * lastMessages messages", async () => {
		await seedThread(8);
		const summarize = fakeSummarize("First summary");

		const result = await maybeCompactThread({
			threadId: "t-1",
			resourceId: "sub-1",
			settings: settings(),
			model: {} as SummarizeModel,
			modelId: DEFAULT_MODEL_ID,
			summarize,
		});

		expect(result).toEqual({ compacted: true, summary: "First summary" });
		expect(summarize).toHaveBeenCalledTimes(1);
		expect(summarize).toHaveBeenCalledWith({ threadId: "t-1", resourceId: "sub-1" });
	});

	it("re-compacts only after the thread grows by lastMessages again", async () => {
		await seedThread(8);
		await maybeCompactThread({
			threadId: "t-1",
			resourceId: "sub-1",
			settings: settings(),
			model: {} as SummarizeModel,
			modelId: DEFAULT_MODEL_ID,
			summarize: fakeSummarize("First summary"),
		});

		// +2 messages → 10 total, delta = 2 < lastMessages(4): no re-compact.
		await store.saveMessages({
			messages: [
				textMessage(
					"m-8",
					"t-1",
					"sub-1",
					"user",
					"Message 8",
					new Date(Date.UTC(2026, 7, 1, 11, 0)),
				),
				textMessage(
					"m-9",
					"t-1",
					"sub-1",
					"assistant",
					"Message 9",
					new Date(Date.UTC(2026, 7, 1, 11, 1)),
				),
			],
		});
		const summarize2 = fakeSummarize("Second summary");
		const result2 = await maybeCompactThread({
			threadId: "t-1",
			resourceId: "sub-1",
			settings: settings(),
			model: {} as SummarizeModel,
			modelId: DEFAULT_MODEL_ID,
			summarize: summarize2,
		});
		expect(result2).toEqual({ compacted: false });
		expect(summarize2).not.toHaveBeenCalled();

		// +2 more → 12 total, delta = 4 >= lastMessages: re-compact.
		await store.saveMessages({
			messages: [
				textMessage(
					"m-10",
					"t-1",
					"sub-1",
					"user",
					"Message 10",
					new Date(Date.UTC(2026, 7, 1, 11, 2)),
				),
				textMessage(
					"m-11",
					"t-1",
					"sub-1",
					"assistant",
					"Message 11",
					new Date(Date.UTC(2026, 7, 1, 11, 3)),
				),
			],
		});
		const summarize3 = fakeSummarize("Third summary");
		const result3 = await maybeCompactThread({
			threadId: "t-1",
			resourceId: "sub-1",
			settings: settings(),
			model: {} as SummarizeModel,
			modelId: DEFAULT_MODEL_ID,
			summarize: summarize3,
		});
		expect(result3).toEqual({ compacted: true, summary: "Third summary" });
		expect(summarize3).toHaveBeenCalledTimes(1);

		const meta = (await readThread())?.metadata as Record<string, unknown>;
		expect(meta.summaryCount).toBe(2);
		expect(meta.summarizedUpTo).toBe(12);
		expect(meta.summary).toBe("Third summary");
	});

	it("writes the summary metadata fields (summary, summarizedUpTo, summaryCount, lastSummaryAt)", async () => {
		await seedThread(8);

		const result = await maybeCompactThread({
			threadId: "t-1",
			resourceId: "sub-1",
			settings: settings(),
			model: {} as SummarizeModel,
			modelId: DEFAULT_MODEL_ID,
			summarize: fakeSummarize("Dense bullet summary"),
		});

		expect(result.compacted).toBe(true);
		const meta = (await readThread())?.metadata as Record<string, unknown>;
		expect(meta.summary).toBe("Dense bullet summary");
		expect(meta.summarizedUpTo).toBe(8);
		expect(meta.summaryCount).toBe(1);
		expect(typeof meta.lastSummaryAt).toBe("string");
		expect(Number.isNaN(Date.parse(meta.lastSummaryAt as string))).toBe(false);
	});

	it("caps a verbose summary to resolveSummarySizeTokens(modelId) * 4 chars", async () => {
		await seedThread(8);
		const capChars = resolveSummarySizeTokens(DEFAULT_MODEL_ID) * 4;
		expect(capChars).toBe(6552); // 0.05 * 32768 = 1638 tokens * 4
		const longSummary = "x".repeat(capChars + 5000);

		const result = await maybeCompactThread({
			threadId: "t-1",
			resourceId: "sub-1",
			settings: settings(),
			model: {} as SummarizeModel,
			modelId: DEFAULT_MODEL_ID,
			summarize: fakeSummarize(longSummary),
		});

		expect(result.compacted).toBe(true);
		if (result.compacted) {
			expect(result.summary.length).toBe(capChars);
		}
		const meta = (await readThread())?.metadata as Record<string, unknown>;
		expect((meta.summary as string).length).toBe(capChars);
	});

	it("never compacts when autoCompact is false (cost guard)", async () => {
		await seedThread(8);
		const summarize = fakeSummarize();

		const result = await maybeCompactThread({
			threadId: "t-1",
			resourceId: "sub-1",
			settings: settings({ autoCompact: false }),
			model: {} as SummarizeModel,
			modelId: DEFAULT_MODEL_ID,
			summarize,
		});

		expect(result).toEqual({ compacted: false });
		expect(summarize).not.toHaveBeenCalled();
	});

	it("concurrent calls on the same thread summarize only once", async () => {
		await seedThread(8);
		const summarize = vi.fn(async () => {
			await new Promise((resolve) => setTimeout(resolve, 25));
			return { summary: "Delayed summary" };
		});

		const [a, b] = await Promise.all([
			maybeCompactThread({
				threadId: "t-1",
				resourceId: "sub-1",
				settings: settings(),
				model: {} as SummarizeModel,
				modelId: DEFAULT_MODEL_ID,
				summarize,
			}),
			maybeCompactThread({
				threadId: "t-1",
				resourceId: "sub-1",
				settings: settings(),
				model: {} as SummarizeModel,
				modelId: DEFAULT_MODEL_ID,
				summarize,
			}),
		]);

		expect(summarize).toHaveBeenCalledTimes(1);
		expect([a.compacted, b.compacted].filter(Boolean)).toHaveLength(1);
		const meta = (await readThread())?.metadata as Record<string, unknown>;
		expect(meta.summaryCount).toBe(1);
	});

	it("returns { compacted: false } for a missing thread", async () => {
		const summarize = fakeSummarize();
		const result = await maybeCompactThread({
			threadId: "t-ghost",
			resourceId: "sub-1",
			settings: settings(),
			model: {} as SummarizeModel,
			modelId: DEFAULT_MODEL_ID,
			summarize,
		});
		expect(result).toEqual({ compacted: false });
		expect(summarize).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// Integration test — real Memory + v2 mock model through the DEFAULT path
// ---------------------------------------------------------------------------

// The v2 mock model (hoisted so the scripted doStream is shared): the
// Observer's single stream call is answered with a bullet-list textTurn —
// summarizeThread uses the model's doStream path, not doGenerate.
const { mockModel, mockControl } = vi.hoisted(() => {
	const mockControl = {
		script: [] as Record<string, unknown>[][],
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

describe("maybeCompactThread default summarizer (V.2 integration)", () => {
	it("produces a summary via Memory.summarizeThread and writes it to metadata", async () => {
		await seedThread(8);
		// Bullet-formatted output — the Observer extracts list items as the
		// summary when <observations> tags are absent.
		mockControl.script = [
			[
				{ type: "stream-start" },
				{ type: "text-start" },
				{
					type: "text-delta",
					delta: "- The student discussed soil contamination\n- Cell 3 has an unhandled error\n",
				},
				{ type: "text-end" },
				{
					type: "finish",
					finishReason: "stop",
					usage: { inputTokens: 1, outputTokens: 1 },
				},
			],
		];
		mockControl.receivedCalls = [];

		const result = await maybeCompactThread({
			threadId: "t-1",
			resourceId: "sub-1",
			settings: settings(),
			model: mockModel as unknown as SummarizeModel,
			modelId: "mock-model",
		});

		expect(result.compacted).toBe(true);
		const meta = (await readThread())?.metadata as Record<string, unknown>;
		expect(meta.summary).toContain("soil contamination");
		expect(meta.summary).toContain("Cell 3 has an unhandled error");
		expect(meta.summaryCount).toBe(1);
		expect(meta.summarizedUpTo).toBe(8);
		// The summarizer's stream call reached the model (one doStream call).
		expect(mockControl.receivedCalls).toHaveLength(1);
	});
});
