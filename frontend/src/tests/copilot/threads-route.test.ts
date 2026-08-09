// @vitest-environment node
/**
 * @file L5 API-contract tests for the thread management routes (Task T.2):
 *
 *   GET    /api/copilot/threads            — list threads of one scope
 *   GET    /api/copilot/threads/[threadId] — thread detail (scoped)
 *   DELETE /api/copilot/threads/[threadId] — delete (scoped, 204)
 *   PATCH  /api/copilot/threads/[threadId] — rename (scoped, 1..80 chars)
 *
 * Real temp DATA_DIR (seeded through the REAL FileMemoryStore with V2
 * message shapes) + real Request/Response. Covers: 400 missing scope, list
 * shape, detail mapping, scope isolation (a thread from another scope is
 * 404 for GET/DELETE/PATCH), delete 204 → 404, and rename round-trip.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { MastraDBMessage, StorageThreadType } from "@mastra/core/memory";

import { FileMemoryStore } from "$lib/server/copilot/file-memory";
import { DELETE, GET as GET_THREAD, PATCH } from "../../routes/api/copilot/threads/[threadId]/+server";
import { GET as GET_LIST } from "../../routes/api/copilot/threads/+server";

let dataDir: string;

beforeEach(async () => {
	dataDir = await mkdtemp(path.join(tmpdir(), "copilot-threads-route-"));
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

/** Seed one thread with a user + assistant turn (V2 content shapes). */
async function seedThread(
	store: FileMemoryStore,
	opts: {
		id: string;
		resourceId: string;
		userText: string;
		updatedAt?: Date;
	},
): Promise<void> {
	await store.saveThread({
		thread: thread(opts.id, opts.resourceId, opts.updatedAt ?? new Date("2026-08-01T12:00:00Z")),
	});
	await store.saveMessages({
		messages: [
			textMessage(
				`${opts.id}-m1`,
				opts.id,
				opts.resourceId,
				"user",
				opts.userText,
				new Date("2026-08-01T11:00:00Z"),
			),
			textMessage(
				`${opts.id}-m2`,
				opts.id,
				opts.resourceId,
				"assistant",
				"Here is the analysis.",
				new Date("2026-08-01T11:05:00Z"),
			),
		],
	});
}

function listUrl(query: string): string {
	return `http://localhost/api/copilot/threads${query}`;
}

function threadUrl(threadId: string, query: string): string {
	return `http://localhost/api/copilot/threads/${threadId}${query}`;
}

async function listThreads(query: string): Promise<Response> {
	return GET_LIST({ url: new URL(listUrl(query)) } as never);
}

async function getThread(threadId: string, query: string): Promise<Response> {
	return GET_THREAD({
		url: new URL(threadUrl(threadId, query)),
		params: { threadId },
	} as never);
}

async function deleteThread(threadId: string, query: string): Promise<Response> {
	return DELETE({
		url: new URL(threadUrl(threadId, query)),
		params: { threadId },
	} as never);
}

async function patchThread(threadId: string, query: string, body: unknown): Promise<Response> {
	const request = new Request(threadUrl(threadId, query), {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	return PATCH({ request, url: new URL(threadUrl(threadId, query)), params: { threadId } } as never);
}

describe("GET /api/copilot/threads", () => {
	it("rejects a request with no scope query (400)", async () => {
		await expect(listThreads("")).rejects.toMatchObject({ status: 400 });
		await expect(listThreads("?submissionId=")).rejects.toMatchObject({ status: 400 });
	});

	it("lists only the requested scope's threads with derived titles", async () => {
		const store = new FileMemoryStore();
		await seedThread(store, {
			id: "t-1",
			resourceId: "sub-1",
			userText: "Review submission 1",
			updatedAt: new Date("2026-08-01T12:00:00Z"),
		});
		await seedThread(store, {
			id: "t-2",
			resourceId: "sub-1",
			userText: "Second thread",
			updatedAt: new Date("2026-08-01T13:00:00Z"),
		});
		// Another scope's thread — invisible from this scope.
		await seedThread(store, { id: "t-other", resourceId: "assign-9", userText: "Dashboard chat" });

		const response = await listThreads("?submissionId=sub-1");
		expect(response.status).toBe(200);
		const body = (await response.json()) as { threads: Array<{ id: string; title: string; messageCount: number }> };
		expect(body.threads.map((t) => t.id)).toEqual(["t-2", "t-1"]);
		expect(body.threads[0]).toMatchObject({
			title: "Second thread",
			messageCount: 2,
			lastPreview: "Here is the analysis.",
		});
	});

	it("returns an empty list for a scope with no threads (200)", async () => {
		const response = await listThreads("?submissionId=sub-empty");
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ threads: [] });
	});
});

