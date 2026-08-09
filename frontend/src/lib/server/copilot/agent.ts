/**
 * @file Copilot agent loop — the heart of the copilot.
 *
 * Exposes a uniform async-iterable event stream (CopilotStreamEvent) so the
 * SSE route stays a dumb pipe, and internally runs the native Mastra agent
 * loop (spike verdict 4a.1: `@mastra/core/agent` Agent + `@ai-sdk/openai-compatible`
 * provider, KI Connect SSE streaming + native tool calling).
 *
 * Design decisions:
 *
 * 1. **One singleton agent.** `buildAgent()` wires the Mastra Agent once
 *    (registry tools + approval policy + audit hooks + model). `streamChat`
 *    and `approveRun` build lazily. Rebuilding is not automatic — restart the
 *    server (or call `__resetAgentForTests` in tests) after registering new
 *    tools. Approval *policy* settings are re-read from `data/settings.yaml`
 *    on every `streamChat` call, so saved policy changes (mode, deny list,
 *    TTL, session cap) take effect immediately without a rebuild. The LLM
 *    model/base URL are fixed at build time.
 *
 * 2. **Per-request state rides Mastra's requestContext.** The tool
 *    `requireApproval` functions and the audit ToolHooks are static
 *    (agent-level), but the policy needs the *current* settings + session and
 *    hooks need the thread id. Each `streamChat` puts a `ReqState`
 *    object (settings snapshot, session, threadId, submissionId,
 *    assignmentId, per-call decision map) into the run's `requestContext`
 *    `requireApproval`/hooks/tool-execute all read it back. Concurrent runs
 *    are isolated because each run carries its own requestContext.
 *
 * 3. **Approval suspension.** A tool whose per-call `requireApproval`
 *    resolves to a non-auto decision suspends the run: Mastra emits a
 *    `tool-call-approval` chunk and the stream ends with
 *    `finishReason === "suspended"`. We surface an `approval-request` event
 *    and WAIT on a deferred promise until `approveRun` resolves it (or the
 *    TTL expires). `approve` → `agent.approveToolCall`, `deny` →
 *    `agent.declineToolCall`, then we keep iterating the returned
 *    continuation stream. Resuming requires storage, so the agent runs on a
 *    Mastra instance with an in-memory store (live-session scope).
 *
 * 4. **TTL expiry = deny.** Pending approvals auto-deny after
 *    `copilot.approval_ttl_seconds` (default 60s). Expiry is surfaced as a
 *    `tool-result` event with `ok: false` and a summary naming the expiry
 *    (not an `error` event — the stream continues normally after a deny, and
 *    an error event reads as terminal to consumers). The model is told the
 *    call was declined, exactly like a human deny.
 *
 * 5. **Session counter is caller-owned and thread-scoped.** `streamChat`
 *    never creates a session; the caller (SSE route) passes one object per
 *    thread and the allowlist budget in `resolveApprovalPolicy` mutates
 *    `session.autoApprovedCount` across requests of that thread. Passing no
 *    session disables allowlist auto-approval (falls back to always asking).
 *
 * 6. **Suggestions ride a tool-result marker (4e).** A tool can wrap its
 *    run result in `suggestionResult({ kind, title, body, actionLabel,
 *    data })` (the `__suggestion` marker). The tool-result mapping detects
 *    the marker, emits a `suggestion` event AFTER the `tool-result` event,
 *    and unwraps the marker IN PLACE so the model receives the raw tool
 *    result (e.g. the pre-evaluation envelope) on the next step — never the
 *    marker envelope. `suggestionId` is generated here (the tool does not
 *    see it); the marker's `data` field carries the structured apply
 *    payload the page uses when the teacher clicks the suggestion action.
 *
 * Environment:
 *   KI_CONNECT_API_KEY — API key for the LLM provider (env-only, never in
 *   data/settings.yaml). Optional in tests — the model is mocked.
 *
 * This module runs only on the SvelteKit server (`$lib/server/`).
 */

import { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core";
import { InMemoryStore, MastraCompositeStore } from "@mastra/core/storage";
import { Memory } from "@mastra/memory";

import { FileMemoryStore } from "./file-memory";
import { Tool, type ToolHooks } from "@mastra/core/tools";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

import { appendAuditEntry, createAuditHooks, redactArgs } from "./audit";
import { resolveApprovalPolicy, type ApprovalDecision } from "./permission";
import { registerCopilotTools } from "./tools/index";
import { getEnabledAssignments } from "$lib/server/assignments";
import { readMetadata } from "$lib/server/metadata";
import {
	createRegistry,
	type CopilotRegistry,
	type CopilotTool,
	type ToolContext,
} from "./registry";
import { loadSettings, type AppSettings, type CopilotSettings } from "../settings";

// ---------------------------------------------------------------------------
// Event union (the uniform contract — do not change)
// ---------------------------------------------------------------------------

export type SuggestionKind = "grade" | "draft" | "fix" | "export";

/** Suggestion payload carried by the `suggestion` event / `message.suggestion`. */
export interface SuggestionPayload {
	kind: SuggestionKind;
	title: string;
	body: string;
	actionLabel: string;
	/** Structured apply data the page forwards when the teacher applies the suggestion. */
	data?: unknown;
}

/** Suggestion event payload (suggestionId is generated by the agent loop). */
export type CopilotSuggestionEvent = SuggestionPayload & { suggestionId: string };

/**
 * Marker key wrapping a suggestion inside a tool result. Tools build it with
 * {@link suggestionResult} — never stringify the key by hand.
 */
export const SUGGESTION_MARKER = "__suggestion";

/** A tool run result carrying a suggestion: an object with a single marker key. */
export type SuggestionResult = { [SUGGESTION_MARKER]: SuggestionPayload };

/**
 * Build a suggestion-marked tool result. The tool-result mapping emits a
 * `suggestion` event for it and unwraps the marker so the LLM sees the RAW
 * result — put the real tool result in `data` (e.g. the pre-evaluation
 * envelope).
 */
export function suggestionResult(payload: SuggestionPayload): SuggestionResult {
	return { [SUGGESTION_MARKER]: payload };
}

/**
 * Detect the suggestion marker on a tool result and UNWRAP it in place.
 * Returns the payload when `value` is a suggestion result (the marker is
 * deleted and the payload's `data` — the raw tool result — is copied onto
 * the same object, so the model and the tool-result summary see the RAW
 * value), undefined otherwise (normal results pass through untouched).
 */
export function unwrapSuggestionResult(value: unknown): SuggestionPayload | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (!(SUGGESTION_MARKER in record)) return undefined;
	const payload = record[SUGGESTION_MARKER];
	if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
		return undefined;
	}
	const suggestion = payload as SuggestionPayload;
	delete record[SUGGESTION_MARKER];
	const data = suggestion.data;
	if (data !== null && typeof data === "object" && !Array.isArray(data)) {
		Object.assign(record, data);
	}
	return suggestion;
}

export type CopilotStreamEvent =
	| { type: "thinking" }
	| { type: "tool-call"; tool: string; args: unknown }
	| { type: "tool-result"; tool: string; ok: boolean; summary?: string }
	| {
			type: "approval-request";
			runId: string;
			toolCallId: string;
			tool: string;
			argsRedacted: unknown;
			decision: "ask" | "blocked";
	  }
	| { type: "message-delta"; text: string }
	| {
			type: "message";
			role: "assistant";
			content: string;
			suggestion?: CopilotSuggestionEvent;
	  }
	| (CopilotSuggestionEvent & { type: "suggestion" })
	| { type: "error"; message: string }
	| { type: "done" };

/** Mutable per-session allowance counter (caller-owned, thread-scoped). */
export interface CopilotSession {
	autoApprovedCount: number;
}

