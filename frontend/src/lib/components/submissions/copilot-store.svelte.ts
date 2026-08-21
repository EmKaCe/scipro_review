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
import { saveGrading, type GradingPatch } from "$lib/services/submissions-api.js";
import type { CategoryFeedback } from "$lib/types/evaluation.js";

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
	/** A tool call awaiting a decision (approval). */
	toolCallId?: string;
	/** Whether the approval request was "ask" or "blocked". */
	approvalDecision?: "ask" | "blocked";
	/** Suggestion payload (suggestion / message with suggestion). */
	suggestion?: CopilotSuggestion;
}

/** One step of the harness plan (W2a) — status tracked client-side. */
export interface CopilotPlanStep {
	id: string;
	label: string;
	status: "pending" | "in_progress" | "completed" | "error";
}

/** One grading-state change for the change ledger (W2d). */
export interface CopilotChange {
	id: string;
	kind: "rubric" | "dimension" | "notes";
	field: string;
	oldValue: unknown;
	newValue: unknown;
	submissionId?: string;
	status: "pending" | "accepted" | "rejected";
}

/**
 * A turn's pre-write grading snapshot (P3) — the state the Revert turn
 * button restores via the save API. Mirrors the server's GradingSnapshot.
 */
export interface CopilotCheckpoint {
	/** Id of the turn this checkpoint belongs to (one per run). */
	turnId: string;
	/** Rubric selections: criterion key -> selected option key. */
	rubric: Record<string, string>;
	/** Dimension scores: dimension id -> slider value (points deducted). */
	dimensions: Record<string, number>;
	/** Free-form teacher notes (null when the submission has no notes). */
	notes: string | null;
	/** Per-category feedback (v2 CategoryFeedback shape, keyed by category key). */
	feedback: Record<string, CategoryFeedback>;
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

/**
 * Thread metadata as served by GET /api/copilot/threads. Local
 * mirror of the server's CopilotThreadMeta — the store never imports from
 * `$lib/server`.
 */
export interface CopilotThreadMeta {
	id: string;
	title: string;
	createdAt: string; // ISO
	updatedAt: string; // ISO
	messageCount: number;
	lastPreview?: string;
	/** Effective recall window (settings.copilot.lastMessages). */
	recallLimit: number;
	/** min(messageCount, recallLimit) — how many of the stored messages the model sees. */
	recallCovered: number;
	/** max(0, messageCount - recallLimit) — messages outside the model's context. */
	droppedCount: number;
	/** Rough estimate of the recall window's token size (chars / 4, rounded to 100). */
	estimatedTokens: number;
	/** How many times the thread has been auto-compacted (V). */
	compactionCount: number;
	/** Whether a compaction summary is stored in the thread metadata (V). */
	hasSummary: boolean;
}

/** One message of a thread detail, as served by the thread GET route. */
export interface CopilotThreadMessage {
	id: string;
	role: "user" | "assistant" | "tool" | "system"; // "tool" is derived server-side
	createdAt: string;
	text?: string;
	toolName?: string;
	ok?: boolean;
}

/** Thread detail payload of GET /api/copilot/threads/[threadId]. */
export interface CopilotThreadDetail extends CopilotThreadMeta {
	messages: CopilotThreadMessage[];
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
	"plan",
	"change",
	"checkpoint",
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
	// Harness surface (W2a/W2d): the plan checklist + the change ledger.
	let planSteps = $state<CopilotPlanStep[]>([]);
	let changes = $state<CopilotChange[]>([]);
	// P3 turn checkpoints: the current turn's pre-write grading snapshot
	// (populated from the checkpoint stream event) — drives the Revert turn
	// button in the change ledger.
	let checkpoint = $state<CopilotCheckpoint | null>(null);
	// Steering surface (W3b): queued messages + graceful-stop flag.
	let queuedMessages = $state<string[]>([]);
	let stopRequested = $state(false);
	// Thread surface: the server is the source of truth for the
	// thread list; localStorage holds only the ACTIVE thread id.
	let threads = $state<CopilotThreadMeta[]>([]);
	let activeThread = $state<CopilotThreadMeta | null>(null);
	let loadingHistory = $state(false);

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

