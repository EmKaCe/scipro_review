/**
 * @file Copilot store — SSE client for the agentic copilot.
 *
 * Talks to the teacher-mode API routes:
 *   - POST /api/copilot/chat     → text/event-stream of agent events. When a
 *     tool call is suspended for approval the reader STAYS OPEN: the run's
 *     continuation resumes on this SAME stream after the decision.
 *   - POST /api/copilot/approval → empty response; only the decision is
 *     POSTed, the response body is never read.
 *
 * Frames are `event` name + newline + `data` (JSON) + blank line; both the
 * bare wire format and the standard `event:`/`data:` prefix form are parsed.
 * Events from the chat stream are handled by ONE parser (`processSseStream`
 * + `handleSseEvent`).
 *
 * In the static (student) build there is no copilot server: sendMessage
 * appends a local "unavailable" message instead of fetching (see apiMode).
 */

import { base } from "$app/paths";

// ---------------------------------------------------------------------------
// Stream lifecycle
// ---------------------------------------------------------------------------

/** Abort a chat stream that sends no data for this long (reset on activity). */
export const STREAM_IDLE_TIMEOUT_MS = 180_000;
/** Absolute upper bound for one chat stream — approvals included. */
export const STREAM_HARD_CAP_MS = 10 * 60_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Wire event kinds reflected in the message list. */
export type CopilotMessageKind =
	"text" | "tool-call" | "tool-result" | "approval" | "suggestion" | "error";

/** Suggestion kinds emitted by the agent. */
export type SuggestionKind = "grade" | "draft" | "fix" | "export";

/** Suggestion payload shared by the `suggestion` event and `message.suggestion`. */
export interface CopilotSuggestion {
	suggestionId: string;
	kind: SuggestionKind;
	title: string;
	body: string;
	actionLabel: string;
	/** Structured apply data emitted by the tool (forwarded to the page on apply). */
	data?: unknown;
}

export interface CopilotMessage {
	id: string;
	role: "teacher" | "assistant";
	content: string;
	/** Epoch ms — plain number so no mutable Date objects enter state. */
	timestamp: number;
	/**
	 * Display-class type, kept for existing consumers (hint chips etc.):
	 * "command" for slash-prefixed teacher messages, "suggestion"/"draft"
	 * for suggestion messages, "text" otherwise.
	 */
	type: "text" | "command" | "suggestion" | "draft";
	/** Wire-class kind: which SSE event produced this message. */
	kind: CopilotMessageKind;
	/** Tool name (tool-call / tool-result / approval). */
	tool?: string;
	/** Tool arguments in display form (tool-call / approval). */
	args?: string;
	/** Tool success flag (tool-result). */
	ok?: boolean;
	/** Tool result summary (tool-result). */
	summary?: string;
	/** Run id of the suspended run (approval). */
	runId?: string;
	/** Tool call id awaiting a decision (approval). */
	toolCallId?: string;
	/** Whether the approval request was "ask" or "blocked". */
	approvalDecision?: "ask" | "blocked";
	/** Suggestion payload (suggestion / message with suggestion). */
	suggestion?: CopilotSuggestion;
}

export interface PendingSuggestion {
	id: string;
	title: string;
	description: string;
	type: "grade" | "draft" | "fix" | "export";
	/** Structured apply data (see CopilotSuggestion.data). */
	data?: unknown;
}

/** A tool call suspended for teacher approval. */
export interface PendingApproval {
	runId: string;
	toolCallId: string;
	tool: string;
	argsRedacted: string;
	decision: "ask" | "blocked";
}

// ---------------------------------------------------------------------------
// Teacher-mode switch
// ---------------------------------------------------------------------------

/**
 * Teacher-mode switch — same mutable-holder pattern as criteria-loader.ts:
 * computed once at module top from the compile-time `__TEACHER_MODE__`
 * define, exported as an object so tests can flip `apiMode.value` (ESM
 * namespace bindings are read-only, so a bare `export let` could not be
 * reassigned from tests).
 */
export const apiMode: { value: boolean } = {
	value: typeof __TEACHER_MODE__ !== "undefined" && __TEACHER_MODE__,
};

// ---------------------------------------------------------------------------
// SSE parsing
// ---------------------------------------------------------------------------