export interface StreamChatInput {
	/**
	 * Submission the conversation is about (forwarded to tool contexts).
	 * Optional — an assignment-scoped turn omits it; the agent's context
	 * tools then fall back to the assignment scope.
	 */
	submissionId?: string;
	/**
	 * Assignment the conversation is about (assignment-scoped chat from the
	 * submissions dashboard — no per-submission context).
	 */
	assignmentId?: string;
	/** The teacher's message. */
	message: string;
	/** Conversation/thread id, for audit correlation. */
	threadId?: string;
	/** Abort signal — aborts the run and ends the stream cleanly. */
	signal?: AbortSignal;
	/** Per-thread session object; see design decision 5. */
	session?: CopilotSession;
}

export interface ApproveRunInput {
	runId: string;
	toolCallId: string;
	decision: "approve" | "deny";
}

// ---------------------------------------------------------------------------
// Singleton state
// ---------------------------------------------------------------------------

const MAX_STEPS = 10; // hard bound on the agentic loop (model round-trips)
const COPILOT_CTX_KEY = "__copilot";
const AGENT_INSTRUCTIONS = [
	"You are the SciPro Review Copilot, an assistant that helps teachers review and grade",
	"Jupyter notebook submissions.",
	"",
	"Use the provided tools to inspect submissions, run notebooks, and prepare evaluations.",
	"Never fabricate tool results: if a tool fails or returns nothing, say so plainly and ask",
	"for clarification instead of inventing data.",
].join(" ");

let agent: Agent | undefined;
let mastra: Mastra | undefined;

/**
 * The copilot's tool registry (singleton). Tools are registered once at server
 * startup — agent.ts wires the grading tools in later phases; for now the
 * registry may be empty.
 */
export const registry: CopilotRegistry = createRegistry();

/** Per-request context carried through Mastra's requestContext. */
interface ReqState {
	settings: CopilotSettings;
	session?: CopilotSession;
	threadId?: string;
	submissionId?: string;
	assignmentId?: string;
	/** Policy decision per tool call, computed by requireApproval. */
	decisions: Map<string, ApprovalDecision>;
}

interface PendingApproval {
	toolCallId: string;
	tool: string;
	args: unknown;
	threadId?: string;
	decision: "ask" | "blocked";
	/** Resolve the waiting streamChat generator with the human decision. */
	resolve: (decision: "approve" | "deny") => void;
}

/** Live approvals waiting on a human decision, keyed by runId. */
const pendingApprovals = new Map<string, PendingApproval>();

// ---------------------------------------------------------------------------
// Agent construction
// ---------------------------------------------------------------------------

/**
 * One-time init of the singleton Mastra Agent: registry tools + approval
 * policy + audit hooks + LLM model. Idempotent — subsequent calls no-op.
 */
export async function buildAgent(): Promise<void> {
	if (agent) return;
	const settings = await loadSettings();
	// Register the full tool surface (context / reference / analysis) before
	// the Agent is constructed — registry.list() feeds the Mastra tools.
	registerCopilotTools(registry);
	const storage = copilotStorage();
	// The Memory must be REGISTERED on the Mastra instance (docs pattern:
	// `new Mastra({ storage, memory: { key } })`) for the agent's
	// getMemory() to resolve it — an Agent-only instance is ignored at
	// runtime and threads never persist.
	const memory = new Memory({ storage });
	mastra = new Mastra({ storage, memory: { copilot: memory } });
	const tools = Object.fromEntries(
		registry.list().map((tool) => [tool.name, wrapCopilotTool(tool)]),
	);
	agent = new Agent({
		mastra,
		id: "copilot",
		name: "SciPro Review Copilot",
		instructions: AGENT_INSTRUCTIONS,
		model: createModel(settings),
		tools,
		hooks: auditHooks,
		memory,
	});
}

/**
 * Composite storage for the copilot: in-memory defaults for every non-memory
 * domain (matching the pre-4f behavior) plus the file-backed memory domain.
 */
function copilotStorage(): MastraCompositeStore {
	return new MastraCompositeStore({
		id: "copilot",
		default: new InMemoryStore(),
		domains: { memory: new FileMemoryStore() },
	});
}

async function getAgent(): Promise<Agent> {
	await buildAgent();
	if (!agent) throw new Error("buildAgent() did not initialize the copilot agent");
	return agent;
}

