/**
 * @file Unit tests for copilot-store.svelte.ts — the SSE copilot client.
 *
 * Mocks fetch with controllable ReadableStream responses and exercises the
 * store: streaming event parsing, the suspended-approval flow (approve()
 * POSTs the decision and the continuation arrives on the ORIGINAL chat
 * stream), per-send abort timeouts, error surfacing, static-build
 * degradation (apiMode holder), and clearMessages reset.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as copilot from "$lib/components/submissions/copilot-store.svelte.js";
import type { CopilotMessage } from "$lib/components/submissions/copilot-store.svelte.js";

// ---------------------------------------------------------------------------
// SSE helpers
// ---------------------------------------------------------------------------

/** One standard-format SSE frame: `event:` + `data:` + blank line. */
function sseFrame(event: string, data: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * A Response whose stream is written out fully at construction and closed.
 * The reader picks the buffered chunks up as soon as it starts reading.
 */
function sseResponse(...frames: string[]): Response {
	const encoder = new TextEncoder();
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				for (const frame of frames) controller.enqueue(encoder.encode(frame));
				controller.close();
			},
		}),
		{ status: 200, headers: { "Content-Type": "text/event-stream" } },
	);
}

/**
 * A Response whose stream stays OPEN after the initial frames — used for the
 * approval flow, where the server keeps the connection alive until the
 * teacher decides. `push`/`close` let the test control it.
 */
function openSseResponse(...frames: string[]) {
	const encoder = new TextEncoder();
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const stream = new ReadableStream<Uint8Array>({
		start(c) {
			controller = c;
			for (const frame of frames) controller.enqueue(encoder.encode(frame));
		},
	});
	return {
		response: new Response(stream, {
			status: 200,
			headers: { "Content-Type": "text/event-stream" },
		}),
		push: (frame: string) => controller.enqueue(encoder.encode(frame)),
		close: () => controller.close(),
		/** Error the stream (rejects any pending read) — mirrors fetch abort. */
		fail: (error: unknown) => controller.error(error),
	};
}

function bodyOf(call: [RequestInfo | URL, RequestInit?]): Record<string, unknown> {
	return JSON.parse((call[1]?.body as string) ?? "{}") as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Fetch mock
// ---------------------------------------------------------------------------

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
	fetchMock = vi.fn();
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	// apiMode is a mutable holder (criteria-loader pattern) — always restore
	// the static default so tests never leak teacher mode into each other.
	copilot.apiMode.value = false;
	// Thread continuity state is scope-keyed in localStorage (A.2) — clear it
	// so stores in later tests start with no stored thread.
	localStorage.clear();
});

// ---------------------------------------------------------------------------
// sendMessage streaming
// ---------------------------------------------------------------------------

describe("sendMessage streaming", () => {
	it("streams tool-call -> tool-result -> message -> done into messages", async () => {
		copilot.apiMode.value = true;
		const chat = openSseResponse(
			sseFrame("thinking", {}),
			sseFrame("tool-call", { tool: "read-notebook", args: { path: "2026SS_01.ipynb" } }),
			sseFrame("tool-result", {
				tool: "read-notebook",
				ok: true,
				summary: "Loaded 12 cells",
			}),
			sseFrame("message-delta", { text: "The code " }),
			sseFrame("message-delta", { text: "is clean." }),
			sseFrame("message", {
				role: "assistant",
				content: "The code is clean and well documented.",
			}),
			sseFrame("done", {}),
		);
		fetchMock.mockResolvedValue(chat.response);

		const store = copilot.createCopilotStore({ submissionId: "sub-42" });
		expect(store.isStreaming).toBe(false);
		await store.sendMessage("Review the code");
		expect(store.isStreaming).toBe(false);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const call = fetchMock.mock.calls[0] as [RequestInfo | URL, RequestInit?];
		expect(String(call[0])).toContain("/api/copilot/chat");
		expect(call[1]?.method).toBe("POST");
		const body = bodyOf(call);
		expect(body).toMatchObject({ submissionId: "sub-42", message: "Review the code" });
		// A.2: the store generates and sends a threadId on the first turn.
		expect(body.threadId).toBeTypeOf("string");
		expect((body.threadId as string).length).toBeGreaterThan(0);

		// thinking is a no-op; deltas accumulate into ONE final message that
		// the `message` event replaces with its full content.
		const kinds = store.messages.map((m) => m.kind);
		expect(kinds).toEqual(["text", "tool-call", "tool-result", "text"]);
		expect(store.messages[0]).toMatchObject({
			role: "teacher",
			content: "Review the code",
			type: "text",
		});
		expect(store.messages[1]).toMatchObject({ kind: "tool-call", tool: "read-notebook" });
		expect(store.messages[1].args).toContain("2026SS_01.ipynb");
		expect(store.messages[2]).toMatchObject({
			kind: "tool-result",
			tool: "read-notebook",
			ok: true,
			summary: "Loaded 12 cells",
		});
		const finalMessage = store.messages[3] as CopilotMessage;
		expect(finalMessage).toMatchObject({
			kind: "text",
			role: "assistant",
			content: "The code is clean and well documented.",
		});
		const assistantTexts = store.messages.filter(
			(m) => m.role === "assistant" && m.kind === "text",
		);
		expect(assistantTexts).toHaveLength(1);
	});

	it("keeps command typing for slash-prefixed teacher messages", async () => {
		copilot.apiMode.value = true;
		fetchMock.mockResolvedValue(sseResponse(sseFrame("done", {})));
		const store = copilot.createCopilotStore();
		await store.sendMessage("/draft");
		expect(store.messages[0]).toMatchObject({ role: "teacher", type: "command", kind: "text" });
	});

	it("sends assignmentId (and no submissionId) for an assignment-scoped store", async () => {
		copilot.apiMode.value = true;
		fetchMock.mockResolvedValue(sseResponse(sseFrame("done", {})));
		const store = copilot.createCopilotStore({ assignmentId: "assign-1" });
		await store.sendMessage("Summarize the pipeline status");

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const call = fetchMock.mock.calls[0] as [RequestInfo | URL, RequestInit?];
		expect(String(call[0])).toContain("/api/copilot/chat");
		expect(bodyOf(call)).toMatchObject({
			assignmentId: "assign-1",
			message: "Summarize the pipeline status",
		});
	});

	it("sends both scope ids when the store is created with submission and assignment", async () => {
		copilot.apiMode.value = true;
		fetchMock.mockResolvedValue(sseResponse(sseFrame("done", {})));
		const store = copilot.createCopilotStore({
			submissionId: "sub-42",
			assignmentId: "assign-1",
		});
		await store.sendMessage("hello");

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const call = fetchMock.mock.calls[0] as [RequestInfo | URL, RequestInit?];
		expect(bodyOf(call)).toMatchObject({
			submissionId: "sub-42",
			assignmentId: "assign-1",
			message: "hello",
		});
	});
});

