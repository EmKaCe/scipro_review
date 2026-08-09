/**
 * @file POST /api/copilot/chat — teacher → copilot chat turn, streamed as SSE.
 *
 * A dumb pipe: validate the body, hand (submissionId?, assignmentId?, message,
 * threadId, the request's abort signal) to the agent module's streamChat, and
 * map every CopilotStreamEvent 1:1 to a bare SSE frame (`<event>\n<json>\n\n`,
 * or `<event>\n\n` for payload-less events like thinking/done).
 *
 * Scope: at least one of submissionId (per-submission chat) or assignmentId
 * (assignment-scoped chat from the dashboard) must be present; both may be
 * provided together. The agent's tools fall back to the assignment scope when
 * submissionId is absent.
 *
 * The stream does NOT close on an approval-request: the agent's generator
 * suspends on the human decision and this connection stays open until the
 * run's continuation completes. The teacher's decision arrives on a SEPARATE
 * POST /api/copilot/approval request; the continuation frames are delivered
 * on THIS stream (the generator stays alive across approveRun).
 */

import { error } from "@sveltejs/kit";
import type { RequestEvent } from "@sveltejs/kit";
import { z } from "zod";

import {
	streamChat,
	type CopilotSession,
	type CopilotStreamEvent,
} from "$lib/server/copilot/agent";

const chatBodySchema = z.object({
	submissionId: z.string().min(1).optional(),
	assignmentId: z.string().min(1).optional(),
	message: z.string().min(1),
	threadId: z.string().optional(),
});

/**
 * @internal Run ids this route has advertised via approval-request frames, so
 * the approval route can tell an unknown run (404) from an already-resolved
 * one (409). The underscore prefix keeps SvelteKit's +server.ts export
 * validation happy. Bounded: each entry carries the expiry timestamp at which
 * it is pruned (APPROVAL_RUN_GRACE_MS after advertisement), so the map never
 * grows without bound over the server's lifetime.
 */
export const _knownApprovalRunIds = new Map<string, number>();

/** How long an advertised approval run stays resolvable (5 minutes). */
const APPROVAL_RUN_GRACE_MS = 5 * 60 * 1000;

/** Drop entries whose grace period has elapsed (safe to call on every insert). */
function pruneKnownApprovalRunIds(now = Date.now()): void {
	for (const [runId, expiry] of _knownApprovalRunIds) {
		if (expiry <= now) _knownApprovalRunIds.delete(runId);
	}
}

/**
 * @internal Per-thread session counter (design decision 5: ONE session per
 * THREAD — keying by scope alone would share the sessionCap budget across all
 * threads of that scope). Keyed by `${scope}:${threadId}`, so each thread
 * carries its own autoApprovedCount into streamChat. The underscore prefix
 * keeps SvelteKit's +server.ts export validation happy; tests clear it
 * between cases.
 */
export const _threadSessions = new Map<string, CopilotSession>();

/** Get (or create) the session for a scope/thread pair. */
function sessionFor(scopeKey: string, threadId: string | undefined): CopilotSession {
	const sessionKey = `${scopeKey}:${threadId ?? "new"}`;
	let session = _threadSessions.get(sessionKey);
	if (!session) {
		session = { autoApprovedCount: 0 };
		_threadSessions.set(sessionKey, session);
	}
	return session;
}

/** One bare SSE frame from one event (see file header for the format). */
function encodeFrame(event: CopilotStreamEvent): Uint8Array {
	if (event.type === "thinking" || event.type === "done") {
		return new TextEncoder().encode(`${event.type}\n\n`);
	}
	const { type: _type, ...payload } = event;
	return new TextEncoder().encode(`${event.type}\n${JSON.stringify(payload)}\n\n`);
}

export async function POST(event: RequestEvent): Promise<Response> {
	let body: unknown;
	try {
		body = await event.request.json();
	} catch {
		error(400, "Expected a JSON body");
	}
	const parsed = chatBodySchema.safeParse(body);
	if (!parsed.success) {
		error(
			400,
			"message must be a non-empty string; submissionId or assignmentId must be a non-empty string (threadId optional)",
		);
	}
	const { submissionId, assignmentId, message, threadId } = parsed.data;
	// At least one scope id is required: a chat turn is either about a
	// submission or about the whole assignment — never about nothing.
	if (!submissionId && !assignmentId) {
		error(400, "submissionId or assignmentId must be provided (at least one)");
	}

	const events = await streamChat({
		submissionId,
		assignmentId,
		message,
		threadId,
		signal: event.request.signal,
		session: sessionFor(submissionId ?? assignmentId ?? "copilot", threadId),
	});

	const readable = new ReadableStream<Uint8Array>({
		async start(controller) {
			try {
				for await (const evt of events) {
					if (event.request.signal.aborted) return;
					if (evt.type === "approval-request") {
						_knownApprovalRunIds.set(evt.runId, Date.now() + APPROVAL_RUN_GRACE_MS);
						pruneKnownApprovalRunIds();
					}
					controller.enqueue(encodeFrame(evt));
				}
			} catch {
				// Client disconnected or the generator failed mid-stream — the
				// response ends without a terminal frame either way.
			} finally {
				try {
					controller.close();
				} catch {
					// Stream already canceled by the client.
				}
			}
		},
	});

	return new Response(readable, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		},
	});
}