/**
 * Find which enabled assignment owns a submission id (used to ground
 * per-submission chats that don't send an assignmentId). Returns undefined
 * when the submission is unknown or no assignment is enabled.
 */
async function resolveAssignmentForSubmission(submissionId: string): Promise<string | undefined> {
	try {
		for (const assignment of await getEnabledAssignments()) {
			const records = await readMetadata(assignment.id);
			if (records[submissionId]) return assignment.id;
		}
	} catch {
		// Metadata read failures (missing assignment dir) fall through —
		// tools without grounding will surface their own errors.
	}
	return undefined;
}

/**
 * @internal Test-only: drop the singleton so buildAgent() rebuilds with the
 * current registry/tools. Not part of the public contract.
 */
export function __resetAgentForTests(): void {
	agent = undefined;
	mastra = undefined;
	pendingApprovals.clear();
}

function createModel(settings: AppSettings) {
	const provider = createOpenAICompatible({
		name: "ki-connect",
		baseURL: settings.llm.baseUrl,
		apiKey: process.env.KI_CONNECT_API_KEY,
	});
	return provider.chatModel(settings.llm.model);
}

/** Wrap one registry tool as a Mastra tool. */
function wrapCopilotTool(tool: CopilotTool): Tool {
	return new Tool({
		id: tool.name,
		description: tool.description,
		inputSchema: tool.inputSchema,
		// Evaluated per call with the current settings + session. "blocked" and
		// "ask" both suspend for the human; the difference is carried in the
		// emitted approval-request decision field.
		requireApproval: (input, ctx) => {
			const reqState = readReqState(ctx?.requestContext);
			if (!reqState) return true; // no run context — fail safe, ask
			const resolver = resolveApprovalPolicy(tool, {
				settings: reqState.settings,
				session: reqState.session,
			});
			const decision = resolver(input);
			reqState.decisions.set(tool.name, decision);
			return decision !== "auto";
		},
		execute: async (input, context) => {
			const reqState = readReqState(context.requestContext);
			const toolContext: ToolContext = {
				submissionId: reqState?.submissionId,
				assignmentId: reqState?.assignmentId,
				signal: context.abortSignal ?? new AbortController().signal,
			};
			// Grounding: the review context WINS over whatever ids the model
			// hallucinated in the args. The LLM is told to omit these fields,
			// but it invents bogus values (observed: "test_submission_001")
			// — without this the copilot could write to the wrong submission
			// or fail on every write. The teacher approves the REAL target.
			const groundedArgs: Record<string, unknown> = { ...(input as Record<string, unknown>) };
			if (reqState?.submissionId) groundedArgs.submissionId = reqState.submissionId;
			if (reqState?.assignmentId) groundedArgs.assignmentId = reqState.assignmentId;
			// The registry re-validates args against the Zod inputSchema, so
			// invalid args surface as tool errors (CopilotToolArgumentError).
			return registry.run(tool.name, groundedArgs, toolContext);
		},
	});
}

/** Agent-level audit hooks; per-request data comes from the requestContext. */
const auditHooks: ToolHooks = {
	beforeToolCall: async ({ toolName, input, context }) => {
		const reqState = readReqState((context as { requestContext?: unknown }).requestContext);
		if (!reqState) return;
		const decision = reqState.decisions.get(toolName) ?? "auto";
		await createAuditHooks(reqState.threadId).beforeToolCall({
			tool: toolName,
			args: input,
			permission: decision === "auto" ? "auto" : "approval",
			decision: decision === "auto" ? "auto" : "approved",
		});
	},
	afterToolCall: async ({ toolName, input, error, context }) => {
		const reqState = readReqState((context as { requestContext?: unknown }).requestContext);
		if (!reqState) return;
		const decision = reqState.decisions.get(toolName) ?? "auto";
		await createAuditHooks(reqState.threadId).afterToolCall({
			tool: toolName,
			args: input,
			permission: decision === "auto" ? "auto" : "approval",
			decision: decision === "auto" ? "auto" : "approved",
			ok: !error,
		});
	},
};