/** Known SSE event names (used to parse bare `name\ndata\n\n` frames). */
const SSE_EVENT_NAMES: readonly string[] = [
	"thinking",
	"tool-call",
	"tool-result",
	"approval-request",
	"message-delta",
	"message",
	"suggestion",
	"error",
	"done",
];

interface SseFrame {
	event: string;
	data: unknown;
}

/**
 * Parse one SSE frame. Accepts both the bare wire format
 * (`<event>\n<json>\n\n`) and the standard `event:`/`data:` prefix form.
 */
function parseSseFrame(frame: string): SseFrame | null {
	const lines = frame
		.replace(/\r\n/g, "\n")
		.split("\n")
		.map((line) => line.trim());
	let event = "";
	let dataRaw: string | null = null;
	for (const line of lines) {
		if (!line) continue;
		if (line.startsWith("event:")) {
			event = line.slice("event:".length).trim();
		} else if (line.startsWith("data:")) {
			dataRaw = line.slice("data:".length).trim();
		} else if (!event && SSE_EVENT_NAMES.includes(line)) {
			event = line;
		} else if (dataRaw === null && (line.startsWith("{") || line.startsWith("["))) {
			dataRaw = line;
		}
	}
	if (!event) return null;
	let data: unknown = null;
	if (dataRaw !== null && dataRaw !== "") {
		try {
			data = JSON.parse(dataRaw);
		} catch {
			data = dataRaw;
		}
	}
	return { event, data };
}

/** Render tool args as a bounded display string (the server pre-redacts). */
function formatArgs(args: unknown): string {
	if (args === undefined || args === null) return "";
	const raw = typeof args === "string" ? args : safeStringify(args);
	return raw.length > 200 ? `${raw.slice(0, 200)}...` : raw;
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "";
	} catch {
		return String(value);
	}
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * Creates the reactive copilot store, bound to one scope.
 *
 * @param options - `submissionId` scopes the chat to one submission;
 *   `assignmentId` scopes it to a whole assignment (dashboard chat — the
 *   agent's context tools fall back to the assignment scope when no
 *   submission is given). At least one scope id is sent with every chat
 *   request; `threadId`, when provided, seeds the active thread (otherwise
 *   the store restores it from localStorage or generates one on the first
 *   send — see A.2).
 */
