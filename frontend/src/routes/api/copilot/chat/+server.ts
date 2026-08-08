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

import { streamChat, type CopilotStreamEvent } from "$lib/server/copilot/agent";

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
 * validation happy. Entries are retained for the server's lifetime — bounded
 * by usage; a production store would evict on TTL.
 */
export const _knownApprovalRunIds = new Set<string>();

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
	});

	const readable = new ReadableStream<Uint8Array>({
		async start(controller) {
			try {
				for await (const evt of events) {
					if (event.request.signal.aborted) return;
					if (evt.type === "approval-request") {
						_knownApprovalRunIds.add(evt.runId);
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