	// -----------------------------------------------------------------------
	// Harness plan (W2a) — tool-family → phase mapping, mirrored from the
	// server's derivePlanSteps so the client can advance the checklist.
	// NOTE: mirrored in copilot/grouping.ts (phaseForMessage) for the
	// phase-grouped transcript render — keep both in sync when adding tools.
	// -----------------------------------------------------------------------

	const PLAN_PHASE_BY_TOOL: Record<string, string> = {
		"process-submission": "execute-notebook",
		"process-all": "execute-notebook",
		"pre-evaluate": "pre-evaluate",
		"pre-evaluate-all": "pre-evaluate",
		"draft-notes": "pre-evaluate",
		"set-rubric-item": "apply-grading-changes",
		"save-grading": "apply-grading-changes",
		"update-grade-dimension": "apply-grading-changes",
		"write-notes": "apply-grading-changes",
		"run-plagiarism-check": "plagiarism-check",
		"analyze-code": "analyze-code",
		"compare-to-key": "compare-to-key",
		"search-docs": "check-library-docs",
	};
	const PLAN_FALLBACK_PHASE_ID = "gather-context";

	/** Advance the plan checklist for one tool call (in_progress) or result (completed/error). */
	function advancePlan(tool: string, status: "in_progress" | "completed" | "error"): void {
		if (planSteps.length === 0) return;
		const phaseId = PLAN_PHASE_BY_TOOL[tool] ?? PLAN_FALLBACK_PHASE_ID;
		const step = planSteps.find((s) => s.id === phaseId);
		if (!step) return;
		// Never regress a completed/error step back to in_progress (a second
		// tool call in the same phase keeps the phase in_progress only if it
		// was pending).
		if (status === "in_progress" && (step.status === "completed" || step.status === "error")) {
			return;
		}
		planSteps = planSteps.map((s) => (s.id === phaseId ? { ...s, status } : s));
	}

	/** Reset the harness surface for a new turn. */
	function resetHarness(): void {
		planSteps = [];
		changes = [];
		checkpoint = null;
		queuedMessages = [];
		stopRequested = false;
	}

	// -----------------------------------------------------------------------
	// Steering (W3b) — queue / steer-at-boundary / stop
	// -----------------------------------------------------------------------

	/**
	 * Queue a message while the agent is streaming. The queued messages send
	 * in order when the current run ends (see sendMessage's drain loop).
	 * Returns false when the store is not streaming (callers should send
	 * directly instead).
	 */
	function queueMessage(text: string): boolean {
		const trimmed = text.trim();
		if (!trimmed) return false;
		if (!isStreaming) return false;
		queuedMessages = [...queuedMessages, trimmed];
		return true;
	}

	/**
	 * Steer: queue the message AND request a graceful stop at the next tool
	 * boundary. The store watches for the next tool-result, then aborts the
	 * stream; the queued message sends immediately after.
	 */
	function steerMessage(text: string): boolean {
		const trimmed = text.trim();
		if (!trimmed) return false;
		if (!isStreaming) return false;
		queuedMessages = [...queuedMessages, trimmed];
		stopRequested = true;
		return true;
	}

	/** Hard stop: abort the current stream immediately (existing controller). */
	function stopStream(): void {
		activeController?.abort();
	}

	// -----------------------------------------------------------------------
	// Change ledger (W2d) — accept/reject per change; reject reverts via the
	// same save API the teacher's Save action uses.
	// -----------------------------------------------------------------------

	/** Mark one change accepted (the write is already persisted — no-op). */
	function acceptChange(changeId: string): void {
		changes = changes.map((c) => (c.id === changeId ? { ...c, status: "accepted" } : c));
	}

	/** Mark every pending change accepted. */
	function acceptAllChanges(): void {
		changes = changes.map((c) => (c.status === "pending" ? { ...c, status: "accepted" } : c));
	}