export function createCopilotStore(options?: {
	submissionId?: string;
	assignmentId?: string;
	threadId?: string;
}) {
	const submissionId = options?.submissionId ?? "";
	const assignmentId = options?.assignmentId ?? "";
	// The store owns the ACTIVE thread id per scope: generated on the first
	// send, persisted in localStorage so reloads / browser restarts resume
	// the same conversation, and reused on every turn. Message content stays
	// server-side — only the thread id (a UUID) lives in localStorage.
	const scopeKey = submissionId || assignmentId || "copilot";
	const threadStorageKey = `copilot:activeThread:${scopeKey}`;

	function loadStoredThreadId(): string {
		try {
			return localStorage.getItem(threadStorageKey) ?? "";
		} catch {
			return "";
		}
	}
	function storeThreadId(id: string): void {
		try {
			localStorage.setItem(threadStorageKey, id);
		} catch {
			// Storage unavailable (private mode / tests) — continuity is best-effort.
		}
	}
	function clearStoredThreadId(): void {
		try {
			localStorage.removeItem(threadStorageKey);
		} catch {
			// ignore
		}
	}
	let activeThreadId = options?.threadId ?? loadStoredThreadId();

	let messages = $state<CopilotMessage[]>([]);
	let isStreaming = $state(false);
	let pendingSuggestions = $state<PendingSuggestion[]>([]);
	let pendingApproval = $state<PendingApproval | null>(null);
	let inputValue = $state("");

	/** Id of the assistant text message currently accumulated from deltas. */
	let currentTextMessageId: string | null = null;

	// Per-send stream lifecycle: one AbortController per sendMessage, an idle
	// timer that resets on stream activity, and a hard cap that bounds the
	// whole request (approvals included — a suspended run may idle for a long
	// time while the teacher decides).
	let activeController: AbortController | null = null;
	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	let hardCap: ReturnType<typeof setTimeout> | undefined;

	/**
	 * (Re)arm the idle timeout. While an approval is pending the teacher may
	 * take arbitrarily long — the paused hook holds the timer (it reschedules
	 * instead of aborting); the hard cap still bounds the stream.
	 */
	function resetIdle(): void {
		if (idleTimer) clearTimeout(idleTimer);
		idleTimer = setTimeout(() => {
			if (pendingApproval) {
				resetIdle();
				return;
			}
			activeController?.abort();
		}, STREAM_IDLE_TIMEOUT_MS);
	}

	const availableCommands = [
		{ command: "/draft", description: "Generate feedback notes" },
		{ command: "/suggest", description: "Suggest grade dimensions" },
		{ command: "/explain", description: "Explain a cell or error" },
		{ command: "/autofix", description: "Fix an error in a cell" },
		{ command: "/compare", description: "Compare student approach to key" },
	];

	function appendMessage(message: CopilotMessage): void {
		messages = [...messages, message];
	}

	function suggestionType(suggestion?: CopilotSuggestion): CopilotMessage["type"] {
		if (!suggestion) return "text";
		return suggestion.kind === "draft" ? "draft" : "suggestion";
	}

	function assistantMessage(
		content: string,
		kind: CopilotMessageKind,
		extra: Partial<
			Omit<CopilotMessage, "id" | "role" | "content" | "timestamp" | "type" | "kind">
		> = {},
	): CopilotMessage {
		return {
			id: crypto.randomUUID(),
			role: "assistant",
			content,
			timestamp: Date.now(),
			type: suggestionType(extra.suggestion),
			kind,
			...extra,
		};
	}

	function pushPendingSuggestion(suggestion: CopilotSuggestion): void {
		pendingSuggestions = [
			...pendingSuggestions,
			{
				id: suggestion.suggestionId,
				title: suggestion.title,
				description: suggestion.body,
				type: suggestion.kind,
				data: suggestion.data,
			},
		];
	}

	/**
	 * Apply a pending suggestion: removes it from `pendingSuggestions` and
	 * returns the full suggestion payload (including `data`) so the caller
	 * can forward it to the page. The suggestion message STAYS in the
	 * transcript — applying does not delete history. Returns null for an
	 * unknown/already-resolved suggestion id.
	 */
	function applySuggestion(suggestionId: string): CopilotSuggestion | null {
		const pending = pendingSuggestions.find((s) => s.id === suggestionId);
		if (!pending) return null;
		pendingSuggestions = pendingSuggestions.filter((s) => s.id !== suggestionId);
		// The full payload lives on the transcript message; fall back to the
		// pending entry (actionLabel unknown there) only if it is missing.
		const message = messages.find((m) => m.suggestion?.suggestionId === suggestionId);
		return (
			message?.suggestion ?? {
				suggestionId: pending.id,
				kind: pending.type,
				title: pending.title,
				body: pending.description,
				actionLabel: "",
				data: pending.data,
			}
		);
	}

	/** Dismiss a pending suggestion: removes it without applying. */
	function dismissSuggestion(suggestionId: string): void {
		pendingSuggestions = pendingSuggestions.filter((s) => s.id !== suggestionId);
	}

	/**
	 * Single handler for every SSE event, whichever stream it came from.
	 * Ends streaming on `error`/`done`; a tool call awaiting approval
	 * suspends the run (isStreaming stays true).
	 */
	function handleSseEvent(event: string, data: unknown): void {
		switch (event) {
			case "thinking":
				// No payload — the typing indicator is driven by isStreaming.
				break;
			case "tool-call": {
				const payload = (data ?? {}) as { tool?: string; args?: unknown };
				const tool = payload.tool ?? "unknown";
				appendMessage(
					assistantMessage(`Running tool: ${tool}`, "tool-call", {
						tool,
						args: formatArgs(payload.args),
					}),
				);
				break;
			}
			case "tool-result": {
				const payload = (data ?? {}) as { tool?: string; ok?: boolean; summary?: string };
				const ok = payload.ok === true;
				const summary = payload.summary ?? (ok ? "Tool completed" : "Tool failed");
				appendMessage(
					assistantMessage(summary, "tool-result", {
						tool: payload.tool,
						ok,
						summary,
					}),
				);
				break;
			}
			case "approval-request": {
				const payload = (data ?? {}) as {
					runId?: string;
					toolCallId?: string;
					tool?: string;
					argsRedacted?: string;
					decision?: "ask" | "blocked";
				};
				const decision: "ask" | "blocked" =
					payload.decision === "blocked" ? "blocked" : "ask";
				const approval: PendingApproval = {
					runId: payload.runId ?? "",
					toolCallId: payload.toolCallId ?? "",
					tool: payload.tool ?? "unknown",
					argsRedacted: payload.argsRedacted ?? "",
					decision,
				};
				pendingApproval = approval;
				appendMessage(
					assistantMessage(`Approval needed for tool: ${approval.tool}`, "approval", {
						tool: approval.tool,
						args: approval.argsRedacted,
						runId: approval.runId,
						toolCallId: approval.toolCallId,
						approvalDecision: decision,
					}),
				);
				break;
			}
			case "message-delta": {
				const payload = (data ?? {}) as { text?: string };
				const text = payload.text ?? "";
				if (!text) break;
				if (currentTextMessageId) {
					const index = messages.findIndex((m) => m.id === currentTextMessageId);
					if (index >= 0) {
						const current = messages[index];
						messages = [
							...messages.slice(0, index),
							{ ...current, content: current.content + text },
							...messages.slice(index + 1),
						];
						break;
					}
					currentTextMessageId = null;
				}
				const message = assistantMessage(text, "text");
				currentTextMessageId = message.id;
				appendMessage(message);
				break;
			}
			case "message": {
				const payload = (data ?? {}) as {
					role?: string;
					content?: string;
					suggestion?: CopilotSuggestion;
				};
				const content = payload.content ?? "";
				const suggestion = payload.suggestion;
				if (currentTextMessageId) {
					const index = messages.findIndex((m) => m.id === currentTextMessageId);
					if (index >= 0) {
						const current = messages[index];
						messages = [
							...messages.slice(0, index),
							{ ...current, content, suggestion, type: suggestionType(suggestion) },
							...messages.slice(index + 1),
						];
					} else {
						appendMessage(assistantMessage(content, "text", { suggestion }));
					}
					currentTextMessageId = null;
				} else {
					appendMessage(assistantMessage(content, "text", { suggestion }));
				}
				if (suggestion) pushPendingSuggestion(suggestion);
				break;
			}
			case "suggestion": {
				const suggestion = (data ?? {}) as CopilotSuggestion;
				appendMessage(assistantMessage(suggestion.title, "suggestion", { suggestion }));
				pushPendingSuggestion(suggestion);
				break;
			}
			case "error": {
				const payload = (data ?? {}) as { message?: string };
				pendingApproval = null;
				currentTextMessageId = null;
				appendMessage(assistantMessage(payload.message ?? "Copilot error", "error"));
				isStreaming = false;
				break;
			}
			case "done":
				pendingApproval = null;
				currentTextMessageId = null;
				isStreaming = false;
				break;
		}
	}

	/** Consume complete frames; returns the un-consumed buffer tail. */
	function consumeFrames(buffer: string): string {
		let separator: number;
		while ((separator = buffer.indexOf("\n\n")) !== -1) {
			const frame = buffer.slice(0, separator);
			buffer = buffer.slice(separator + 2);
			const parsed = parseSseFrame(frame);
			if (parsed) handleSseEvent(parsed.event, parsed.data);
			// A terminal event (done/error) ends consumption — anything still
			// buffered after it is discarded. A suspended approval does NOT
			// stop consumption: the reader stays open and the continuation
			// arrives on this same stream.
			if (!isStreaming) return "";
		}
		return buffer;
	}

	/**
	 * Read and parse one SSE stream through the single event handler.
	 * Returns when the stream ends, or on `done`/`error`. The reader STAYS
	 * OPEN across a suspended approval: the server resumes the SAME stream
	 * after POST /api/copilot/approval and this loop keeps reading the
	 * continuation (see approve()).
	 */
	async function processSseStream(
		reader: ReadableStreamDefaultReader<Uint8Array>,
		hooks: { onActivity?: () => void; paused?: () => boolean } = {},
	): Promise<void> {
		const decoder = new TextDecoder();
		let buffer = "";
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			// Stream activity resets the idle timeout — unless the run is
			// suspended on an approval (the teacher decides on their own
			// clock; only the hard cap applies then).
			if (!hooks.paused?.()) hooks.onActivity?.();
			buffer += decoder.decode(value, { stream: true });
			buffer = consumeFrames(buffer);
			if (!isStreaming) return;
		}
		// Stream ended without a terminal frame — flush any leftover tail.
		consumeFrames(buffer);
	}

	/** Surface a stream/network failure as an error message; never retries. */
	function handleStreamError(error: unknown): void {
		pendingApproval = null;
		currentTextMessageId = null;
		appendMessage(
			assistantMessage(
				error instanceof Error ? error.message : "Copilot stream error",
				"error",
			),
		);
		isStreaming = false;
	}

	async function sendMessage(content: string): Promise<void> {
		if (isStreaming) return;
		appendMessage({
			id: crypto.randomUUID(),
			role: "teacher",
			content,
			timestamp: Date.now(),
			type: content.startsWith("/") ? "command" : "text",
			kind: "text",
		});

		// Static (student) build: no copilot server — reflect a local
		// "unavailable" note instead of fetching.
		if (!apiMode.value) {
			appendMessage(
				assistantMessage("The AI copilot is not available in this build.", "text"),
			);
			return;
		}

		isStreaming = true;
		const controller = new AbortController();
		activeController = controller;
		resetIdle();
		hardCap = setTimeout(() => controller.abort(), STREAM_HARD_CAP_MS);
		try {
			// Ensure a thread id exists before the first turn and remember it
			// so the conversation survives reloads. The first turn also sends
			// a title derived from the first message (the server stores it
			// when creating the thread — see Task T).
			const isNewThread = !activeThreadId;
			if (isNewThread) {
				activeThreadId = crypto.randomUUID();
				storeThreadId(activeThreadId);
			}
			const response = await fetch(`${base}/api/copilot/chat`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				signal: controller.signal,
				body: JSON.stringify({
					...(submissionId ? { submissionId } : {}),
					...(assignmentId ? { assignmentId } : {}),
					message: content,
					...(activeThreadId ? { threadId: activeThreadId } : {}),
					...(isNewThread ? { title: content.split("\n")[0].slice(0, 60) } : {}),
				}),
			});
			if (!response.ok || !response.body) {
				throw new Error(`Copilot request failed (${response.status})`);
			}
			await processSseStream(response.body.getReader(), {
				onActivity: resetIdle,
				paused: () => pendingApproval !== null,
			});
		} catch (error) {
			if (controller.signal.aborted) {
				handleStreamError(new Error("Copilot request timed out or was cancelled"));
			} else {
				handleStreamError(error);
			}
		} finally {
			clearTimeout(hardCap);
			clearTimeout(idleTimer);
			hardCap = undefined;
			idleTimer = undefined;
			activeController = null;
		}
	}

	/**
	 * Resume a suspended run: POSTs the teacher's decision to the approval
	 * route. The approval response is EMPTY (verified server contract) — the
	 * run's continuation arrives on the ORIGINAL chat stream that sendMessage
	 * is still reading, so the body is never read (it would be parsed
	 * harmlessly if it ever contained anything).
	 */
	async function approve(decision: "approve" | "deny"): Promise<void> {
		const approval = pendingApproval;
		if (!approval) return;
		pendingApproval = null;
		try {
			const response = await fetch(`${base}/api/copilot/approval`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					runId: approval.runId,
					toolCallId: approval.toolCallId,
					decision,
				}),
			});
			if (!response.ok) {
				throw new Error(`Copilot approval failed (${response.status})`);
			}
		} catch (error) {
			handleStreamError(error);
		}
	}

	/**
	 * Clear the in-memory transcript (UI-only reset). This does NOT rotate the
	 * active thread id — a later "new conversation" action (Task T) generates
	 * a fresh thread id, calls clearStoredThreadId(), and resets the UI.
	 */
	function clearMessages(): void {
		messages = [];
		pendingSuggestions = [];
		pendingApproval = null;
		currentTextMessageId = null;
	}

	return {
		get messages() {
			return messages;
		},
		get isStreaming() {
			return isStreaming;
		},
		get pendingSuggestions() {
			return pendingSuggestions;
		},
		get pendingApproval() {
			return pendingApproval;
		},
		get inputValue() {
			return inputValue;
		},
		set inputValue(v: string) {
			inputValue = v;
		},
		availableCommands,
		sendMessage,
		approve,
		applySuggestion,
		dismissSuggestion,
		clearMessages,
	};
}