// ---------------------------------------------------------------------------
// streamChat
// ---------------------------------------------------------------------------

/**
 * Run one chat turn against the agent and stream uniform events. The returned
 * async iterable is the ONLY way the caller consumes the run: it stays alive
 * across approval suspensions (see approveRun) until 'done'.
 */
export async function streamChat(
	input: StreamChatInput,
): Promise<AsyncIterable<CopilotStreamEvent>> {
	await getAgent();
	return runChat(input);
}

async function* runChat(input: StreamChatInput): AsyncGenerator<CopilotStreamEvent> {
	// Policy settings are re-read per request so saved changes apply immediately.
	const appSettings = await loadSettings();
	// Per-submission chats don't send assignmentId — derive it so tools are
	// grounded (the model invents bogus assignment ids otherwise).
	const resolvedAssignmentId =
		input.assignmentId ??
		(input.submissionId ? await resolveAssignmentForSubmission(input.submissionId) : undefined);
	const reqState: ReqState = {
		settings: appSettings.copilot,
		session: input.session,
		threadId: input.threadId,
		submissionId: input.submissionId,
		assignmentId: resolvedAssignmentId,
		decisions: new Map(),
	};
	const requestContext = new Map<string, unknown>();
	requestContext.set(COPILOT_CTX_KEY, reqState);

	let current: Awaited<ReturnType<Agent["stream"]>>;
	try {
		const opts: Record<string, unknown> = {
			requestContext,
			maxSteps: MAX_STEPS,
			// Required when memory is wired: Mastra throws
			// AGENT_MEMORY_MISSING_RESOURCE_ID without a resourceId. The
			// submission scopes the resource; an assignment-scoped turn
			// falls back to the assignment id (or a shared fallback when
			// neither id is present, e.g. direct agent tests).
			resourceId: input.submissionId ?? input.assignmentId ?? "copilot",
			// Without savePerStep Mastra never calls the memory storage —
			// thread/message persistence is gated on this flag (verified live).
			savePerStep: true,
		};
		if (input.threadId) opts.threadId = input.threadId;
		if (input.signal) opts.abortSignal = input.signal;
		current = await (
			agent!.stream as unknown as (
				messages: string,
				options: Record<string, unknown>,
			) => Promise<Awaited<ReturnType<Agent["stream"]>>>
		)(input.message, opts);
	} catch (err) {
		if (!input.signal?.aborted) {
			yield { type: "error", message: errorMessage(err) };
			yield { type: "done" };
		}
		return;
	}

	const aborted = () => input.signal?.aborted === true;
	let text = "";

	outer: while (true) {
		if (aborted()) return;
		try {
			for await (const chunk of current.fullStream) {
				if (aborted()) return;
				switch (chunk.type) {
					case "step-start":
						yield { type: "thinking" };
						break;
					case "text-delta": {
						const delta = chunk.payload.text;
						text += delta;
						yield { type: "message-delta", text: delta };
						break;
					}
					case "tool-call":
						yield {
							type: "tool-call",
							tool: chunk.payload.toolName,
							args: chunk.payload.args as unknown,
						};
						break;
					case "tool-result": {
						// 4e suggestion emitter: a tool result carrying the
						// __suggestion marker triggers a suggestion event AFTER
						// the tool-result event. unwrapSuggestionResult removes
						// the marker IN PLACE (and surfaces the payload's
						// `data` — the raw tool result — on the same object),
						// so the model receives the RAW result on the next
						// step and the tool-result summary reflects it.
						const result = chunk.payload.result;
						const suggestion = unwrapSuggestionResult(result);
						const errMsg = toolResultError(result);
						const ok = chunk.payload.isError !== true && errMsg === undefined;
						if (ok) {
							yield {
								type: "tool-result",
								tool: chunk.payload.toolName,
								ok: true,
								summary: summarizeToolResult(result),
							};
						} else {
							yield {
								type: "tool-result",
								tool: chunk.payload.toolName,
								ok: false,
								summary: errMsg ?? "Tool call failed",
							};
						}
						if (suggestion !== undefined) {
							yield {
								type: "suggestion",
								suggestionId: crypto.randomUUID(),
								kind: suggestion.kind,
								title: suggestion.title,
								body: suggestion.body,
								actionLabel: suggestion.actionLabel,
								data: suggestion.data,
							};
						}
						break;
					}
					case "tool-error":
						yield {
							type: "tool-result",
							tool: chunk.payload.toolName,
							ok: false,
							summary: errorMessage(chunk.payload.error),
						};
						break;
					case "tool-call-approval": {
						const payload = chunk.payload;
						const runId = chunk.runId ?? current.runId;
						const recorded = reqState.decisions.get(payload.toolName) ?? "ask";
						const decision: "ask" | "blocked" =
							recorded === "blocked" ? "blocked" : "ask";
						// Register the pending approval BEFORE yielding the event:
						// waitForApproval's promise executor runs synchronously, so a
						// consumer that answers the approval-request event right away
						// (approveRun) finds the entry in pendingApprovals.
						const approval = waitForApproval({
							runId,
							toolCallId: payload.toolCallId,
							tool: payload.toolName,
							args: payload.args,
							reqState,
							decision,
							signal: input.signal,
						});
						yield {
							type: "approval-request",
							runId,
							toolCallId: payload.toolCallId,
							tool: payload.toolName,
							argsRedacted: parseRedactedArgs(payload.args),
							decision,
						};
						if (aborted()) return;
						const outcome = await approval;
						if (aborted()) return;
						if (outcome.type === "ttl") {
							// TTL expiry surfaces as a denied tool result (see header, decision 4).
							yield {
								type: "tool-result",
								tool: payload.toolName,
								ok: false,
								summary: outcome.message,
							};
						}
						// A blocked call behaves as denied even when "approved".
						const effective =
							outcome.type === "human" &&
							outcome.decision === "approve" &&
							decision === "ask"
								? "approve"
								: "deny";
						if (effective === "deny") {
							await appendAuditEntry({
								ts: new Date().toISOString(),
								threadId: reqState.threadId,
								tool: payload.toolName,
								permission: "approval",
								argsRedacted: redactArgs(payload.args),
								decision: "denied",
								ok: false,
							});
						}
						current =
							effective === "approve"
								? await agent!.approveToolCall({
										runId,
										toolCallId: payload.toolCallId,
									})
								: await agent!.declineToolCall({
										runId,
										toolCallId: payload.toolCallId,
									});
						continue outer;
					}
					case "error":
						yield { type: "error", message: errorMessage(chunk.payload.error) };
						break;
					case "abort":
						return; // upstream abort — stop cleanly, no 'done'
					default:
						break; // start / finish / raw / reasoning-* / step-finish / ... — noise
				}
			}
		} catch (err) {
			if (aborted()) return;
			yield { type: "error", message: errorMessage(err) };
		}
		break;
	}

	if (text.trim().length > 0) {
		yield { type: "message", role: "assistant", content: text };
	}
	yield { type: "done" };
}

