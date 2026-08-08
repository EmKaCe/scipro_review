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
 *    the hooks need the thread id. Each `streamChat` puts a `ReqState`
 *    object (settings snapshot, session, threadId, submissionId, per-call
 *    decision map) into the run's `requestContext` under `__copilot`;
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
 * 6. **Suggestions are not produced in 4a.3** (no suggestion tools exist
 *    yet); the union includes `suggestion`/`message.suggestion` for 4c/4e.
 *
 * Environment:
 *   KI_CONNECT_API_KEY — API key for the LLM provider (env-only, never in
 *   data/settings.yaml). Optional in tests — the model is mocked.
 *
 * This module runs only on the SvelteKit server (`$lib/server/`).
 */

import { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core";
import { InMemoryStore } from "@mastra/core/storage";
import { Tool, type ToolHooks } from "@mastra/core/tools";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

import { appendAuditEntry, createAuditHooks, redactArgs } from "./audit";
import { resolveApprovalPolicy, type ApprovalDecision } from "./permission";
import { registerCopilotTools } from "./tools/index";
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
			suggestion?: {
				suggestionId: string;
				kind: SuggestionKind;
				title: string;
				body: string;
				actionLabel: string;
			};
	  }
	| {
			type: "suggestion";
			suggestionId: string;
			kind: SuggestionKind;
			title: string;
			body: string;
			actionLabel: string;
	  }
	| { type: "error"; message: string }
	| { type: "done" };

/** Mutable per-session allowance counter (caller-owned, thread-scoped). */
export interface CopilotSession {
	autoApprovedCount: number;
}

export interface StreamChatInput {
	/** Submission the conversation is about (forwarded to tool contexts). */
	submissionId: string;
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
	submissionId: string;
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
	mastra = new Mastra({ storage: new InMemoryStore() });
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
	});
}

async function getAgent(): Promise<Agent> {
	await buildAgent();
	if (!agent) throw new Error("buildAgent() did not initialize the copilot agent");
	return agent;
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
				signal: context.abortSignal ?? new AbortController().signal,
			};
			// The registry re-validates args against the Zod inputSchema, so
			// invalid args surface as tool errors (CopilotToolArgumentError).
			return registry.run(tool.name, input, toolContext);
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
	const reqState: ReqState = {
		settings: appSettings.copilot,
		session: input.session,
		threadId: input.threadId,
		submissionId: input.submissionId,
		decisions: new Map(),
	};
	const requestContext = new Map<string, unknown>();
	requestContext.set(COPILOT_CTX_KEY, reqState);

	let current: Awaited<ReturnType<Agent["stream"]>>;
	try {
		const opts: Record<string, unknown> = {
			requestContext,
			maxSteps: MAX_STEPS,
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
						const errMsg = toolResultError(chunk.payload.result);
						const ok = chunk.payload.isError !== true && errMsg === undefined;
						yield {
							type: "tool-result",
							tool: chunk.payload.toolName,
							ok,
							summary: ok
								? summarizeToolResult(chunk.payload.result)
								: (errMsg ?? "Tool call failed"),
						};
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
