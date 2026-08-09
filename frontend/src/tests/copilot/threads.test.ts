// @vitest-environment node
/**
 * @file Unit tests for the thread management module (Task T.1) — the
 * FileMemoryStore exposed as a thread API with derived titles, scope
 * isolation, and wire-message mapping.
 *
 * Every test runs against a fresh temp DATA_DIR. Threads/messages are seeded
 * through the REAL FileMemoryStore with the V2 content shape
 * `{ format: 2, parts: [...] }` — never the loose fixture shapes from
 * file-memory.test.ts (which cast content arrays that Mastra never writes).
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { MastraDBMessage, StorageThreadType } from "@mastra/core/memory";

import { FileMemoryStore } from "$lib/server/copilot/file-memory";
import { deleteThread, getThread, listThreads, renameThread } from "$lib/server/copilot/threads";

let dataDir: string;

beforeEach(async () => {
	dataDir = await mkdtemp(path.join(tmpdir(), "copilot-threads-"));
	process.env.DATA_DIR = dataDir;
});

afterEach(async () => {
	await rm(dataDir, { recursive: true, force: true });
});

function thread(id: string, resourceId: string, updatedAt: Date): StorageThreadType {
	return {
		id,
		resourceId,
		createdAt: new Date("2026-08-01T10:00:00Z"),
		updatedAt,
	};
}

/** A V2 text-only stored message (the shape Mastra actually writes). */
function textMessage(
	id: string,
	threadId: string,
	resourceId: string,
	role: "user" | "assistant" | "system",
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

/** A stored message whose parts are ONLY a tool invocation (V2 shape). */
function toolMessage(
	id: string,
	threadId: string,
	resourceId: string,
	toolName: string,
	opts: { state?: string; errorText?: string; createdAt?: Date } = {},
): MastraDBMessage {
	const { state = "completed", errorText, createdAt = new Date("2026-08-01T11:30:00Z") } = opts;
	return {
		id,
		threadId,
		resourceId,
		role: "assistant",
		content: {
			format: 2,
			parts: [
				{
					type: "tool-invocation",
					toolInvocation: {
						state,
						toolCallId: `call-${id}`,
						toolName,
						args: {},
						...(errorText ? { errorText } : {}),
					},
				},
			],
		},
		createdAt,
	} as unknown as MastraDBMessage;
}

describe("threads.ts", () => {
	it("listThreads returns metas with derived titles, counts, previews, newest-first", async () => {
		const store = new FileMemoryStore();
		// Older thread first (updated 11:00) — must sort AFTER the newer one.
		await store.saveThread({
			thread: thread("t-old", "sub-1", new Date("2026-08-01T11:00:00Z")),
		});
		await store.saveMessages({
			messages: [
				textMessage(
					"m1",
					"t-old",
					"sub-1",
					"user",
					"Compare cell 3 to the key please",
					new Date("2026-08-01T10:30:00Z"),
				),
				toolMessage("m2", "t-old", "sub-1", "read-notebook", {
					createdAt: new Date("2026-08-01T10:32:00Z"),
				}),
				textMessage(
					"m3",
					"t-old",
					"sub-1",
					"assistant",
					"Done.",
					new Date("2026-08-01T11:00:00Z"),
				),
			],
		});
		// Newer thread (updated 12:00) — derived title from its first user message.
		await store.saveThread({
			thread: thread("t-new", "sub-1", new Date("2026-08-01T12:00:00Z")),
		});
		await store.saveMessages({
			messages: [
				textMessage(
					"m4",
					"t-new",
					"sub-1",
					"user",
					"How is the class doing overall?",
					new Date("2026-08-01T11:45:00Z"),
				),
			],
		});
		// Another scope's thread — must never appear in this scope's list.
		await store.saveThread({
			thread: thread("t-other", "assign-9", new Date("2026-08-01T13:00:00Z")),
		});

		const threads = await listThreads({ submissionId: "sub-1" });

		expect(threads.map((t) => t.id)).toEqual(["t-new", "t-old"]);
		expect(threads[0]).toEqual({
			id: "t-new",
			title: "How is the class doing overall?",
			createdAt: "2026-08-01T10:00:00.000Z",
			updatedAt: "2026-08-01T12:00:00.000Z",
			messageCount: 1,
			lastPreview: "How is the class doing overall?",
			// No settings.yaml → model-aware default (16 for the default 32K model).
			recallLimit: 16,
			recallCovered: 1,
			droppedCount: 0,
			// 30 chars / 4 = 7.5 → rounds to 0 (below the 100 granularity).
			estimatedTokens: 0,
			// Never compacted, no stored summary.
			compactionCount: 0,
			hasSummary: false,
		});
		expect(threads[1]).toMatchObject({
			title: "Compare cell 3 to the key please",
			messageCount: 3,
			lastPreview: "Done.",
		});
	});

	it("falls back to a stored title and to 'Untitled conversation'", async () => {
		const store = new FileMemoryStore();
		await store.saveThread({
			thread: {
				...thread("t-titled", "sub-1", new Date("2026-08-01T12:00:00Z")),
				title: "My stored title",
			},
		});
		await store.saveMessages({
			messages: [
				textMessage(
					"m1",
					"t-titled",
					"sub-1",
					"user",
					"hi",
					new Date("2026-08-01T11:00:00Z"),
				),
			],
		});
		await store.saveThread({
			thread: thread("t-empty", "sub-1", new Date("2026-08-01T13:00:00Z")),
		});

		const threads = await listThreads({ submissionId: "sub-1" });
		const titled = threads.find((t) => t.id === "t-titled");
		expect(titled?.title).toBe("My stored title");
		const empty = threads.find((t) => t.id === "t-empty");
		expect(empty?.title).toBe("Untitled conversation");
		expect(empty?.lastPreview).toBeUndefined();
	});

	it("truncates derived titles to one line and TITLE_MAX characters", async () => {
		const store = new FileMemoryStore();
		await store.saveThread({
			thread: thread("t-long", "sub-1", new Date("2026-08-01T12:00:00Z")),
		});
		await store.saveMessages({
			messages: [
				textMessage(
					"m1",
					"t-long",
					"sub-1",
					"user",
					"First line\nSecond line that must never appear in the title",
					new Date("2026-08-01T11:00:00Z"),
				),
			],
		});
		const threads = await listThreads({ submissionId: "sub-1" });
		// Only the FIRST line is used for the title (10 chars — no truncation).
		expect(threads[0].title).toBe("First line");
	});

	it("getThread maps messages to the wire shape (text, tool, system)", async () => {
		const store = new FileMemoryStore();
		await store.saveThread({
			thread: thread("t-1", "sub-1", new Date("2026-08-01T12:00:00Z")),
		});
		await store.saveMessages({
			messages: [
				textMessage(
					"m1",
					"t-1",
					"sub-1",
					"system",
					"System note",
					new Date("2026-08-01T10:00:00Z"),
				),
				textMessage(
					"m2",
					"t-1",
					"sub-1",
					"user",
					"Hello",
					new Date("2026-08-01T10:01:00Z"),
				),
				toolMessage("m3", "t-1", "sub-1", "read-notebook", {
					state: "completed",
					createdAt: new Date("2026-08-01T10:02:00Z"),
				}),
				toolMessage("m4", "t-1", "sub-1", "process-all", {
					state: "error",
					errorText: "Timed out",
					createdAt: new Date("2026-08-01T10:03:00Z"),
				}),
				textMessage(
					"m5",
					"t-1",
					"sub-1",
					"assistant",
					"Done.",
					new Date("2026-08-01T10:04:00Z"),
				),
			],
		});

		const detail = await getThread("t-1", { submissionId: "sub-1" });

		expect(detail).not.toBeNull();
		expect(detail!.messages.map((m) => m.role)).toEqual([
			"system",
			"user",
			"tool",
			"tool",
			"assistant",
		]);
		expect(detail!.messages[1]).toMatchObject({ role: "user", text: "Hello" });
		expect(detail!.messages[2]).toMatchObject({
			role: "tool",
			toolName: "read-notebook",
			ok: true,
		});
		expect(detail!.messages[3]).toMatchObject({
			role: "tool",
			toolName: "process-all",
			ok: false,
		});
		expect(detail!.messages[4]).toMatchObject({ role: "assistant", text: "Done." });
		expect(detail!.messages[0]).toEqual({
			id: "m1",
			role: "system",
			createdAt: "2026-08-01T10:00:00.000Z",
		});
	});

	it("maps a mixed text+tool message as an assistant bubble (text wins)", async () => {
		const store = new FileMemoryStore();
		await store.saveThread({
			thread: thread("t-mixed", "sub-1", new Date("2026-08-01T12:00:00Z")),
		});
		const mixed: MastraDBMessage = {
			id: "m-mixed",
			threadId: "t-mixed",
			resourceId: "sub-1",
			role: "assistant",
			content: {
				format: 2,
				parts: [
					{ type: "text", text: "Let me check." },
					{
						type: "tool-invocation",
						toolInvocation: {
							state: "completed",
							toolCallId: "call-x",
							toolName: "x",
							args: {},
						},
					},
				],
			},
			createdAt: new Date("2026-08-01T10:05:00Z"),
		} as unknown as MastraDBMessage;
		await store.saveMessages({ messages: [mixed] });

		const detail = await getThread("t-mixed", { submissionId: "sub-1" });
		expect(detail!.messages).toEqual([
			{
				id: "m-mixed",
				role: "assistant",
				createdAt: "2026-08-01T10:05:00.000Z",
				text: "Let me check.",
			},
		]);
	});

	it("getThread returns null when the thread belongs to another scope", async () => {
		const store = new FileMemoryStore();
		await store.saveThread({
			thread: thread("t-1", "sub-1", new Date("2026-08-01T12:00:00Z")),
		});
		await store.saveMessages({
			messages: [
				textMessage("m1", "t-1", "sub-1", "user", "hi", new Date("2026-08-01T11:00:00Z")),
			],
		});

		expect(await getThread("t-1", { assignmentId: "assign-1" })).toBeNull();
		expect(await getThread("t-missing", { submissionId: "sub-1" })).toBeNull();
	});

	it("deleteThread removes the thread files and returns false on a second call", async () => {
		const store = new FileMemoryStore();
		await store.saveThread({
			thread: thread("t-1", "sub-1", new Date("2026-08-01T12:00:00Z")),
		});
		await store.saveMessages({
			messages: [
				textMessage("m1", "t-1", "sub-1", "user", "hi", new Date("2026-08-01T11:00:00Z")),
			],
		});

		expect(await deleteThread("t-1", { submissionId: "sub-1" })).toBe(true);
		expect(await store.getThreadById({ threadId: "t-1" })).toBeNull();
		expect((await store.listMessages({ threadId: "t-1" })).messages).toHaveLength(0);
		// Second delete: thread is gone → false.
		expect(await deleteThread("t-1", { submissionId: "sub-1" })).toBe(false);
		// Wrong scope → false, thread untouched.
		await store.saveThread({
			thread: thread("t-2", "sub-2", new Date("2026-08-01T12:00:00Z")),
		});
		expect(await deleteThread("t-2", { submissionId: "sub-1" })).toBe(false);
		expect(await store.getThreadById({ threadId: "t-2" })).not.toBeNull();
	});

	it("renameThread updates the stored title (truncated) and is scope-checked", async () => {
		const store = new FileMemoryStore();
		await store.saveThread({
			thread: thread("t-1", "sub-1", new Date("2026-08-01T12:00:00Z")),
		});

		expect(await renameThread("t-1", "A much better title", { submissionId: "sub-1" })).toBe(
			true,
		);
		expect((await store.getThreadById({ threadId: "t-1" }))?.title).toBe("A much better title");
		// updatedAt bumps on rename → the thread moves to the top of the list.
		const threads = await listThreads({ submissionId: "sub-1" });
		expect(threads[0].title).toBe("A much better title");

		// Wrong scope → false, title unchanged.
		expect(await renameThread("t-1", "Hijacked", { assignmentId: "assign-1" })).toBe(false);
		expect((await store.getThreadById({ threadId: "t-1" }))?.title).toBe("A much better title");
		// Missing thread → false.
		expect(await renameThread("t-missing", "Nope", { submissionId: "sub-1" })).toBe(false);
	});

	it("reports context stats: recallCovered, droppedCount, estimatedTokens (U.3)", async () => {
		// A window of 10 makes 2 of the 12 stored messages invisible to the model.
		await writeFile(path.join(dataDir, "settings.yaml"), "copilot:\n  last_messages: 10\n");
		const store = new FileMemoryStore();
		await store.saveThread({
			thread: thread("t-12", "sub-1", new Date("2026-08-01T12:00:00Z")),
		});
		const messages: MastraDBMessage[] = [];
		for (let i = 1; i <= 12; i++) {
			messages.push(
				textMessage(
					`m${i}`,
					"t-12",
					"sub-1",
					i % 2 === 1 ? "user" : "assistant",
					`Message ${i} about the notebook analysis`,
					new Date(
						`2026-08-01T${String(10 + Math.floor(i / 2)).padStart(2, "0")}:00:00Z`,
					),
				),
			);
		}
		await store.saveMessages({ messages });

		const list = await listThreads({ submissionId: "sub-1" });
		expect(list[0]).toMatchObject({
			id: "t-12",
			messageCount: 12,
			recallLimit: 10,
			recallCovered: 10,
			droppedCount: 2,
		});
		expect(list[0].estimatedTokens).toBeGreaterThan(0);

		// The detail builder carries the same stats.
		const detail = await getThread("t-12", { submissionId: "sub-1" });
		expect(detail).not.toBeNull();
		expect(detail!.recallCovered).toBe(10);
		expect(detail!.droppedCount).toBe(2);

		// A fresh thread (no messages) drops nothing.
		await store.saveThread({
			thread: thread("t-fresh", "sub-1", new Date("2026-08-01T13:00:00Z")),
		});
		const fresh = (await listThreads({ submissionId: "sub-1" })).find(
			(t) => t.id === "t-fresh",
		)!;
		expect(fresh.messageCount).toBe(0);
		expect(fresh.recallCovered).toBe(0);
		expect(fresh.droppedCount).toBe(0);
		expect(fresh.estimatedTokens).toBe(0);
	});
});