// ---------------------------------------------------------------------------
// approveRun
// ---------------------------------------------------------------------------

/**
 * Resolve a pending approval. The events of the suspended run continue on the
 * ORIGINAL streamChat stream; the returned iterable is empty on success (the
 * approval itself produced no events) and carries an error + done when no
 * matching pending approval exists.
 */
export async function approveRun(
	input: ApproveRunInput,
): Promise<AsyncIterable<CopilotStreamEvent>> {
	const pending = pendingApprovals.get(input.runId);
	if (!pending || pending.toolCallId !== input.toolCallId) {
		return errorStream(
			`No pending approval found for run "${input.runId}" and tool call "${input.toolCallId}"`,
		);
	}
	pending.resolve(input.decision);
	return emptyStream();
}

// ---------------------------------------------------------------------------
// Approval waiting / TTL
// ---------------------------------------------------------------------------

type ApprovalOutcome =
	{ type: "human"; decision: "approve" | "deny" } | { type: "ttl"; message: string };

function waitForApproval(opts: {
	runId: string;
	toolCallId: string;
	tool: string;
	args: unknown;
	reqState: ReqState;
	decision: "ask" | "blocked";
	signal?: AbortSignal;
}): Promise<ApprovalOutcome> {
	const ttlMs = opts.reqState.settings.approvalTtlSeconds * 1000;
	return new Promise((resolve) => {
		let settled = false;
		const finish = (outcome: ApprovalOutcome) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			opts.signal?.removeEventListener("abort", onAbort);
			pendingApprovals.delete(opts.runId);
			resolve(outcome);
		};
		const onAbort = () =>
			finish({ type: "ttl", message: "Approval request aborted — call denied" });
		opts.signal?.addEventListener("abort", onAbort, { once: true });
		const timer = setTimeout(
			() =>
				finish({
					type: "ttl",
					message: `Approval for tool "${opts.tool}" expired after ${ttlMs / 1000}s — call denied`,
				}),
			ttlMs,
		);
		pendingApprovals.set(opts.runId, {
			toolCallId: opts.toolCallId,
			tool: opts.tool,
			args: opts.args,
			threadId: opts.reqState.threadId,
			decision: opts.decision,
			resolve: (decision) => finish({ type: "human", decision }),
		});
	});
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read the per-request ReqState out of a requestContext (Map or plain object). */
function readReqState(rc: unknown): ReqState | undefined {
	if (!rc || typeof rc !== "object") return undefined;
	const asRecord = rc as Record<string, unknown>;
	const value =
		typeof asRecord.get === "function"
			? (asRecord as { get: (key: string) => unknown }).get(COPILOT_CTX_KEY)
			: asRecord[COPILOT_CTX_KEY];
	return value as ReqState | undefined;
}