	/**
	 * Reject one change: write the OLD value back through the same save API
	 * the teacher's Save action uses, then mark the entry rejected. Returns
	 * false when the change is not pending or the revert fails.
	 */
	async function rejectChange(changeId: string): Promise<boolean> {
		const change = changes.find((c) => c.id === changeId);
		if (!change || change.status !== "pending") return false;
		const targetId = change.submissionId || submissionId;
		if (!targetId) return false;
		try {
			const patch: GradingPatch = {};
			if (change.kind === "rubric") {
				// Revert a rubric selection: set the criterion back to the
				// old option (null/undefined → clear the selection).
				patch.rubric = { [change.field]: (change.oldValue as string) ?? "" };
			} else if (change.kind === "dimension") {
				patch.dimensions = { [change.field]: (change.oldValue as number) ?? 0 };
			} else if (change.kind === "notes") {
				patch.notes = (change.oldValue as string) ?? "";
			}
			await saveGrading(targetId, patch, assignmentId || undefined);
			changes = changes.map((c) => (c.id === changeId ? { ...c, status: "rejected" } : c));
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Revert the WHOLE current turn (P3): restore the submission's grading
	 * state to the pre-turn snapshot via the same save API the teacher's
	 * Save action uses, then clear the turn's change-ledger entries. Returns
	 * false when there is no checkpoint for the current turn, while the
	 * turn is still streaming (the checkpoint is set mid-stream — reverting
	 * then would let the agent's remaining writes land on top of the
	 * restored state), outside per-submission scope, or when the restore
	 * fails.
	 */
	async function revertTurn(): Promise<boolean> {
		if (isStreaming) return false;
		const snap = checkpoint;
		if (!snap) return false;
		const targetId = submissionId;
		if (!targetId) return false;
		try {
			const patch: GradingPatch = {};
			// Only include fields present in the snapshot (the save API
			// merges — absent fields are left untouched).
			if (snap.rubric !== undefined) patch.rubric = snap.rubric;
			if (snap.dimensions !== undefined) patch.dimensions = snap.dimensions;
			if (snap.notes !== undefined) patch.notes = snap.notes ?? "";
			if (snap.feedback !== undefined) patch.feedback = snap.feedback;
			await saveGrading(targetId, patch, assignmentId || undefined);
			// The turn's writes are undone — clear the ledger for this turn
			// (the entries' old/new values no longer describe the state).
			changes = [];
			checkpoint = null;
			return true;
		} catch {
			return false;
		}
	}

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
			case "plan": {
				const payload = (data ?? {}) as { steps?: { id?: string; label?: string }[] };
				const steps = payload.steps ?? [];
				planSteps = steps
					.filter((s) => typeof s.id === "string" && typeof s.label === "string")
					.map((s) => ({ id: s.id!, label: s.label!, status: "pending" as const }));
				break;
			}
			case "change": {
				const payload = (data ?? {}) as {
					changes?: {
						kind?: string;
						field?: string;
						oldValue?: unknown;
						newValue?: unknown;
						submissionId?: string;
					}[];
				};
				const incoming = payload.changes ?? [];
				const ledger: CopilotChange[] = incoming
					.filter(
						(c) =>
							(c.kind === "rubric" || c.kind === "dimension" || c.kind === "notes") &&
							typeof c.field === "string",
					)
					.map((c) => ({
						id: crypto.randomUUID(),
						kind: c.kind as CopilotChange["kind"],
						field: c.field!,
						oldValue: c.oldValue ?? null,
						newValue: c.newValue ?? null,
						submissionId: c.submissionId,
						status: "pending" as const,
					}));
				if (ledger.length > 0) changes = [...changes, ...ledger];
				break;
			}
			case "checkpoint": {
				// P3: the current turn's pre-write grading snapshot — drives
				// the Revert turn button in the change ledger.
				const payload = (data ?? {}) as {
					turnId?: string;
					snapshot?: {
						rubric?: Record<string, string>;
						dimensions?: Record<string, number>;
						notes?: string | null;
						feedback?: Record<string, CategoryFeedback>;
					};
				};
				const snap = payload.snapshot;
				if (typeof payload.turnId !== "string" || !snap) break;
				checkpoint = {
					turnId: payload.turnId,
					rubric: snap.rubric ?? {},
					dimensions: snap.dimensions ?? {},
					notes: snap.notes ?? null,
					feedback: snap.feedback ?? {},
				};
				break;
			}
			case "tool-call": {
				const payload = (data ?? {}) as { tool?: string; args?: unknown };
				const tool = payload.tool ?? "unknown";
				advancePlan(tool, "in_progress");
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
				if (payload.tool) advancePlan(payload.tool, ok ? "completed" : "error");
				appendMessage(
					assistantMessage(summary, "tool-result", {
						tool: payload.tool,
						ok,
						summary,
					}),
				);
				// W3b steer-at-boundary: a steer request stops the run right
				// after the current tool completes (the queued message sends
				// when the stream ends).
				if (stopRequested) {
					activeController?.abort();
				}
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
						// argsRedacted can arrive as an object from some servers —
						// formatArgs guarantees the CopilotMessage.args string
						// contract (Issue 9: "[Object object]" in approval cards).
						args: formatArgs(payload.argsRedacted),
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
		resetHarness();
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

		// W3b queue drain: run the first turn, then any messages queued while
		// it was streaming (queue/steer), in order.
		let next = content;
		do {
			await sendOneTurn(next);
			next = queuedMessages[0] ?? "";
			if (next) {
				queuedMessages = queuedMessages.slice(1);
				appendMessage({
					id: crypto.randomUUID(),
					role: "teacher",
					content: next,
					timestamp: Date.now(),
					type: next.startsWith("/") ? "command" : "text",
					kind: "text",
				});
			}
		} while (next && !isStreaming);
	}

	/** One chat turn: POST to the chat route and stream the SSE response. */
	async function sendOneTurn(content: string): Promise<void> {
		isStreaming = true;
		const controller = new AbortController();
		activeController = controller;
		resetIdle();
		hardCap = setTimeout(() => controller.abort(), STREAM_HARD_CAP_MS);
		try {
			// Ensure a thread id exists before the first turn and remember it
			// so the conversation survives reloads. The first turn also sends
			// a title derived from the first message (the server stores it
			// when creating the thread).
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

	// -----------------------------------------------------------------------
	// Thread management — server-backed list/open/new/delete/rename
	// -----------------------------------------------------------------------

	/**
	 * Scope query params shared by list/detail/delete (server enforces isolation).
	 * Returns a query STRING: `new URLSearchParams(...)` is forbidden in this
	 * file — eslint `svelte/prefer-svelte-reactivity` flags mutable built-ins
	 * that have reactive alternatives (URLSearchParams → SvelteURLSearchParams),
	 * and it is error-level. String-building avoids the rule entirely.
	 */
	function scopeParams(): string {
		return submissionId
			? `submissionId=${encodeURIComponent(submissionId)}`
			: `assignmentId=${encodeURIComponent(assignmentId)}`;
	}

	async function loadThreads(): Promise<void> {
		if (!apiMode.value) return;
		const res = await fetch(`${base}/api/copilot/threads?${scopeParams()}`);
		if (!res.ok) return;
		const body = (await res.json()) as { threads: CopilotThreadMeta[] };
		threads = body.threads;
	}

	async function openThread(threadId: string): Promise<void> {
		if (!apiMode.value) return;
		loadingHistory = true;
		try {
			const res = await fetch(
				`${base}/api/copilot/threads/${encodeURIComponent(threadId)}?${scopeParams()}`,
			);
			if (!res.ok) {
				// Thread vanished (deleted elsewhere) — drop the stored id, start fresh.
				activeThreadId = "";
				clearStoredThreadId();
				activeThread = null;
				return;
			}
			const body = (await res.json()) as { thread: CopilotThreadDetail };
			activeThreadId = threadId;
			storeThreadId(threadId);
			activeThread = {
				id: body.thread.id,
				title: body.thread.title,
				createdAt: body.thread.createdAt,
				updatedAt: body.thread.updatedAt,
				messageCount: body.thread.messages.length,
				// Context stats ride the server meta — pass them through
				// for the panel's context line + warning. Compaction stats
				// ride the same meta.
				recallLimit: body.thread.recallLimit,
				recallCovered: body.thread.recallCovered,
				droppedCount: body.thread.droppedCount,
				estimatedTokens: body.thread.estimatedTokens,
				compactionCount: body.thread.compactionCount,
				hasSummary: body.thread.hasSummary,
			};
			messages = toDisplayMessages(body.thread.messages);
			currentTextMessageId = null;
			pendingApproval = null;
		} finally {
			loadingHistory = false;
		}
	}

	function newConversation(): void {
		activeThread = null;
		activeThreadId = "";
		clearStoredThreadId();
		clearMessages();
		void loadThreads();
	}

	async function deleteThread(threadId: string): Promise<void> {
		if (!apiMode.value) return;
		const res = await fetch(
			`${base}/api/copilot/threads/${encodeURIComponent(threadId)}?${scopeParams()}`,
			{ method: "DELETE" },
		);
		if (!res.ok) return;
		threads = threads.filter((t) => t.id !== threadId);
		if (activeThreadId === threadId) newConversation();
	}

	async function renameThread(threadId: string, title: string): Promise<void> {
		const trimmed = title.trim().slice(0, 80);
		if (!apiMode.value || !trimmed) return;
		const res = await fetch(
			`${base}/api/copilot/threads/${encodeURIComponent(threadId)}?${scopeParams()}`,
			{
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ title: trimmed }),
			},
		);
		if (!res.ok) return;
		await loadThreads(); // refresh titles + ordering (updatedAt bumps)
		if (activeThreadId === threadId && activeThread) {
			activeThread = { ...activeThread, title: trimmed };
		}
	}

	async function restoreActiveThread(): Promise<void> {
		if (!apiMode.value || !activeThreadId) return;
		await openThread(activeThreadId);
	}

	/**
	 * Map thread wire messages to the transcript shape. System messages are
	 * skipped; user -> teacher bubble; assistant -> assistant bubble (reuses
	 * assistantMessage); tool -> tool-result card (the "tool" role is derived
	 * server-side for messages whose parts are only tool-invocations — mixed
	 * text+tool messages arrive as assistant).
	 */
	function toDisplayMessages(messages: CopilotThreadMessage[]): CopilotMessage[] {
		const out: CopilotMessage[] = [];
		for (const wire of messages) {
			if (wire.role === "system") continue;
			if (wire.role === "tool") {
				const ok = wire.ok === true;
				out.push(
					assistantMessage(ok ? "Tool completed" : "Tool failed", "tool-result", {
						tool: wire.toolName,
						ok,
					}),
				);
				continue;
			}
			if (wire.role === "user") {
				// Inline teacher bubble — assistantMessage hardcodes role
				// "assistant"; mirror sendMessage's construction exactly.
				out.push({
					id: crypto.randomUUID(),
					role: "teacher",
					content: wire.text ?? "",
					timestamp: Date.now(),
					type: "text",
					kind: "text",
				});
				continue;
			}
			if (wire.role === "assistant" && wire.toolName) {
				// A tool-invocation assistant turn (tool name present, usually
				// no text) is a TOOL-CALL card — never an empty text bubble
				// (Issue 10: tool calls vanished from restored history).
				out.push(
					assistantMessage(wire.text || `Tool call: ${wire.toolName}`, "tool-call", {
						tool: wire.toolName,
					}),
				);
				continue;
			}
			out.push(assistantMessage(wire.text ?? "", "text"));
		}
		return out;
	}

	/**
	 * Clear the in-memory transcript (UI-only reset). This does NOT rotate the
	 * active thread id — a later "new conversation" action generates
	 * a fresh thread id, calls clearStoredThreadId(), and resets the UI.
	 */
	function clearMessages(): void {
		messages = [];
		pendingSuggestions = [];
		pendingApproval = null;
		currentTextMessageId = null;
		resetHarness();
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
		get planSteps() {
			return planSteps;
		},
		get changes() {
			return changes;
		},
		get checkpoint() {
			return checkpoint;
		},
		/**
		 * True when the Revert turn button should be live: a checkpoint
		 * exists for the current turn AND the store is in per-submission
		 * scope (revert restores one submission's grading state — an
		 * assignment-scoped chat has no target) AND the turn is not still
		 * streaming (the checkpoint is set mid-stream; reverting then would
		 * let the agent's remaining writes land on top of the restored
		 * state).
		 */
		get canRevertTurn() {
			return checkpoint !== null && submissionId !== "" && !isStreaming;
		},
		get queuedMessages() {
			return queuedMessages;
		},
		get inputValue() {
			return inputValue;
		},
		set inputValue(v: string) {
			inputValue = v;
		},
		// Thread surface: getters are REQUIRED — without them the
		// panel's copilot.threads / copilot.activeThread / copilot.loadingHistory
		// would be undefined.
		get threads() {
			return threads;
		},
		get activeThread() {
			return activeThread;
		},
		get loadingHistory() {
			return loadingHistory;
		},
		availableCommands,
		sendMessage,
		approve,
		applySuggestion,
		dismissSuggestion,
		acceptChange,
		acceptAllChanges,
		rejectChange,
		revertTurn,
		queueMessage,
		steerMessage,
		stopStream,
		clearMessages,
		loadThreads,
		openThread,
		newConversation,
		deleteThread,
		renameThread,
		restoreActiveThread,
	};
}
