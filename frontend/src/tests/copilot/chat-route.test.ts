// @vitest-environment node
/**
 * @file L5 API-contract tests for POST /api/copilot/chat (SSE chat pipe).
 *
 * Agent module mocked (vi.mock('$lib/server/copilot/agent')); real
 * Request/Response. Covers: 400 validation (missing message, missing scope
 * id, non-JSON), the assignment-scope body (assignmentId only), both-ids
 * forwarding, exact bare-SSE frame bytes for a 2-event conversation,
 * streamChat input forwarding (submissionId/message/threadId/abort signal),
 * and the stream staying OPEN across an approval-request until the run's
 * continuation completes (a deferred the test resolves later — the same
 * shape as the teacher's separate approval POST).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST, _knownApprovalRunIds, _threadSessions } from "../../routes/api/copilot/chat/+server";
import { streamChat } from "$lib/server/copilot/agent";

vi.mock("$lib/server/copilot/agent", () => ({
	streamChat: vi.fn(),
	approveRun: vi.fn(),
}));

const mockedStreamChat = vi.mocked(streamChat);

function chatRequest(body: unknown, signal?: AbortSignal): Request {
	return new Request("http://localhost/api/copilot/chat", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
		signal,
	});
}

async function postChat(body: unknown, signal?: AbortSignal): Promise<Response> {
	return POST({ request: chatRequest(body, signal) } as never);
}

async function readAll(response: Response): Promise<string> {
	const reader = response.body!.getReader();
	const decoder = new TextDecoder();
	let out = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		out += decoder.decode(value, { stream: true });
	}
	return out + decoder.decode();
}

beforeEach(() => {
	vi.clearAllMocks();
	_knownApprovalRunIds.clear();
	_threadSessions.clear();
});

afterEach(() => {
	_knownApprovalRunIds.clear();
	_threadSessions.clear();
});

describe("POST /api/copilot/chat", () => {
	it("rejects a body without a message (400)", async () => {
		await expect(postChat({ submissionId: "sub-1" })).rejects.toMatchObject({ status: 400 });
		expect(mockedStreamChat).not.toHaveBeenCalled();
	});

	it("rejects a body with neither submissionId nor assignmentId (400)", async () => {
		await expect(postChat({ message: "hello" })).rejects.toMatchObject({ status: 400 });
		expect(mockedStreamChat).not.toHaveBeenCalled();
	});

	it("rejects non-JSON bodies (400)", async () => {
		const request = new Request("http://localhost/api/copilot/chat", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "not json",
		});
		await expect(POST({ request } as never)).rejects.toMatchObject({ status: 400 });
		expect(mockedStreamChat).not.toHaveBeenCalled();
	});

	it("streams an assignmentId-only body and forwards the assignment scope", async () => {
		mockedStreamChat.mockResolvedValueOnce(
			(async function* () {
				yield { type: "done" };
			})(),
		);

		const response = await postChat({
			assignmentId: "assign-1",
			message: "How is the class doing?",
		});

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("text/event-stream");
		expect(mockedStreamChat).toHaveBeenCalledTimes(1);
		const input = mockedStreamChat.mock.calls[0][0];
		expect(input.assignmentId).toBe("assign-1");
		expect(input.submissionId).toBeUndefined();
		expect(input.message).toBe("How is the class doing?");
		expect(await readAll(response)).toBe("done\n\n");
	});

	it("forwards both submissionId and assignmentId when both are present", async () => {
		mockedStreamChat.mockResolvedValueOnce(
			(async function* () {
				yield { type: "done" };
			})(),
		);

		const response = await postChat({
			submissionId: "sub-1",
			assignmentId: "assign-1",
			message: "go",
		});

		expect(response.status).toBe(200);
		expect(mockedStreamChat).toHaveBeenCalledTimes(1);
		const input = mockedStreamChat.mock.calls[0][0];
		expect(input.submissionId).toBe("sub-1");
		expect(input.assignmentId).toBe("assign-1");
		expect(await readAll(response)).toBe("done\n\n");
	});

	it("passes a per-thread session object (autoApprovedCount: 0) to streamChat", async () => {
		mockedStreamChat.mockResolvedValueOnce(
			(async function* () {
				yield { type: "done" };
			})(),
		);

		await postChat({ submissionId: "sub-1", message: "go", threadId: "thread-9" });

		expect(mockedStreamChat).toHaveBeenCalledTimes(1);
		expect(mockedStreamChat.mock.calls[0][0].session).toEqual(
			expect.objectContaining({ autoApprovedCount: 0 }),
		);
	});

	it("reuses the SAME session for the same thread and a DIFFERENT one per thread", async () => {
		mockedStreamChat.mockImplementation(async () => {
			return (async function* () {
				yield { type: "done" };
			})();
		});

		await postChat({ submissionId: "sub-1", message: "first", threadId: "thread-9" });
		await postChat({ submissionId: "sub-1", message: "second", threadId: "thread-9" });
		await postChat({ submissionId: "sub-1", message: "other thread", threadId: "thread-10" });

		expect(mockedStreamChat).toHaveBeenCalledTimes(3);
		const sameThreadA = mockedStreamChat.mock.calls[0][0].session;
		const sameThreadB = mockedStreamChat.mock.calls[1][0].session;
		const otherThread = mockedStreamChat.mock.calls[2][0].session;

		// Same submissionId + same threadId → reference-identical session.
		expect(sameThreadA).toBe(sameThreadB);
		// Same submissionId but a different threadId → a distinct session.
		expect(sameThreadA).not.toBe(otherThread);
		expect(otherThread).toEqual(expect.objectContaining({ autoApprovedCount: 0 }));
	});

	it("pipes a 2-event conversation as exact bare SSE frames", async () => {
		mockedStreamChat.mockResolvedValueOnce(
			(async function* () {
				yield { type: "tool-call", tool: "get-submission-context", args: {} };
				yield { type: "done" };
			})(),
		);

		const controller = new AbortController();
		const request = chatRequest(
			{ submissionId: "sub-1", message: "compare cell 3 to the key", threadId: "thread-9" },
			controller.signal,
		);
		const response = await POST({ request } as never);

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("text/event-stream");
		expect(response.headers.get("cache-control")).toBe("no-cache");
		expect(response.headers.get("connection")).toBe("keep-alive");

		// streamChat got the validated input + the request's abort signal
		// (undici wraps the controller signal, so compare to request.signal).
		expect(mockedStreamChat).toHaveBeenCalledTimes(1);
		const input = mockedStreamChat.mock.calls[0][0];
		expect(input.submissionId).toBe("sub-1");
		expect(input.message).toBe("compare cell 3 to the key");
		expect(input.threadId).toBe("thread-9");
		expect(input.signal).toBe(request.signal);
		expect(input.signal).toBeInstanceOf(AbortSignal);

		expect(await readAll(response)).toBe(
			'tool-call\n{"tool":"get-submission-context","args":{}}\n\ndone\n\n',
		);
	});

	it("keeps the stream open across an approval-request until the continuation completes", async () => {
		let resolveContinuation!: () => void;
		const deferred = new Promise<void>((resolve) => {
			resolveContinuation = resolve;
		});

		mockedStreamChat.mockResolvedValueOnce(
			(async function* () {
				yield {
					type: "approval-request",
					runId: "run-1",
					toolCallId: "call-1",
					tool: "process-all",
					argsRedacted: {},
					decision: "ask",
				};
				// Suspended run — the agent waits for the teacher's decision,
				// exactly as it would after approveRun resolves it.
				await deferred;
				yield { type: "tool-result", tool: "process-all", ok: true, summary: "Done" };
				yield { type: "done" };
			})(),
		);

		const response = await postChat({ submissionId: "sub-1", message: "go" });
		expect(response.status).toBe(200);

		const reader = response.body!.getReader();
		const decoder = new TextDecoder();

		const first = await reader.read();
		expect(first.done).toBe(false);
		expect(decoder.decode(first.value)).toBe(
			'approval-request\n{"runId":"run-1","toolCallId":"call-1","tool":"process-all","argsRedacted":{},"decision":"ask"}\n\n',
		);

		// The advertised runId must be visible to the approval route.
		expect(_knownApprovalRunIds.has("run-1")).toBe(true);

		// The stream must NOT close while the approval is pending.
		let pending: ReadableStreamReadResult<Uint8Array> | undefined;
		const pendingRead = reader.read().then((result) => {
			pending = result;
		});
		await new Promise((r) => setTimeout(r, 20));
		expect(pending).toBeUndefined(); // still open — no chunk, no close

		// The teacher's decision arrives (separate request); the generator
		// resumes and the continuation frames flow on THIS stream.
		resolveContinuation();
		await pendingRead;
		expect(pending!.done).toBe(false);
		expect(decoder.decode(pending!.value)).toBe(
			'tool-result\n{"tool":"process-all","ok":true,"summary":"Done"}\n\n',
		);

		const doneFrame = await reader.read();
		expect(doneFrame.done).toBe(false);
		expect(decoder.decode(doneFrame.value)).toBe("done\n\n");

		const closed = await reader.read();
		expect(closed.done).toBe(true);
	});
});
