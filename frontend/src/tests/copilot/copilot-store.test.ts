/**
 * @file Unit tests for copilot-store.svelte.ts — the SSE copilot client.
 *
 * Mocks fetch with controllable ReadableStream responses and exercises the
 * store: streaming event parsing, the suspended-approval flow (approve()
 * POSTs the decision and parses the continuation stream through the same
 * handler), error surfacing, static-build degradation (apiMode holder), and
 * clearMessages reset.
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
	it("sets pendingApproval, keeps the stream open, and parses the continuation on approve()", async () => {
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
		const continuation = openSseResponse(
			sseFrame("tool-result", {
				tool: "archive-submission",
				ok: true,
				summary: "Archived",
			}),
			sseFrame("message", { role: "assistant", content: "Done." }),
			sseFrame("done", {}),
		);
		fetchMock.mockResolvedValueOnce(chat.response).mockResolvedValueOnce(continuation.response);

		const store = copilot.createCopilotStore({ submissionId: "sub-42" });
		await store.sendMessage("Archive it");

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
		expect(store.pendingApproval).toBeNull();
		expect(store.isStreaming).toBe(false);
		expect(store.messages.map((m) => m.kind)).toEqual([
			"text",
			"approval",
			"tool-result",
			"text",
		]);
	});

	it("POSTs a deny decision and clears pendingApproval", async () => {
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
		const continuation = openSseResponse(sseFrame("done", {}));
		fetchMock.mockResolvedValueOnce(chat.response).mockResolvedValueOnce(continuation.response);

		const store = copilot.createCopilotStore();
		await store.sendMessage("Delete it");
		expect(store.pendingApproval?.decision).toBe("blocked");
		expect(store.pendingApproval?.argsRedacted).toBe("{}");

		await store.approve("deny");

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(bodyOf(fetchMock.mock.calls[1] as [RequestInfo | URL, RequestInit?])).toEqual({
			runId: "run-2",
			toolCallId: "call-2",
			decision: "deny",
		});
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
		await store.sendMessage("Do it");
		expect(store.pendingApproval).not.toBeNull();
		expect(store.messages.length).toBeGreaterThan(0);

		store.clearMessages();

		expect(store.messages).toEqual([]);
		expect(store.pendingSuggestions).toEqual([]);
		expect(store.pendingApproval).toBeNull();
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
