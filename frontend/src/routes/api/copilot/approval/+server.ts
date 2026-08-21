/**
 * @file POST /api/copilot/approval — teacher decision on a suspended tool call.
 *
 * A dumb pipe: validate the body, resolve the agent's pending approval via
 * approveRun, and pipe its events as the same bare SSE frames as the chat
 * route. The continuation of the run is delivered on the ORIGINAL chat
 * stream, not here — approveRun's iterable is empty on success, so a success
 * response is an immediately-closing empty event stream.
 *
 * Error mapping (documented choice):
 * - 404: the runId was never advertised by the chat route — pre-checked
 *   against _knownApprovalRunIds rather than sniffing the first stream frame,
 *   because the agent's error stream is byte-identical for "never seen" and
 *   "already resolved"; only the pre-check can tell them apart.
 * - 409: the runId IS known but the agent reports no pending approval — the
 *   run was already resolved (a second POST for the same approval, or the
 *   approval TTL expired). Surfaced as a conflict via error(), before any
 *   frame is streamed.
 * - Otherwise the events are piped 1:1 as bare SSE frames.
 */

import { error } from "@sveltejs/kit";
import type { RequestEvent } from "@sveltejs/kit";
import { z } from "zod";

import { approveRun, type CopilotStreamEvent } from "$lib/server/copilot/agent";
import { _knownApprovalRunIds } from "../chat/+server";

const approvalBodySchema = z.object({
	runId: z.string().min(1),
	toolCallId: z.string().min(1),
	decision: z.enum(["approve", "deny"]),
});

/** One bare SSE frame from one event (same wire format as the chat route). */
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
	const parsed = approvalBodySchema.safeParse(body);
	if (!parsed.success) {
		error(
			400,
			"runId and toolCallId must be non-empty strings and decision must be 'approve' or 'deny'",
		);
	}
	const { runId, toolCallId, decision } = parsed.data;

	if (!_knownApprovalRunIds.has(runId)) {
		error(404, `Unknown copilot run "${runId}"`);
	}

	const events = await approveRun({ runId, toolCallId, decision });
	// Peek the first frame so the 409 decision happens before the Response is
	// returned (error() cannot be thrown from inside the stream's start()).
	const iterator = events[Symbol.asyncIterator]();
	const first = await iterator.next();
	if (!first.done && first.value.type === "error") {
		error(409, `Approval for run "${runId}" is already resolved`);
	}

	const readable = new ReadableStream<Uint8Array>({
		async start(controller) {
			try {
				if (!first.done) controller.enqueue(encodeFrame(first.value));
				for (;;) {
					const { done, value } = await iterator.next();
					if (done) break;
					controller.enqueue(encodeFrame(value));
				}
			} catch {
				// Client disconnected mid-stream.
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