/** Redact args for the approval card; falls back to the raw redaction string. */
function parseRedactedArgs(args: unknown): unknown {
	const redacted = redactArgs(args ?? {});
	try {
		return JSON.parse(redacted) as unknown;
	} catch {
		return redacted;
	}
}

/** Short JSON summary of a tool result (truncated), or undefined when empty. */
function summarizeToolResult(result: unknown): string | undefined {
	if (result === undefined || result === null) return undefined;
	let json: string;
	try {
		json = JSON.stringify(result);
	} catch {
		json = String(result);
	}
	if (json.length > 200) json = `${json.slice(0, 200)}…`;
	return json;
}

/**
 * ai-sdk wraps failed tool calls in result envelopes even when the stream part
 * reports isError false (observed live: input-validation failures arrive as
 * { error: true, message: "Tool input validation failed…" }). Detect both the
 * validation envelope and the plain execution envelope { error: "…" }.
 */
function toolResultError(result: unknown): string | undefined {
	if (result === null || typeof result !== "object" || Array.isArray(result)) return undefined;
	const r = result as Record<string, unknown>;
	if (r.error === true && typeof r.message === "string" && r.message.length > 0) {
		return r.message;
	}
	if (typeof r.error === "string" && r.error.length > 0 && Object.keys(r).length === 1) {
		return r.error;
	}
	return undefined;
}

/** Best-effort human-readable message from an unknown error value. */
function errorMessage(err: unknown): string {
	if (err instanceof Error && err.message) return err.message;
	if (err && typeof err === "object") {
		const msg = (err as { message?: unknown }).message;
		if (typeof msg === "string" && msg) return msg;
		const cause = (err as { cause?: unknown }).cause;
		if (cause instanceof Error && cause.message) return cause.message;
		if (cause && typeof cause === "object") {
			const causeMsg = (cause as { message?: unknown }).message;
			if (typeof causeMsg === "string" && causeMsg) return causeMsg;
		}
	}
	if (typeof err === "string") return err;
	try {
		return JSON.stringify(err);
	} catch {
		return String(err);
	}
}

async function* emptyStream(): AsyncGenerator<CopilotStreamEvent> {
	// no events
}

async function* errorStream(message: string): AsyncGenerator<CopilotStreamEvent> {
	yield { type: "error", message };
	yield { type: "done" };
}
