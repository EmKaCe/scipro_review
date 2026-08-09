/**
 * @file /api/copilot/threads/[threadId] — thread detail, delete, rename.
 *
 * All methods require the scope query (?submissionId=X or ?assignmentId=Y;
 * 400 when missing). The thread module enforces scope isolation: a thread
 * whose resourceId does not match the requested scope (or that no longer
 * exists) surfaces as 404 — a submission panel can never read or mutate
 * another scope's thread. The threadId flows through FileMemoryStore's
 * assertSafeSegment guard (traversal-safe).
 *
 *   GET    -> { thread: CopilotThreadDetail }
 *   DELETE -> 204
 *   PATCH  { title: string (1..80) } -> { thread: CopilotThreadMeta }
 */

import { error, json } from "@sveltejs/kit";
import type { RequestEvent } from "@sveltejs/kit";
import { z } from "zod";

import {
	deleteThread,
	getThread,
	renameThread,
	type CopilotThreadMeta,
} from "$lib/server/copilot/threads";

const scopeQuerySchema = z
	.object({
		submissionId: z.string().min(1).optional(),
		assignmentId: z.string().min(1).optional(),
	})
	.refine((scope) => scope.submissionId !== undefined || scope.assignmentId !== undefined, {
		message: "submissionId or assignmentId must be provided (at least one)",
	});

const renameBodySchema = z.object({
	title: z.string().min(1).max(80),
});

/** The meta fields of a detail (PATCH returns the meta, not the messages). */
function metaOf(threadId: string, scope: { submissionId?: string; assignmentId?: string }): Promise<CopilotThreadMeta | null> {
	return getThread(threadId, scope).then((detail) => {
		if (!detail) return null;
		const { messages: _messages, ...meta } = detail;
		return meta;
	});
}

function parseScope(event: RequestEvent): { submissionId?: string; assignmentId?: string } {
	const parsed = scopeQuerySchema.safeParse(Object.fromEntries(event.url.searchParams));
	if (!parsed.success) {
		error(400, "submissionId or assignmentId must be provided (at least one)");
	}
	return parsed.data;
}

/** The [threadId] route param, narrowed (svelte-check types params as optional). */
function threadIdOf(event: RequestEvent): string {
	const threadId = event.params.threadId;
	if (!threadId) error(400, "Missing thread id");
	return threadId;
}

export async function GET(event: RequestEvent): Promise<Response> {
	const scope = parseScope(event);
	const thread = await getThread(threadIdOf(event), scope);
	if (!thread) error(404, "Thread not found");
	return json({ thread });
}

export async function DELETE(event: RequestEvent): Promise<Response> {
	const scope = parseScope(event);
	const deleted = await deleteThread(threadIdOf(event), scope);
	if (!deleted) error(404, "Thread not found");
	return new Response(null, { status: 204 });
}

export async function PATCH(event: RequestEvent): Promise<Response> {
	const scope = parseScope(event);
	let body: unknown;
	try {
		body = await event.request.json();
	} catch {
		error(400, "Expected a JSON body");
	}
	const parsed = renameBodySchema.safeParse(body);
	if (!parsed.success) {
		error(400, "title must be a string of 1-80 characters");
	}
	const threadId = threadIdOf(event);
	const renamed = await renameThread(threadId, parsed.data.title, scope);
	if (!renamed) error(404, "Thread not found");
	const meta = await metaOf(threadId, scope);
	if (!meta) error(404, "Thread not found");
	return json({ thread: meta });
}