describe("/api/copilot/threads/[threadId]", () => {
	it("rejects all methods without a scope query (400)", async () => {
		const store = new FileMemoryStore();
		await seedThread(store, { id: "t-1", resourceId: "sub-1", userText: "hi" });
		await expect(getThread("t-1", "")).rejects.toMatchObject({ status: 400 });
		await expect(deleteThread("t-1", "")).rejects.toMatchObject({ status: 400 });
		await expect(patchThread("t-1", "", { title: "X" })).rejects.toMatchObject({ status: 400 });
	});

	it("GET maps the stored messages to the wire shape", async () => {
		const store = new FileMemoryStore();
		await seedThread(store, { id: "t-1", resourceId: "sub-1", userText: "Compare cell 3" });

		const response = await getThread("t-1", "?submissionId=sub-1");
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			thread: {
				id: string;
				title: string;
				messageCount: number;
				messages: Array<{ role: string; text?: string }>;
			};
		};
		expect(body.thread.id).toBe("t-1");
		expect(body.thread.title).toBe("Compare cell 3");
		expect(body.thread.messageCount).toBe(2);
		expect(body.thread.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
		expect(body.thread.messages[1]).toMatchObject({ role: "assistant", text: "Here is the analysis." });
	});

	it("404s on a missing thread and on a thread owned by another scope (GET/DELETE/PATCH)", async () => {
		const store = new FileMemoryStore();
		await seedThread(store, { id: "t-1", resourceId: "sub-1", userText: "hi" });

		await expect(getThread("t-missing", "?submissionId=sub-1")).rejects.toMatchObject({ status: 404 });
		await expect(getThread("t-1", "?assignmentId=assign-1")).rejects.toMatchObject({ status: 404 });
		await expect(deleteThread("t-1", "?assignmentId=assign-1")).rejects.toMatchObject({ status: 404 });
		await expect(
			patchThread("t-1", "?assignmentId=assign-1", { title: "Hijack" }),
		).rejects.toMatchObject({ status: 404 });
		// The other scope's attempt must not have mutated anything.
		expect((await store.getThreadById({ threadId: "t-1" }))?.title).toBeUndefined();
	});

	it("DELETE removes the thread (204) and the next request 404s", async () => {
		const store = new FileMemoryStore();
		await seedThread(store, { id: "t-1", resourceId: "sub-1", userText: "hi" });

		const response = await deleteThread("t-1", "?submissionId=sub-1");
		expect(response.status).toBe(204);
		expect(await store.getThreadById({ threadId: "t-1" })).toBeNull();
		await expect(getThread("t-1", "?submissionId=sub-1")).rejects.toMatchObject({ status: 404 });
		await expect(deleteThread("t-1", "?submissionId=sub-1")).rejects.toMatchObject({ status: 404 });
	});

	it("PATCH renames the thread and returns its meta", async () => {
		const store = new FileMemoryStore();
		await seedThread(store, { id: "t-1", resourceId: "sub-1", userText: "hi" });

		const response = await patchThread("t-1", "?submissionId=sub-1", { title: "Renamed thread" });
		expect(response.status).toBe(200);
		const body = (await response.json()) as { thread: { id: string; title: string; messageCount: number } };
		expect(body.thread).toMatchObject({ id: "t-1", title: "Renamed thread", messageCount: 2 });
		expect((await store.getThreadById({ threadId: "t-1" }))?.title).toBe("Renamed thread");
	});

	it("PATCH rejects an empty or over-long title (400)", async () => {
		const store = new FileMemoryStore();
		await seedThread(store, { id: "t-1", resourceId: "sub-1", userText: "hi" });

		await expect(patchThread("t-1", "?submissionId=sub-1", { title: "" })).rejects.toMatchObject({
			status: 400,
		});
		await expect(
			patchThread("t-1", "?submissionId=sub-1", { title: "x".repeat(81) }),
		).rejects.toMatchObject({ status: 400 });
		await expect(patchThread("t-1", "?submissionId=sub-1", {})).rejects.toMatchObject({
			status: 400,
		});
	});
});