// ---------------------------------------------------------------------------
// Thread continuity (A.2)
// ---------------------------------------------------------------------------

describe("thread continuity (A.2)", () => {
	it("sends a generated threadId + title on the first turn and reuses the threadId on the second", async () => {
		copilot.apiMode.value = true;
		// One fresh response per send (a consumed SSE body cannot be re-read).
		fetchMock
			.mockResolvedValueOnce(sseResponse(sseFrame("done", {})))
			.mockResolvedValueOnce(sseResponse(sseFrame("done", {})));
		const store = copilot.createCopilotStore({ submissionId: "sub-42" });

		await store.sendMessage("Review the code");
		await store.sendMessage("And the tests");

		expect(fetchMock).toHaveBeenCalledTimes(2);
		const first = bodyOf(fetchMock.mock.calls[0] as [RequestInfo | URL, RequestInit?]);
		const second = bodyOf(fetchMock.mock.calls[1] as [RequestInfo | URL, RequestInit?]);
		expect(first.threadId).toBeTypeOf("string");
		expect((first.threadId as string).length).toBeGreaterThan(0);
		expect(first.title).toBe("Review the code");
		expect(second.threadId).toBe(first.threadId);
		expect(second.title).toBeUndefined();
	});

	it("restores the threadId from localStorage for the same scope", async () => {
		copilot.apiMode.value = true;
		localStorage.setItem("copilot:activeThread:sub-42", "t-restored");
		fetchMock.mockResolvedValue(sseResponse(sseFrame("done", {})));
		const store = copilot.createCopilotStore({ submissionId: "sub-42" });

		await store.sendMessage("hello");

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const body = bodyOf(fetchMock.mock.calls[0] as [RequestInfo | URL, RequestInit?]);
		expect(body.threadId).toBe("t-restored");
		// A restored thread is not new — no title is sent on its next turn.
		expect(body.title).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Approval flow
// ---------------------------------------------------------------------------

describe("approval flow", () => {
	it("keeps reading the chat stream across an approval and parses the continuation after approve()", async () => {
		copilot.apiMode.value = true;
		const chat = openSseResponse(
			sseFrame("approval-request", {
				runId: "run-1",
				toolCallId: "call-1",
				tool: "archive-submission",
				argsRedacted: '{ "studentId": "2026SS_01" }',
				decision: "ask",
			}),
		);
		// The approval POST returns an EMPTY stream — the continuation arrives
		// on the ORIGINAL chat stream (verified server contract).
		fetchMock.mockResolvedValueOnce(chat.response).mockResolvedValueOnce(sseResponse());

		const store = copilot.createCopilotStore({ submissionId: "sub-42" });
		// sendMessage only settles when the chat stream ends — the approval
		// suspends it, so hold the promise and await it after the continuation.
		const sendPromise = store.sendMessage("Archive it");
		await vi.waitFor(() => expect(store.pendingApproval).not.toBeNull());

		expect(store.pendingApproval).toEqual({
			runId: "run-1",
			toolCallId: "call-1",
			tool: "archive-submission",
			argsRedacted: '{ "studentId": "2026SS_01" }',
			decision: "ask",
		});
		// The run is suspended, not finished — the reader stays open and the
		// store keeps streaming state.
		expect(store.isStreaming).toBe(true);
		expect(store.messages[store.messages.length - 1]).toMatchObject({
			kind: "approval",
			runId: "run-1",
			toolCallId: "call-1",
			approvalDecision: "ask",
		});

		await store.approve("approve");

		expect(fetchMock).toHaveBeenCalledTimes(2);
		const call = fetchMock.mock.calls[1] as [RequestInfo | URL, RequestInit?];
		expect(String(call[0])).toContain("/api/copilot/approval");
		expect(call[1]?.method).toBe("POST");
		expect(bodyOf(call)).toEqual({
			runId: "run-1",
			toolCallId: "call-1",
			decision: "approve",
		});

		// The continuation arrives on the SAME chat response sendMessage is
		// still reading.
		chat.push(
			sseFrame("tool-result", {
				tool: "archive-submission",
				ok: true,
				summary: "Archived",
			}),
		);
		chat.push(sseFrame("message", { role: "assistant", content: "Done." }));
		chat.push(sseFrame("done", {}));
		await sendPromise;

		expect(store.pendingApproval).toBeNull();
		expect(store.isStreaming).toBe(false);
		expect(store.messages.map((m) => m.kind)).toEqual([
			"text",
			"approval",
			"tool-result",
			"text",
		]);
	});

	it("POSTs a deny decision and clears pendingApproval when the continuation arrives", async () => {
		copilot.apiMode.value = true;
		const chat = openSseResponse(
			sseFrame("approval-request", {
				runId: "run-2",
				toolCallId: "call-2",
				tool: "delete-assignment",
				argsRedacted: "{}",
				decision: "blocked",
			}),
		);
		fetchMock.mockResolvedValueOnce(chat.response).mockResolvedValueOnce(sseResponse());

		const store = copilot.createCopilotStore();
		const sendPromise = store.sendMessage("Delete it");
		await vi.waitFor(() => expect(store.pendingApproval?.decision).toBe("blocked"));
		expect(store.pendingApproval?.argsRedacted).toBe("{}");

		await store.approve("deny");

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(bodyOf(fetchMock.mock.calls[1] as [RequestInfo | URL, RequestInit?])).toEqual({
			runId: "run-2",
			toolCallId: "call-2",
			decision: "deny",
		});

		// The deny continuation (done) arrives on the SAME chat stream.
		chat.push(sseFrame("done", {}));
		await sendPromise;

		expect(store.pendingApproval).toBeNull();
		expect(store.isStreaming).toBe(false);
	});

	it("is a no-op without a pending approval", async () => {
		copilot.apiMode.value = true;
		fetchMock.mockResolvedValue(sseResponse(sseFrame("done", {})));
		const store = copilot.createCopilotStore();
		await store.sendMessage("hi");
		await store.approve("approve");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("TTL auto-deny unblocks the stream without any client action", async () => {
		copilot.apiMode.value = true;
		const chat = openSseResponse(
			sseFrame("approval-request", {
				runId: "run-3",
				toolCallId: "call-3",
				tool: "archive-submission",
				argsRedacted: "{}",
				decision: "ask",
			}),
		);
		fetchMock.mockResolvedValue(chat.response);

		const store = copilot.createCopilotStore();
		const sendPromise = store.sendMessage("Do it");
		await vi.waitFor(() => expect(store.pendingApproval).not.toBeNull());

		// The teacher never clicks — the server TTL denies and the
		// continuation (tool-result ok:false + done) arrives on the chat
		// stream that sendMessage is still reading.
		chat.push(
			sseFrame("tool-result", {
				tool: "archive-submission",
				ok: false,
				summary: "Denied by timeout",
			}) + sseFrame("done", {}),
		);
		await sendPromise;

		expect(store.isStreaming).toBe(false);
		expect(store.pendingApproval).toBeNull();
		expect(store.messages.map((m) => m.kind)).toEqual(["text", "approval", "tool-result"]);
		expect(store.messages[store.messages.length - 1]).toMatchObject({
			kind: "tool-result",
			ok: false,
			summary: "Denied by timeout",
		});
	});
});

// ---------------------------------------------------------------------------
// Stream timeouts (abort on idle / hard cap)
// ---------------------------------------------------------------------------

describe("stream timeouts", () => {
	it("aborts and surfaces an error when the stream hangs", async () => {
		vi.useFakeTimers();
		copilot.apiMode.value = true;
		// An open stream that never sends a byte.
		let chat!: ReturnType<typeof openSseResponse>;
		fetchMock.mockImplementation((_url, init) => {
			chat = openSseResponse();
			// Mirror real fetch: aborting the request rejects pending reads.
			init?.signal?.addEventListener("abort", () => {
				chat.fail(new DOMException("Aborted", "AbortError"));
			});
			return Promise.resolve(chat.response);
		});

		const store = copilot.createCopilotStore();
		// Don't await — sendMessage only settles once the abort lands.
		const sendPromise = store.sendMessage("hi");

		await vi.advanceTimersByTimeAsync(copilot.STREAM_IDLE_TIMEOUT_MS + 1);

		expect(store.isStreaming).toBe(false);
		const last = store.messages[store.messages.length - 1];
		expect(last.kind).toBe("error");
		expect(last.content).toContain("timed out");
		await sendPromise;
	});

	it("does not abort while an approval is pending", async () => {
		vi.useFakeTimers();
		copilot.apiMode.value = true;
		const chat = openSseResponse(
			sseFrame("approval-request", {
				runId: "run-4",
				toolCallId: "call-4",
				tool: "archive-submission",
				argsRedacted: "{}",
				decision: "ask",
			}),
		);
		fetchMock.mockResolvedValue(chat.response);

		const store = copilot.createCopilotStore();
		const sendPromise = store.sendMessage("Do it");
		// Flush the microtasks that deliver the buffered approval-request frame.
		await vi.advanceTimersByTimeAsync(0);
		expect(store.pendingApproval).not.toBeNull();

		// Well past the idle timeout with no stream activity — the paused
		// hook held the timer, so no abort and no error message.
		await vi.advanceTimersByTimeAsync(copilot.STREAM_IDLE_TIMEOUT_MS + 1);

		expect(store.pendingApproval).not.toBeNull();
		expect(store.isStreaming).toBe(true);
		expect(store.messages.some((m) => m.kind === "error")).toBe(false);

		// End the stream so the pending sendMessage settles.
		chat.push(sseFrame("done", {}));
		await sendPromise;
		expect(store.isStreaming).toBe(false);
		expect(store.pendingApproval).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

describe("error surfacing", () => {
	it("surfaces an error event as an error message and stops streaming", async () => {
		copilot.apiMode.value = true;
		fetchMock.mockResolvedValue(
			sseResponse(
				sseFrame("message-delta", { text: "Almost..." }),
				sseFrame("error", { message: "The agent hit an unexpected error" }),
			),
		);
		const store = copilot.createCopilotStore();
		await store.sendMessage("hi");
		expect(store.isStreaming).toBe(false);
		expect(store.messages[store.messages.length - 1]).toMatchObject({
			kind: "error",
			role: "assistant",
			content: "The agent hit an unexpected error",
		});
		expect(store.messages.filter((m) => m.kind === "error")).toHaveLength(1);
	});

	it("surfaces a chat POST network failure as an error message", async () => {
		copilot.apiMode.value = true;
		fetchMock.mockRejectedValue(new Error("network down"));
		const store = copilot.createCopilotStore({ submissionId: "sub-1" });
		await store.sendMessage("hello");
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(store.isStreaming).toBe(false);
		expect(store.messages.map((m) => m.kind)).toEqual(["text", "error"]);
		expect(store.messages[1].content).toBe("network down");
	});

	it("surfaces a non-ok chat response as an error message", async () => {
		copilot.apiMode.value = true;
		fetchMock.mockResolvedValue(new Response("nope", { status: 500 }));
		const store = copilot.createCopilotStore();
		await store.sendMessage("hello");
		expect(store.isStreaming).toBe(false);
		expect(store.messages[store.messages.length - 1].kind).toBe("error");
		expect(store.messages[store.messages.length - 1].content).toContain("500");
	});
});

// ---------------------------------------------------------------------------
// Static build degradation
// ---------------------------------------------------------------------------

describe("static build degradation", () => {
	it("does not fetch and appends an unavailable message when apiMode is false", async () => {
		// apiMode defaults to false under vitest (no __TEACHER_MODE__ define).
		const store = copilot.createCopilotStore();
		await store.sendMessage("hello");
		expect(fetchMock).not.toHaveBeenCalled();
		expect(store.isStreaming).toBe(false);
		expect(store.messages.map((m) => m.kind)).toEqual(["text", "text"]);
		expect(store.messages[0]).toMatchObject({ role: "teacher", content: "hello" });
		expect(store.messages[1]).toMatchObject({
			role: "assistant",
			content: "The AI copilot is not available in this build.",
		});
	});

	it("fetches again once the apiMode holder is flipped on", async () => {
		copilot.apiMode.value = true;
		fetchMock.mockResolvedValue(sseResponse(sseFrame("done", {})));
		const store = copilot.createCopilotStore();
		await store.sendMessage("hello");
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(store.isStreaming).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Suggestions and reset
// ---------------------------------------------------------------------------

describe("suggestions and reset", () => {
	it("appends suggestion messages and pendingSuggestions", async () => {
		copilot.apiMode.value = true;
		fetchMock.mockResolvedValue(
			sseResponse(
				sseFrame("suggestion", {
					suggestionId: "s1",
					kind: "draft",
					title: "Draft feedback",
					body: "Nice work",
					actionLabel: "Insert",
				}),
				sseFrame("done", {}),
			),
		);
		const store = copilot.createCopilotStore();
		await store.sendMessage("Draft feedback");
		expect(store.messages[store.messages.length - 1]).toMatchObject({
			kind: "suggestion",
			type: "draft",
			role: "assistant",
			suggestion: { suggestionId: "s1", kind: "draft", title: "Draft feedback" },
		});
		expect(store.pendingSuggestions).toEqual([
			{ id: "s1", title: "Draft feedback", description: "Nice work", type: "draft" },
		]);
	});

	it("attaches a suggestion embedded in the final message event", async () => {
		copilot.apiMode.value = true;
		fetchMock.mockResolvedValue(
			sseResponse(
				sseFrame("message", {
					role: "assistant",
					content: "Here is a draft.",
					suggestion: {
						suggestionId: "s2",
						kind: "draft",
						title: "Draft",
						body: "Body",
						actionLabel: "Apply",
					},
				}),
				sseFrame("done", {}),
			),
		);
		const store = copilot.createCopilotStore();
		await store.sendMessage("hi");
		const message = store.messages[store.messages.length - 1] as CopilotMessage;
		expect(message).toMatchObject({ kind: "text", type: "draft", content: "Here is a draft." });
		expect(message.suggestion?.suggestionId).toBe("s2");
		expect(store.pendingSuggestions).toHaveLength(1);
	});

	it("clearMessages resets messages, suggestions and approval state", async () => {
		copilot.apiMode.value = true;
		// First run ends with a suggestion.
		fetchMock.mockResolvedValueOnce(
			sseResponse(
				sseFrame("suggestion", {
					suggestionId: "s1",
					kind: "grade",
					title: "Grade proposal",
					body: "Give 8/10",
					actionLabel: "Apply",
				}),
				sseFrame("done", {}),
			),
		);
		const store = copilot.createCopilotStore();
		await store.sendMessage("Suggest a grade");
		expect(store.pendingSuggestions).toHaveLength(1);

		// Second run suspends on an approval request.
		const chat = openSseResponse(
			sseFrame("approval-request", {
				runId: "r",
				toolCallId: "c",
				tool: "t",
				argsRedacted: "{}",
				decision: "ask",
			}),
		);
		fetchMock.mockResolvedValueOnce(chat.response);
		// sendMessage only settles when the stream ends — hold the promise and
		// end the stream after the reset assertions.
		const sendPromise = store.sendMessage("Do it");
		await vi.waitFor(() => expect(store.pendingApproval).not.toBeNull());
		expect(store.messages.length).toBeGreaterThan(0);

		store.clearMessages();

		expect(store.messages).toEqual([]);
		expect(store.pendingSuggestions).toEqual([]);
		expect(store.pendingApproval).toBeNull();

		// Settle the still-reading chat stream.
		chat.push(sseFrame("done", {}));
		await sendPromise;
	});
});

// ---------------------------------------------------------------------------
// Suggestion apply / dismiss (4e)
// ---------------------------------------------------------------------------

describe("suggestion apply/dismiss", () => {
	const GRADE_SUGGESTION = {
		suggestionId: "s1",
		kind: "grade",
		title: "Grade suggestion ready",
		body: "The notebook computes a soil quality index.",
		actionLabel: "Apply suggested scores",
		data: {
			markers: [],
			gradeSuggestion: { dimensions: { code_quality_design: 4 }, justification: "ok" },
			feedbackDraft: "**Nice job**",
			notebookSummary: "summary",
		},
	};

	it("applySuggestion removes the pending suggestion and returns the full payload with data", async () => {
		copilot.apiMode.value = true;
		fetchMock.mockResolvedValue(
			sseResponse(sseFrame("suggestion", GRADE_SUGGESTION), sseFrame("done", {})),
		);
		const store = copilot.createCopilotStore();
		await store.sendMessage("Suggest a grade");

		expect(store.pendingSuggestions).toHaveLength(1);
		expect(store.pendingSuggestions[0]).toMatchObject({ id: "s1", type: "grade" });
		expect(store.pendingSuggestions[0].data).toEqual(GRADE_SUGGESTION.data);

		const applied = store.applySuggestion("s1");

		expect(applied).not.toBeNull();
		expect(applied).toMatchObject({
			suggestionId: "s1",
			kind: "grade",
			title: "Grade suggestion ready",
			actionLabel: "Apply suggested scores",
		});
		expect(applied?.data).toEqual(GRADE_SUGGESTION.data);
		// Removed from pending, but the transcript message is kept.
		expect(store.pendingSuggestions).toHaveLength(0);
		expect(store.messages.some((m) => m.suggestion?.suggestionId === "s1")).toBe(true);
		expect(store.messages[store.messages.length - 1]).toMatchObject({
			kind: "suggestion",
			suggestion: GRADE_SUGGESTION,
		});
	});

	it("applySuggestion returns null for an unknown id and leaves pending untouched", async () => {
		copilot.apiMode.value = true;
		fetchMock.mockResolvedValue(
			sseResponse(sseFrame("suggestion", GRADE_SUGGESTION), sseFrame("done", {})),
		);
		const store = copilot.createCopilotStore();
		await store.sendMessage("Suggest a grade");

		expect(store.applySuggestion("nope")).toBeNull();
		expect(store.pendingSuggestions).toHaveLength(1);
	});

	it("applySuggestion is a no-op when nothing is pending", async () => {
		copilot.apiMode.value = true;
		fetchMock.mockResolvedValue(sseResponse(sseFrame("done", {})));
		const store = copilot.createCopilotStore();
		await store.sendMessage("hi");
		expect(store.applySuggestion("s1")).toBeNull();
	});

	it("dismissSuggestion removes the pending suggestion without returning it", async () => {
		copilot.apiMode.value = true;
		fetchMock.mockResolvedValue(
			sseResponse(sseFrame("suggestion", GRADE_SUGGESTION), sseFrame("done", {})),
		);
		const store = copilot.createCopilotStore();
		await store.sendMessage("Suggest a grade");

		const returned = store.dismissSuggestion("s1");

		expect(returned).toBeUndefined();
		expect(store.pendingSuggestions).toHaveLength(0);
		// The transcript message is kept (dismiss is not delete).
		expect(store.messages.some((m) => m.suggestion?.suggestionId === "s1")).toBe(true);
	});

	it("applies a suggestion attached to the final message event (message.suggestion)", async () => {
		copilot.apiMode.value = true;
		fetchMock.mockResolvedValue(
			sseResponse(
				sseFrame("message", {
					role: "assistant",
					content: "Here is the draft.",
					suggestion: { ...GRADE_SUGGESTION, suggestionId: "s2", kind: "draft" },
				}),
				sseFrame("done", {}),
			),
		);
		const store = copilot.createCopilotStore();
		await store.sendMessage("Draft feedback");

		expect(store.pendingSuggestions).toHaveLength(1);
		const applied = store.applySuggestion("s2");
		expect(applied).not.toBeNull();
		expect(applied?.kind).toBe("draft");
		expect(applied?.data).toEqual(GRADE_SUGGESTION.data);
		expect(store.pendingSuggestions).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Thread management (T.3) — server-backed list/open/new/delete/rename
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

const THREAD_META_1 = {
	id: "t-1",
	title: "Review submission 1",
	createdAt: "2026-08-01T10:00:00.000Z",
	updatedAt: "2026-08-01T12:00:00.000Z",
	messageCount: 3,
	lastPreview: "Done.",
	recallLimit: 10,
	recallCovered: 3,
	droppedCount: 0,
	estimatedTokens: 200,
};

const THREAD_DETAIL_1 = {
	...THREAD_META_1,
	messageCount: 4,
	messages: [
		{ id: "m1", role: "user", createdAt: "2026-08-01T11:00:00.000Z", text: "Compare cell 3" },
		{ id: "m2", role: "system", createdAt: "2026-08-01T11:00:00.000Z" },
		{
			id: "m3",
			role: "tool",
			createdAt: "2026-08-01T11:01:00.000Z",
			toolName: "read-notebook",
			ok: true,
		},
		{ id: "m4", role: "assistant", createdAt: "2026-08-01T11:02:00.000Z", text: "Done." },
	],
};

describe("thread management (T.3)", () => {
	it("loadThreads fetches the scoped list and renders it", async () => {
		copilot.apiMode.value = true;
		fetchMock.mockResolvedValue(
			jsonResponse({
				threads: [
					THREAD_META_1,
					{
						id: "t-2",
						title: "Second thread",
						createdAt: "2026-08-01T09:00:00.000Z",
						updatedAt: "2026-08-01T11:00:00.000Z",
						messageCount: 1,
					},
				],
			}),
		);

		const store = copilot.createCopilotStore({ submissionId: "sub-42" });
		await store.loadThreads();

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const call = fetchMock.mock.calls[0] as [RequestInfo | URL, RequestInit?];
		expect(String(call[0])).toContain("/api/copilot/threads?submissionId=sub-42");
		expect(store.threads.map((t) => t.id)).toEqual(["t-1", "t-2"]);
		expect(store.threads[0].title).toBe("Review submission 1");
	});

	it("uses the assignment scope for an assignment-scoped store", async () => {
		copilot.apiMode.value = true;
		fetchMock.mockResolvedValue(jsonResponse({ threads: [] }));

		const store = copilot.createCopilotStore({ assignmentId: "assign-1" });
		await store.loadThreads();

		const call = fetchMock.mock.calls[0] as [RequestInfo | URL, RequestInit?];
		expect(String(call[0])).toContain("/api/copilot/threads?assignmentId=assign-1");
	});

	it("openThread loads history, sets activeThread and persists the threadId", async () => {
		copilot.apiMode.value = true;
		fetchMock.mockResolvedValue(jsonResponse({ thread: THREAD_DETAIL_1 }));

		const store = copilot.createCopilotStore({ submissionId: "sub-42" });
		await store.openThread("t-1");

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const call = fetchMock.mock.calls[0] as [RequestInfo | URL, RequestInit?];
		expect(String(call[0])).toContain("/api/copilot/threads/t-1?submissionId=sub-42");
		expect(localStorage.getItem("copilot:activeThread:sub-42")).toBe("t-1");
		expect(store.activeThread).toMatchObject({
			id: "t-1",
			title: "Review submission 1",
			messageCount: 4,
		});
		expect(store.loadingHistory).toBe(false);
		// system skipped; user -> teacher; tool-only -> tool-result card;
		// assistant -> assistant bubble.
		expect(store.messages.map((m) => m.role)).toEqual(["teacher", "assistant", "assistant"]);
		expect(store.messages[0]).toMatchObject({ role: "teacher", content: "Compare cell 3" });
		expect(store.messages[1]).toMatchObject({
			kind: "tool-result",
			tool: "read-notebook",
			ok: true,
		});
		expect(store.messages[2]).toMatchObject({ role: "assistant", content: "Done." });
	});

	it("openThread clears the stored id when the thread 404s", async () => {
		copilot.apiMode.value = true;
		localStorage.setItem("copilot:activeThread:sub-42", "t-gone");
		fetchMock.mockResolvedValue(new Response("not found", { status: 404 }));

		const store = copilot.createCopilotStore({ submissionId: "sub-42" });
		await store.openThread("t-gone");

		expect(localStorage.getItem("copilot:activeThread:sub-42")).toBeNull();
		expect(store.activeThread).toBeNull();
		expect(store.loadingHistory).toBe(false);
	});

	it("newConversation clears messages + storage and refreshes the list", async () => {
		copilot.apiMode.value = true;
		fetchMock
			.mockResolvedValueOnce(jsonResponse({ thread: THREAD_DETAIL_1 }))
			.mockResolvedValueOnce(jsonResponse({ threads: [THREAD_META_1] }));

		const store = copilot.createCopilotStore({ submissionId: "sub-42" });
		await store.openThread("t-1");
		expect(store.messages.length).toBeGreaterThan(0);
		expect(localStorage.getItem("copilot:activeThread:sub-42")).toBe("t-1");

		store.newConversation();
		// The refresh is fire-and-forget — wait for the STATE, not the call.
		await vi.waitFor(() => expect(store.threads.map((t) => t.id)).toEqual(["t-1"]));

		expect(store.messages).toEqual([]);
		expect(localStorage.getItem("copilot:activeThread:sub-42")).toBeNull();
		expect(store.activeThread).toBeNull();
		// The list refresh landed.
		expect(store.threads.map((t) => t.id)).toEqual(["t-1"]);
	});

	it("deleteThread removes the thread from the list", async () => {
		copilot.apiMode.value = true;
		fetchMock
			.mockResolvedValueOnce(
				jsonResponse({
					threads: [
						THREAD_META_1,
						{
							...THREAD_META_1,
							id: "t-2",
							title: "Second thread",
							updatedAt: "2026-08-01T11:00:00.000Z",
						},
					],
				}),
			)
			.mockResolvedValueOnce(new Response(null, { status: 204 }));

		const store = copilot.createCopilotStore({ submissionId: "sub-42" });
		await store.loadThreads();
		expect(store.threads).toHaveLength(2);

		await store.deleteThread("t-1");

		const call = fetchMock.mock.calls[1] as [RequestInfo | URL, RequestInit?];
		expect(String(call[0])).toContain("/api/copilot/threads/t-1?submissionId=sub-42");
		expect(call[1]?.method).toBe("DELETE");
		expect(store.threads.map((t) => t.id)).toEqual(["t-2"]);
	});

	it("deleteThread resets to a new conversation when the ACTIVE thread is deleted", async () => {
		copilot.apiMode.value = true;
		localStorage.setItem("copilot:activeThread:sub-42", "t-1");
		fetchMock
			.mockResolvedValueOnce(jsonResponse({ thread: THREAD_DETAIL_1 })) // openThread history
			.mockResolvedValueOnce(new Response(null, { status: 204 })) // DELETE
			.mockResolvedValueOnce(jsonResponse({ threads: [] })); // newConversation refresh

		const store = copilot.createCopilotStore({ submissionId: "sub-42" });
		await store.openThread("t-1");
		expect(store.messages.length).toBeGreaterThan(0);

		await store.deleteThread("t-1");
		// newConversation's refresh is fire-and-forget — wait for the state.
		await vi.waitFor(() => expect(store.threads).toEqual([]));

		expect(store.messages).toEqual([]);
		expect(store.activeThread).toBeNull();
		expect(localStorage.getItem("copilot:activeThread:sub-42")).toBeNull();
		expect(store.threads).toEqual([]);
	});

	it("renameThread PATCHes the title and refreshes the list", async () => {
		copilot.apiMode.value = true;
		fetchMock
			.mockResolvedValueOnce(jsonResponse({ threads: [THREAD_META_1] }))
			.mockResolvedValueOnce(jsonResponse({ thread: { ...THREAD_META_1, title: "Renamed" } }))
			.mockResolvedValueOnce(
				jsonResponse({ threads: [{ ...THREAD_META_1, title: "Renamed" }] }),
			);

		const store = copilot.createCopilotStore({ submissionId: "sub-42" });
		await store.loadThreads();
		await store.renameThread("t-1", "Renamed");

		const call = fetchMock.mock.calls[1] as [RequestInfo | URL, RequestInit?];
		expect(String(call[0])).toContain("/api/copilot/threads/t-1?submissionId=sub-42");
		expect(call[1]?.method).toBe("PATCH");
		expect(JSON.parse((call[1]?.body as string) ?? "{}")).toEqual({ title: "Renamed" });
		expect(store.threads[0].title).toBe("Renamed");
	});

	it("restoreActiveThread auto-opens the stored thread and clears storage on 404", async () => {
		copilot.apiMode.value = true;
		localStorage.setItem("copilot:activeThread:sub-42", "t-1");
		fetchMock.mockResolvedValueOnce(jsonResponse({ thread: THREAD_DETAIL_1 }));

		const store = copilot.createCopilotStore({ submissionId: "sub-42" });
		await store.restoreActiveThread();

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(store.activeThread?.id).toBe("t-1");
		expect(store.messages.length).toBeGreaterThan(0);
		expect(localStorage.getItem("copilot:activeThread:sub-42")).toBe("t-1");

		// The stored thread vanished — restore clears the id and starts fresh.
		fetchMock.mockResolvedValueOnce(new Response("not found", { status: 404 }));
		const store2 = copilot.createCopilotStore({ submissionId: "sub-42" });
		await store2.restoreActiveThread();
		expect(localStorage.getItem("copilot:activeThread:sub-42")).toBeNull();
		expect(store2.activeThread).toBeNull();
		});

		describe("harness surface (W2a/W2d) — plan checklist + change ledger", () => {
		it("renders the plan from the plan event and advances status on tool events", async () => {
			copilot.apiMode.value = true;
			const chat = openSseResponse(
				sseFrame("plan", {
					steps: [
						{ id: "execute-notebook", label: "Execute notebook" },
						{ id: "apply-grading-changes", label: "Apply grading changes" },
					],
				}),
				sseFrame("tool-call", { tool: "process-submission", args: {} }),
				sseFrame("tool-result", { tool: "process-submission", ok: true, summary: "Executed" }),
				sseFrame("tool-call", { tool: "set-rubric-item", args: {} }),
				sseFrame("tool-result", { tool: "set-rubric-item", ok: true, summary: "Set" }),
				sseFrame("done", {}),
			);
			fetchMock.mockResolvedValue(chat.response);

			const store = copilot.createCopilotStore({ submissionId: "sub-42" });
			await store.sendMessage("Grade it");

			expect(store.planSteps).toEqual([
				{ id: "execute-notebook", label: "Execute notebook", status: "completed" },
				{ id: "apply-grading-changes", label: "Apply grading changes", status: "completed" },
			]);
		});

		it("marks a failed tool phase as error", async () => {
			copilot.apiMode.value = true;
			const chat = openSseResponse(
				sseFrame("plan", { steps: [{ id: "analyze-code", label: "Analyze code" }] }),
				sseFrame("tool-call", { tool: "analyze-code", args: {} }),
				sseFrame("tool-result", { tool: "analyze-code", ok: false, summary: "Failed" }),
				sseFrame("done", {}),
			);
			fetchMock.mockResolvedValue(chat.response);

			const store = copilot.createCopilotStore({ submissionId: "sub-42" });
			await store.sendMessage("Analyze");

			expect(store.planSteps[0]?.status).toBe("error");
		});

		it("builds ledger entries from change events with old → new", async () => {
			copilot.apiMode.value = true;
			const chat = openSseResponse(
				sseFrame("change", {
					changes: [
						{
							kind: "dimension",
							field: "code_quality_design",
							oldValue: 3,
							newValue: 4,
							submissionId: "sub-42",
						},
						{ kind: "rubric", field: "clarity", oldValue: null, newValue: "good" },
					],
				}),
				sseFrame("done", {}),
			);
			fetchMock.mockResolvedValue(chat.response);

			const store = copilot.createCopilotStore({ submissionId: "sub-42" });
			await store.sendMessage("Apply");

			expect(store.changes).toHaveLength(2);
			expect(store.changes[0]).toMatchObject({
				kind: "dimension",
				field: "code_quality_design",
				oldValue: 3,
				newValue: 4,
				submissionId: "sub-42",
				status: "pending",
			});
			expect(store.changes[1]).toMatchObject({
				kind: "rubric",
				field: "clarity",
				oldValue: null,
				newValue: "good",
			});
		});

		it("accept marks a change accepted; acceptAll marks every pending change", async () => {
			copilot.apiMode.value = true;
			const chat = openSseResponse(
				sseFrame("change", {
					changes: [
						{ kind: "dimension", field: "a", oldValue: 1, newValue: 2 },
						{ kind: "notes", field: "notes", oldValue: null, newValue: "hi" },
					],
				}),
				sseFrame("done", {}),
			);
			fetchMock.mockResolvedValue(chat.response);

			const store = copilot.createCopilotStore({ submissionId: "sub-42" });
			await store.sendMessage("Apply");

			store.acceptChange(store.changes[0]!.id);
			expect(store.changes[0]?.status).toBe("accepted");
			expect(store.changes[1]?.status).toBe("pending");

			store.acceptAllChanges();
			expect(store.changes[1]?.status).toBe("accepted");
		});

		it("reject reverts via the save API with the old value", async () => {
			copilot.apiMode.value = true;
			const chat = openSseResponse(
				sseFrame("change", {
					changes: [
						{
							kind: "dimension",
							field: "code_quality_design",
							oldValue: 3,
							newValue: 4,
							submissionId: "sub-42",
						},
					],
				}),
				sseFrame("done", {}),
			);
			fetchMock.mockResolvedValue(chat.response);

			const store = copilot.createCopilotStore({ submissionId: "sub-42" });
			await store.sendMessage("Apply");

			// The reject triggers a save POST — mock it.
			fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
			const ok = await store.rejectChange(store.changes[0]!.id);
			expect(ok).toBe(true);
			expect(store.changes[0]?.status).toBe("rejected");

			const saveCall = fetchMock.mock.calls[1] as [RequestInfo | URL, RequestInit?];
			expect(String(saveCall[0])).toContain("/api/submissions/sub-42/save");
			expect(JSON.parse((saveCall[1]?.body as string) ?? "{}")).toEqual({
				dimensions: { code_quality_design: 3 },
			});
		});

		it("ignores change events without a valid kind/field (additive contract)", async () => {
			copilot.apiMode.value = true;
			const chat = openSseResponse(
				sseFrame("change", {
					changes: [
						{ kind: "bogus", field: "x", oldValue: 1, newValue: 2 },
						{ kind: "dimension", oldValue: 1, newValue: 2 },
					],
				}),
				sseFrame("done", {}),
			);
			fetchMock.mockResolvedValue(chat.response);

			const store = copilot.createCopilotStore({ submissionId: "sub-42" });
			await store.sendMessage("Apply");

			expect(store.changes).toHaveLength(0);
		});

		it("captures the turn checkpoint from the checkpoint event (P3)", async () => {
			copilot.apiMode.value = true;
			const chat = openSseResponse(
				sseFrame("checkpoint", {
					turnId: "turn-1",
					snapshot: {
						rubric: { clarity: "ok" },
						dimensions: { code_quality_design: 3 },
						notes: "before",
						feedback: {},
					},
				}),
				sseFrame("change", {
					changes: [
						{
							kind: "rubric",
							field: "clarity",
							oldValue: "ok",
							newValue: "good",
							submissionId: "sub-42",
						},
					],
				}),
				sseFrame("done", {}),
			);
			fetchMock.mockResolvedValue(chat.response);

			const store = copilot.createCopilotStore({ submissionId: "sub-42" });
			await store.sendMessage("Grade it");

			expect(store.checkpoint).toEqual({
				turnId: "turn-1",
				rubric: { clarity: "ok" },
				dimensions: { code_quality_design: 3 },
				notes: "before",
				feedback: {},
			});
		});

		it("revertTurn restores the pre-turn snapshot via the save API and clears the ledger (P3)", async () => {
			copilot.apiMode.value = true;
			const chat = openSseResponse(
				sseFrame("checkpoint", {
					turnId: "turn-1",
					snapshot: {
						rubric: { clarity: "ok" },
						dimensions: { code_quality_design: 3 },
						notes: "before",
						feedback: {
							clarity: {
								checked: ["Uses readable variable names"],
								comments: {},
								deductions: {},
								notes: "",
							},
						},
					},
				}),
				sseFrame("change", {
					changes: [
						{
							kind: "rubric",
							field: "clarity",
							oldValue: "ok",
							newValue: "good",
							submissionId: "sub-42",
						},
						{
							kind: "dimension",
							field: "code_quality_design",
							oldValue: 3,
							newValue: 4,
							submissionId: "sub-42",
						},
					],
				}),
				sseFrame("done", {}),
			);
			fetchMock.mockResolvedValue(chat.response);

			const store = copilot.createCopilotStore({ submissionId: "sub-42" });
			await store.sendMessage("Grade it");
			expect(store.changes).toHaveLength(2);

			// The revert triggers a save POST with the full snapshot patch.
			fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
			const ok = await store.revertTurn();
			expect(ok).toBe(true);

			const saveCall = fetchMock.mock.calls[1] as [RequestInfo | URL, RequestInit?];
			expect(String(saveCall[0])).toContain("/api/submissions/sub-42/save");
			expect(JSON.parse((saveCall[1]?.body as string) ?? "{}")).toEqual({
				rubric: { clarity: "ok" },
				dimensions: { code_quality_design: 3 },
				notes: "before",
				feedback: {
					clarity: {
						checked: ["Uses readable variable names"],
						comments: {},
						deductions: {},
						notes: "",
					},
				},
			});

			// The turn's ledger is cleared and the checkpoint consumed.
			expect(store.changes).toHaveLength(0);
			expect(store.checkpoint).toBeNull();
		});

		it("revertTurn returns false without a checkpoint (P3)", async () => {
			copilot.apiMode.value = true;
			const chat = openSseResponse(sseFrame("done", {}));
			fetchMock.mockResolvedValue(chat.response);

			const store = copilot.createCopilotStore({ submissionId: "sub-42" });
			await store.sendMessage("Hi");

			expect(store.checkpoint).toBeNull();
			expect(await store.revertTurn()).toBe(false);
			// No save POST was attempted.
			expect(fetchMock).toHaveBeenCalledTimes(1);
		});

		it("revertTurn returns false when the save fails and keeps the ledger (P3)", async () => {
			copilot.apiMode.value = true;
			const chat = openSseResponse(
				sseFrame("checkpoint", {
					turnId: "turn-1",
					snapshot: { rubric: {}, dimensions: {}, notes: null, feedback: {} },
				}),
				sseFrame("change", {
					changes: [
						{
							kind: "notes",
							field: "notes",
							oldValue: null,
							newValue: "hi",
							submissionId: "sub-42",
						},
					],
				}),
				sseFrame("done", {}),
			);
			fetchMock.mockResolvedValue(chat.response);

			const store = copilot.createCopilotStore({ submissionId: "sub-42" });
			await store.sendMessage("Grade it");

			fetchMock.mockResolvedValueOnce(new Response("boom", { status: 500 }));
			const ok = await store.revertTurn();
			expect(ok).toBe(false);
			expect(store.changes).toHaveLength(1);
			expect(store.checkpoint).not.toBeNull();
		});

		it("revertTurn returns false in assignment scope even with a checkpoint (P3)", async () => {
			copilot.apiMode.value = true;
			const chat = openSseResponse(
				sseFrame("checkpoint", {
					turnId: "turn-1",
					snapshot: { rubric: {}, dimensions: {}, notes: null, feedback: {} },
				}),
				sseFrame("done", {}),
			);
			fetchMock.mockResolvedValue(chat.response);

			const store = copilot.createCopilotStore({ assignmentId: "assign-1" });
			await store.sendMessage("Summarize");

			// The checkpoint event still populated the snapshot, but there is
			// no submission to restore — the revert must refuse and the
			// button must stay hidden.
			expect(store.checkpoint).not.toBeNull();
			expect(store.canRevertTurn).toBe(false);
			expect(await store.revertTurn()).toBe(false);
			// No save POST was attempted (only the chat fetch).
			expect(fetchMock).toHaveBeenCalledTimes(1);
		});

		it("revertTurn returns false while the turn is still streaming (P3)", async () => {
			copilot.apiMode.value = true;
			const chat = openSseResponse(
				sseFrame("checkpoint", {
					turnId: "turn-1",
					snapshot: { rubric: {}, dimensions: {}, notes: null, feedback: {} },
				}),
				// The stream stays OPEN — the checkpoint is set mid-stream.
			);
			fetchMock.mockResolvedValue(chat.response);

			const store = copilot.createCopilotStore({ submissionId: "sub-42" });
			const sendPromise = store.sendMessage("Grade it");
			await vi.waitFor(() => expect(store.checkpoint).not.toBeNull());
			expect(store.isStreaming).toBe(true);

			// Mid-stream revert is refused — the agent's remaining writes
			// would land on top of the restored state.
			expect(store.canRevertTurn).toBe(false);
			expect(await store.revertTurn()).toBe(false);
			// No save POST was attempted (only the chat fetch).
			expect(fetchMock).toHaveBeenCalledTimes(1);

			// Settle the still-reading chat stream.
			chat.push(sseFrame("done", {}));
			await sendPromise;
			expect(store.isStreaming).toBe(false);
			// Once the turn ends, the revert is live again.
			expect(store.canRevertTurn).toBe(true);
		});
		});

		describe("steering (W3b) — queue / steer-at-boundary / stop", () => {
		it("queues a message while streaming and drains it after the run ends", async () => {
			copilot.apiMode.value = true;
			// First turn: tool-call -> tool-result -> done. Second turn (queued): done.
			const chat = openSseResponse(
				sseFrame("tool-call", { tool: "analyze-code", args: {} }),
				sseFrame("tool-result", { tool: "analyze-code", ok: true, summary: "Done" }),
				sseFrame("done", {}),
			);
			fetchMock.mockResolvedValue(chat.response);

			const store = copilot.createCopilotStore({ submissionId: "sub-42" });
			const sendPromise = store.sendMessage("First");
			// While streaming, queue a second message.
			expect(store.queueMessage("Second")).toBe(true);
			expect(store.queuedMessages).toEqual(["Second"]);
			await sendPromise;

			// The queued message was drained and sent as a second turn.
			expect(fetchMock).toHaveBeenCalledTimes(2);
			const secondCall = fetchMock.mock.calls[1] as [RequestInfo | URL, RequestInit?];
			expect(JSON.parse((secondCall[1]?.body as string) ?? "{}").message).toBe("Second");
			expect(store.queuedMessages).toEqual([]);
		});

		it("steer queues the message and stops at the next tool boundary", async () => {
			copilot.apiMode.value = true;
			let chat!: ReturnType<typeof openSseResponse>;
			fetchMock.mockImplementation((_url, init) => {
				chat = openSseResponse(
					sseFrame("tool-call", { tool: "analyze-code", args: {} }),
					sseFrame("tool-result", { tool: "analyze-code", ok: true, summary: "Done" }),
					// The stream is aborted after the tool-result — no done frame needed.
				);
				// Mirror real fetch: aborting the request rejects pending reads.
				init?.signal?.addEventListener("abort", () => {
					chat.fail(new DOMException("Aborted", "AbortError"));
				});
				return Promise.resolve(chat.response);
			});

			const store = copilot.createCopilotStore({ submissionId: "sub-42" });
			const sendPromise = store.sendMessage("First");
			expect(store.steerMessage("Redirect")).toBe(true);
			await sendPromise;

			// The steer aborted the stream after the tool-result; the queued
			// message then sent as a second turn.
			expect(fetchMock).toHaveBeenCalledTimes(2);
			const secondCall = fetchMock.mock.calls[1] as [RequestInfo | URL, RequestInit?];
			expect(JSON.parse((secondCall[1]?.body as string) ?? "{}").message).toBe("Redirect");
		});

		it("stop aborts the current stream immediately", async () => {
			copilot.apiMode.value = true;
			let chat!: ReturnType<typeof openSseResponse>;
			fetchMock.mockImplementation((_url, init) => {
				chat = openSseResponse(
					sseFrame("tool-call", { tool: "analyze-code", args: {} }),
					// Never ends — the stop aborts it.
				);
				init?.signal?.addEventListener("abort", () => {
					chat.fail(new DOMException("Aborted", "AbortError"));
				});
				return Promise.resolve(chat.response);
			});

			const store = copilot.createCopilotStore({ submissionId: "sub-42" });
			const sendPromise = store.sendMessage("First");
			store.stopStream();
			await sendPromise;

			expect(store.isStreaming).toBe(false);
			// The abort surfaced an error message (the stream was cancelled).
			expect(store.messages.some((m) => m.kind === "error")).toBe(true);
		});

		it("queueMessage returns false when not streaming", () => {
			copilot.apiMode.value = true;
			const store = copilot.createCopilotStore({ submissionId: "sub-42" });
			expect(store.queueMessage("Nope")).toBe(false);
			expect(store.queuedMessages).toEqual([]);
		});
		});
});
