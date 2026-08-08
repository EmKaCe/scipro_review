// @vitest-environment node
/**
 * @file Unit tests for the file-backed Mastra memory storage domain (4f).
 * Every test runs against a fresh temp DATA_DIR; restart persistence is
 * simulated by re-instantiating the adapter over the same directory.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { MastraDBMessage, StorageThreadType } from "@mastra/core/memory";

import { FileMemoryStore } from "$lib/server/copilot/file-memory";

let dataDir: string;

beforeEach(async () => {
	dataDir = await mkdtemp(path.join(tmpdir(), "copilot-memory-"));
	process.env.DATA_DIR = dataDir;
});

afterEach(async () => {
	await rm(dataDir, { recursive: true, force: true });
});

function thread(id: string, resourceId = "s1"): StorageThreadType {
	return {
		id,
		resourceId,
		createdAt: new Date("2026-08-01T10:00:00Z"),
		updatedAt: new Date("2026-08-01T10:00:00Z"),
	};
}

function msg(
	id: string,
	threadId: string,
	role: string,
	text: string,
	createdAt = new Date("2026-08-01T11:00:00Z"),
): MastraDBMessage {
	return {
		id,
		threadId,
		resourceId: "s1",
		role: role as MastraDBMessage["role"],
		type: "text",
		content: [{ type: "text", text }],
		createdAt,
	} as unknown as MastraDBMessage;
}

describe("FileMemoryStore", () => {
	it("round-trips a thread through saveThread/getThreadById", async () => {
		const store = new FileMemoryStore();
		await store.saveThread({ thread: thread("t1") });
		const got = await store.getThreadById({ threadId: "t1" });
		expect(got?.id).toBe("t1");
		expect(got?.resourceId).toBe("s1");
		expect(got?.createdAt).toBeInstanceOf(Date);
	});

	it("returns null for a missing thread and filters by resourceId", async () => {
		const store = new FileMemoryStore();
		expect(await store.getThreadById({ threadId: "missing" })).toBeNull();
		await store.saveThread({ thread: thread("t1", "s1") });
		expect(await store.getThreadById({ threadId: "t1", resourceId: "s2" })).toBeNull();
		expect(await store.getThreadById({ threadId: "t1", resourceId: "s1" })).not.toBeNull();
	});

	it("updateThread merges title + metadata and bumps updatedAt", async () => {
		const store = new FileMemoryStore();
		await store.saveThread({ thread: thread("t1") });
		const updated = await store.updateThread({
			id: "t1",
			title: "Thread title",
			metadata: { marker: "x" },
		});
		expect(updated.title).toBe("Thread title");
		expect(updated.metadata?.marker).toBe("x");
		const got = await store.getThreadById({ threadId: "t1" });
		expect(got?.title).toBe("Thread title");
		expect(got?.updatedAt.getTime()).toBeGreaterThanOrEqual(
			new Date("2026-08-01T10:00:00Z").getTime(),
		);
	});

	it("deleteThread removes the thread and its messages", async () => {
		const store = new FileMemoryStore();
		await store.saveThread({ thread: thread("t1") });
		await store.saveMessages({ messages: [msg("m1", "t1", "user", "hi")] });
		await store.deleteThread({ threadId: "t1" });
		expect(await store.getThreadById({ threadId: "t1" })).toBeNull();
		const listed = await store.listMessages({ threadId: "t1" });
		expect(listed.messages).toHaveLength(0);
	});

	it("round-trips messages sorted by createdAt", async () => {
		const store = new FileMemoryStore();
		await store.saveMessages({
			messages: [
				msg("m1", "t1", "user", "first", new Date("2026-08-01T12:00:00Z")),
				msg("m2", "t1", "assistant", "second", new Date("2026-08-01T13:00:00Z")),
			],
		});
		const { messages } = await store.listMessages({ threadId: "t1" });
		expect(messages.map((m) => m.id)).toEqual(["m1", "m2"]);
		expect(messages[0].createdAt).toBeInstanceOf(Date);
	});

	it("listMessages paginates with perPage/page/hasMore", async () => {
		const store = new FileMemoryStore();
		const messages = Array.from({ length: 5 }, (_, i) =>
			msg(`m${i}`, "t1", "user", `msg ${i}`, new Date(`2026-08-01T1${i}:00:00Z`)),
		);
		await store.saveMessages({ messages });
		const page1 = await store.listMessages({ threadId: "t1", perPage: 2, page: 0 });
		expect(page1.messages).toHaveLength(2);
		expect(page1.total).toBe(5);
		expect(page1.hasMore).toBe(true);
		const page3 = await store.listMessages({ threadId: "t1", perPage: 2, page: 2 });
		expect(page3.messages).toHaveLength(1);
		expect(page3.hasMore).toBe(false);
		const all = await store.listMessages({ threadId: "t1", perPage: false });
		expect(all.messages).toHaveLength(5);
	});

	it("listMessages merges multiple thread ids", async () => {
		const store = new FileMemoryStore();
		await store.saveMessages({
			messages: [msg("m1", "t1", "user", "a"), msg("m2", "t2", "user", "b")],
		});
		const { messages } = await store.listMessages({ threadId: ["t1", "t2"] });
		expect(messages.map((m) => m.id).sort()).toEqual(["m1", "m2"]);
	});

	it("listMessagesById finds messages across threads", async () => {
		const store = new FileMemoryStore();
		await store.saveMessages({
			messages: [msg("m1", "t1", "user", "a"), msg("m2", "t2", "user", "b")],
		});
		const { messages } = await store.listMessagesById({ messageIds: ["m2", "nope"] });
		expect(messages.map((m) => m.id)).toEqual(["m2"]);
	});

	it("updateMessages merges content by id", async () => {
		const store = new FileMemoryStore();
		await store.saveMessages({ messages: [msg("m1", "t1", "assistant", "old")] });
		const patches = [
			{ id: "m1", content: { content: [{ type: "text", text: "new" }] } },
		] as unknown as Parameters<FileMemoryStore["updateMessages"]>[0]["messages"];
		const updated = await store.updateMessages({ messages: patches });
		expect(updated).toHaveLength(1);
		const { messages } = await store.listMessages({ threadId: "t1" });
		expect(messages[0].content).toEqual([{ type: "text", text: "new" }]);
	});

	it("listThreads filters by resourceId + metadata and orders DESC", async () => {
		const store = new FileMemoryStore();
		await store.saveThread({
			thread: {
				...thread("t1", "s1"),
				metadata: { tag: "a" },
				updatedAt: new Date("2026-08-01T10:00:00Z"),
			},
		});
		await store.saveThread({
			thread: {
				...thread("t2", "s2"),
				metadata: { tag: "b" },
				updatedAt: new Date("2026-08-02T10:00:00Z"),
			},
		});
		const filtered = await store.listThreads({ filter: { resourceId: "s1" } });
		expect(filtered.threads.map((t) => t.id)).toEqual(["t1"]);
		const byMetadata = await store.listThreads({ filter: { metadata: { tag: "b" } } });
		expect(byMetadata.threads.map((t) => t.id)).toEqual(["t2"]);
		const desc = await store.listThreads({
			orderBy: { field: "updatedAt", direction: "DESC" },
		});
		expect(desc.threads.map((t) => t.id)).toEqual(["t2", "t1"]);
	});

	it("persists across process restarts (new adapter instance, same DATA_DIR)", async () => {
		const first = new FileMemoryStore();
		await first.saveThread({ thread: thread("t1") });
		await first.saveMessages({ messages: [msg("m1", "t1", "user", "persisted")] });

		const second = new FileMemoryStore();
		const got = await second.getThreadById({ threadId: "t1" });
		expect(got?.id).toBe("t1");
		const { messages } = await second.listMessages({ threadId: "t1" });
		expect(messages.map((m) => m.id)).toEqual(["m1"]);
		expect(messages[0].content).toEqual([{ type: "text", text: "persisted" }]);
	});

	it("dangerouslyClearAll empties threads and messages", async () => {
		const store = new FileMemoryStore();
		await store.saveThread({ thread: thread("t1") });
		await store.saveMessages({ messages: [msg("m1", "t1", "user", "hi")] });
		await store.dangerouslyClearAll();
		expect(await store.getThreadById({ threadId: "t1" })).toBeNull();
		expect((await store.listMessages({ threadId: "t1" })).messages).toHaveLength(0);
		expect((await store.listThreads({})).threads).toHaveLength(0);
	});
});
