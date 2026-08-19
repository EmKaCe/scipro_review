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
import { PromptInjectionDetector, PIIDetector } from "@mastra/core/processors";
import { Memory } from "@mastra/memory";

import { FileMemoryStore } from "./file-memory";
import { maybeCompactThread } from "./compaction";
import { saveCheckpoint, type GradingSnapshot } from "./checkpoint-store";
import { Tool, type ToolHooks } from "@mastra/core/tools";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

import { appendAuditEntry, createAuditHooks, redactArgs } from "./audit";
import { resolveApprovalPolicy, type ApprovalDecision } from "./permission";
import { registerCopilotTools } from "./tools/index";
import { createRubricFidelityScorer } from "./rubric-fidelity";
import { getEnabledAssignments } from "$lib/server/assignments";
import { getSubmission, readMetadata } from "$lib/server/metadata";
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

/** One step of the harness plan (W2a). The client tracks status transitions. */
export interface CopilotPlanStep {
	/** Stable slug id, e.g. "apply-grading-changes". */
	id: string;
	/** Human-readable phase label, e.g. "Apply grading changes". */
	label: string;
}

/** One grading-state change for the change ledger (W2d). */
export interface CopilotChange {
	/** What kind of grading state changed. */
	kind: "rubric" | "dimension" | "notes";
	/** Field key: criterion key, dimension id, or "notes". */
	field: string;
	/** Value before the write (null when unset). */
	oldValue: unknown;
	/** Value after the write. */
	newValue: unknown;
	/** Submission the change applies to (from the tool result). */
	submissionId?: string;
}

export type CopilotStreamEvent =
	| { type: "thinking" }
	| { type: "plan"; steps: CopilotPlanStep[] }
	| { type: "change"; changes: CopilotChange[] }
	| {
			type: "checkpoint";
			/** Id of the turn this checkpoint belongs to (one per run). */
			turnId: string;
			/** The submission's grading state BEFORE the turn's first grading write. */
			snapshot: GradingSnapshot;
	  }
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

// ---------------------------------------------------------------------------
// Harness plan (W2a) — derived, not LLM-generated
// ---------------------------------------------------------------------------

/**
 * Tool-family → phase mapping for the harness plan. The plan is DERIVED from
 * the tool surface (v1): each known tool family maps to one phase label, and
 * the plan is emitted once at stream start with every step pending. The
 * client derives in_progress/completed from the tool-call events as they
 * flow — the server only emits the initial plan.
 */
const PLAN_PHASES: ReadonlyArray<{ id: string; label: string; tools: readonly string[] }> = [
	{
		id: "execute-notebook",
		label: "Execute notebook",
		tools: ["process-submission", "process-all"],
	},
	{
		id: "pre-evaluate",
		label: "Pre-evaluate",
		tools: ["pre-evaluate", "pre-evaluate-all", "draft-notes"],
	},
	{
		id: "apply-grading-changes",
		label: "Apply grading changes",
		tools: ["set-rubric-item", "save-grading", "update-grade-dimension", "write-notes"],
	},
	{
		id: "plagiarism-check",
		label: "Plagiarism check",
		tools: ["run-plagiarism-check"],
	},
	{
		id: "analyze-code",
		label: "Analyze code",
		tools: ["analyze-code"],
	},
	{
		id: "compare-to-key",
		label: "Compare to reference key",
		tools: ["compare-to-key"],
	},
	{
		id: "check-library-docs",
		label: "Check library docs",
		tools: ["search-docs"],
	},
];

/** Fallback phase for tools not in any known family. */
const PLAN_FALLBACK_PHASE = { id: "gather-context", label: "Gather context" } as const;

/**
 * Extract change-ledger entries from a grading write tool's result (W2d).
 * The grading tools return `previous` alongside the new value; this maps
 * that pair to the structured change list the client renders as the
 * accept/reject ledger. Returns [] for non-grading tools or results
 * without `previous` (older server / other tools) — the ledger is purely
 * additive and never blocks the stream.
 */
export function extractChangesFromToolResult(
	toolName: string,
	result: unknown,
): CopilotChange[] {
	if (result === null || typeof result !== "object" || Array.isArray(result)) return [];
	const r = result as Record<string, unknown>;
	const submissionId = typeof r.submissionId === "string" ? r.submissionId : undefined;

	if (toolName === "set-rubric-item") {
		const item = r.rubricItem as { criterionKey?: string; optionKey?: string } | undefined;
		if (!item?.criterionKey || typeof item.optionKey !== "string") return [];
		return [
			{
				kind: "rubric",
				field: item.criterionKey,
				oldValue: r.previous ?? null,
				newValue: item.optionKey,
				submissionId,
			},
		];
	}
	if (toolName === "update-grade-dimension") {
		const dim = r.dimension as { dimensionId?: string; value?: number } | undefined;
		if (!dim?.dimensionId || typeof dim.value !== "number") return [];
		return [
			{
				kind: "dimension",
				field: dim.dimensionId,
				oldValue: r.previous ?? null,
				newValue: dim.value,
				submissionId,
			},
		];
	}
	if (toolName === "write-notes") {
		if (typeof r.notes !== "string") return [];
		return [
			{
				kind: "notes",
				field: "notes",
				oldValue: r.previous ?? null,
				newValue: r.notes,
				submissionId,
			},
		];
	}
	if (toolName === "save-grading") {
		// save-grading returns `previous` as a map of field -> pre-write value
		// (only for the fields actually persisted) plus the new values in the
		// grading summary (rubric/dimensions/notes).
		const previous = (r.previous ?? {}) as Record<string, unknown>;
		const changes: CopilotChange[] = [];
		const rubric = (r.rubric ?? {}) as Record<string, string>;
		for (const [criterionKey, optionKey] of Object.entries(rubric)) {
			changes.push({
				kind: "rubric",
				field: criterionKey,
				oldValue: (previous.rubric as Record<string, string> | undefined)?.[criterionKey] ?? null,
				newValue: optionKey,
				submissionId,
			});
		}
		const dimensions = (r.dimensions ?? {}) as Record<string, number>;
		for (const [dimensionId, value] of Object.entries(dimensions)) {
			changes.push({
				kind: "dimension",
				field: dimensionId,
				oldValue: (previous.dimensions as Record<string, number> | undefined)?.[dimensionId] ?? null,
				newValue: value,
				submissionId,
			});
		}
		if (typeof r.notes === "string") {
			changes.push({
				kind: "notes",
				field: "notes",
				oldValue: previous.notes ?? null,
				newValue: r.notes,
				submissionId,
			});
		}
		return changes;
	}
	return [];
}

/**
 * The grading WRITE tools — the first tool-call of one of these in a turn
 * triggers the P3 turn checkpoint (snapshot the submission's grading state
 * BEFORE the write lands, so the teacher can revert the whole turn).
 */
const GRADING_WRITE_TOOLS: ReadonlySet<string> = new Set([
	"set-rubric-item",
	"update-grade-dimension",
	"write-notes",
	"save-grading",
]);

/**
 * Snapshot a submission's grading state for the P3 turn checkpoint — the
 * same fields getSubmission returns (rubric / dimensions / notes /
 * feedback). Never throws: a missing submission or absent grading state
 * yields the empty snapshot (reverting a no-op turn is a no-op), and any
 * read failure degrades the same way — a checkpoint must never break the
 * chat loop.
 */
export async function snapshotGradingState(
	assignmentId: string | undefined,
	submissionId: string | undefined,
): Promise<GradingSnapshot> {
	const empty: GradingSnapshot = { rubric: {}, dimensions: {}, notes: null, feedback: {} };
	if (!assignmentId || !submissionId) return empty;
	try {
		const record = await getSubmission(assignmentId, submissionId);
		if (!record?.grading) return empty;
		return {
			rubric: record.grading.rubric ?? {},
			dimensions: record.grading.dimensions ?? {},
			notes: record.grading.notes ?? null,
			feedback: record.grading.feedback ?? {},
		};
	} catch {
		return empty;
	}
}

/**
 * Derive the harness plan from the registered tool surface: one step per
 * known tool family that has at least one registered tool, plus the fallback
 * "Gather context" step when any registered tool is unmapped. Stable order —
 * the phase list is fixed, so the plan is deterministic for a given tool
 * surface. Exported for tests.
 */
export function derivePlanSteps(toolNames: Iterable<string>): CopilotPlanStep[] {
	const names = new Set(toolNames);
	const steps: CopilotPlanStep[] = [];
	for (const phase of PLAN_PHASES) {
		if (phase.tools.some((tool) => names.has(tool))) {
			steps.push({ id: phase.id, label: phase.label });
		}
	}
	if ([...names].some((name) => !PLAN_PHASES.some((phase) => phase.tools.includes(name)))) {
		steps.push({ id: PLAN_FALLBACK_PHASE.id, label: PLAN_FALLBACK_PHASE.label });
	}
	return steps;
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
	/**
	 * Thread title, sent on the FIRST turn of a new thread. Mastra stores it
	 * at thread creation (prepare-memory-step); existing threads keep their
	 * stored title.
	 */
	title?: string;
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

/**
 * Working-memory template for thread-scoped review state (Mastra audit §2).
 * The agent persists per-thread state (submission, status, professor
 * preferences, notes) via the auto-registered `updateWorkingMemory` tool;
 * the template is injected into the system message each turn. Exported for
 * tests. Thread-scoped only — resource scope would need 3 new storage
 * methods on FileMemoryStore (out of scope).
 */
export const WORKING_MEMORY_TEMPLATE = [
	"# Review State",
	"- Submission:",
	"- Status:",
	"- Professor preferences:",
	"- Notes:",
].join("\n");

const AGENT_INSTRUCTIONS = [
	"You are the SciPro Review Copilot, an assistant that helps teachers review and grade",
	"Jupyter notebook submissions.",
	"",
	"Use the provided tools to inspect submissions, run notebooks, and prepare evaluations.",
	"Never fabricate tool results: if a tool fails or returns nothing, say so plainly and ask",
	"for clarification instead of inventing data.",
	"",
	"Before flagging a student's API usage as wrong, call search-docs to verify the actual",
	"signature, parameters, and return values against the pinned offline library docs, and",
	"cite the docs version in your reasoning. If search-docs returns nothing, say the fact",
	"is unverified rather than guessing from memory.",
].join(" ");

/**
 * Input guardrails (Wave 3a — Mastra audit §4): student submissions are
 * untrusted content flowing into the teacher's chat, so every user turn is
 * screened BEFORE the model sees it. Both detectors run an internal detection
 * agent on the SAME KI Connect model the copilot uses (createModel(settings)).
 *
 * - PromptInjectionDetector: default threshold 0.7 (documented Mastra default —
 *   high enough to avoid false positives on legitimate grading chatter, low
 *   enough to catch real jailbreaks). Strategy "block" rejects the whole turn
 *   with a TripWire; the stream surfaces it as an `error` event (see the
 *   tripwire case in runChat) and the run ends without reaching the model.
 * - PIIDetector: categories that matter for a grading app — email, phone,
 *   name, address, iban, api-key. credit-card/ssn are deliberately NOT
 *   configured (irrelevant to notebook grading; excluding them also keeps the
 *   detection schema tight). Strategy "redact" (default) masks detected PII in
 *   place so the teacher's message still reaches the model, minus the PII.
 *
 * Both processors degrade gracefully: if the detection LLM call fails, the
 * detector logs a warning and ALLOWS the content through (verified in the
 * installed @mastra/core@1.54.0 implementation) — a guardrail failure must
 * never break the chat loop.
 */
function createInputProcessors(settings: AppSettings) {
	const model = createModel(settings);
	return [
		new PromptInjectionDetector({
			model,
			// Default threshold 0.7 — documented Mastra default.
			threshold: 0.7,
			strategy: "block",
		}),
		new PIIDetector({
			model,
			// Grading-relevant categories only; credit-card/ssn excluded.
			detectionTypes: ["email", "phone", "name", "address", "iban", "api-key"],
			strategy: "redact",
			redactionMethod: "placeholder",
		}),
	];
}

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
	// Thread-scoped working memory (Mastra audit §2): the agent persists
	// per-thread review state (submission, status, professor preferences,
	// notes) via the auto-registered `updateWorkingMemory` tool, and the
	// template is injected into the system message each turn. Thread scope
	// reads/writes `metadata.workingMemory` on the thread — FileMemoryStore
	// already persists thread metadata (updateThread), so no storage changes
	// are needed. Resource scope is deliberately NOT enabled (would require
	// getResourceById/saveResource/updateResource on FileMemoryStore).
	const memory = new Memory({
		storage,
		options: {
			workingMemory: {
				enabled: true,
				scope: "thread",
				template: WORKING_MEMORY_TEMPLATE,
			},
		},
	});
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
		// Wave 3a input guardrails: every user turn is screened for prompt
		// injection and PII before the model sees it (student submissions are
		// untrusted content). Both detectors reuse the copilot's KI Connect
		// model; they degrade to allow-through on detection-LLM failure.
		inputProcessors: createInputProcessors(settings),
		// Wave 4 rubric-fidelity evals: a sampled quality signal that the
		// copilot's grading proposals match the rubric. Low rate (0.1) so it
		// is cheap; the judge reuses the copilot's KI Connect model.
		scorers: {
			rubricFidelity: {
				scorer: createRubricFidelityScorer(createModel(settings)),
				sampling: { type: "ratio", rate: 0.1 },
			},
		},
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
	// The submission scopes the memory resource; an assignment-scoped turn
	// falls back to the assignment id (or a shared fallback when neither id
	// is present, e.g. direct agent tests).
	const resourceId = input.submissionId ?? input.assignmentId ?? "copilot";
	// The client owns a threadId when it has one (copilot-store A.2);
	// otherwise the server generates one so persistence always has a thread.
	const effectiveThreadId = input.threadId ?? crypto.randomUUID();
	// P3 turn checkpoints: one turnId per run, emitted with the checkpoint
	// event so the client can correlate the snapshot with the turn's
	// change-ledger entries (and revert the whole turn with one button).
	const turnId = crypto.randomUUID();
	const requestContext = new Map<string, unknown>();
	requestContext.set(COPILOT_CTX_KEY, reqState);
	// Mastra 1.54 resolves the memory resource from the requestContext key
	// `mastra__resourceId` (or options.memory.resource) — a top-level
	// `resourceId` stream option is NOT consulted (#getAgentExecutionResourceId
	// in agent-DIReeHqN.js). Without this, prepare-memory-step silently
	// degrades to plain mode and nothing persists.
	requestContext.set("mastra__resourceId", resourceId);
	// Same asymmetry for the thread: the stream path resolves the thread from
	// options.memory.thread OR the `mastra__threadId` requestContext key
	// (passed as resolveThreadIdFromArgs' `overrideId`, which wins) — a
	// top-level `threadId` option is NOT consulted there. Both keys are
	// required for prepare-memory-step to take the memory path.
	requestContext.set("mastra__threadId", effectiveThreadId);

	// Automatic compaction: when the thread outgrows the recall
	// window, summarize the out-of-window messages with the LLM and inject
	// the summary as a system message below. Best-effort — a compaction
	// failure must never break the chat.
	let compactionSummary: string | undefined;
	try {
		const comp = await maybeCompactThread({
			threadId: effectiveThreadId,
			resourceId,
			settings: reqState.settings,
			model: createModel(appSettings),
			modelId: appSettings.llm.model,
		});
		compactionSummary = comp.compacted ? comp.summary : undefined;
	} catch {
		// compaction failure is invisible to the teacher
	}

	// Ground the model's prose: tell it once per turn which review it is
	// working on, so it stops asking for ids the app already has. The tools
	// are pre-scoped to the same review (args grounding), so the prefix says
	// so instead of restating ids.
	const scopeLabel = input.submissionId
		? `submission ${input.submissionId}${resolvedAssignmentId ? ` in assignment ${resolvedAssignmentId}` : ""}`
		: resolvedAssignmentId
			? `assignment ${resolvedAssignmentId}`
			: "";

	const scopedMessage = scopeLabel
		? `[Context: you are reviewing ${scopeLabel}. The tools are pre-scoped to this review — do not ask for or invent submission/assignment ids; gather any data you need with the tools.]\n\n${input.message}`
		: input.message;

	let current: Awaited<ReturnType<Agent["stream"]>>;
	try {
		const opts: Record<string, unknown> = {
			requestContext,
			maxSteps: MAX_STEPS,
			// Memory path requires BOTH threadId and resourceId
			// (AGENT_MEMORY_MISSING_RESOURCE_ID when only one is present;
			// silent plain mode when neither).
			resourceId,
			threadId: effectiveThreadId,
			// Without savePerStep Mastra never calls the memory storage —
			// thread/message persistence is gated on this flag (verified live).
			savePerStep: true,
			// Title is used by Mastra only at thread creation (prepare-memory-step);
			// existing threads keep their stored title.
			memory: {
				resource: resourceId,
				thread: input.title?.trim()
					? { id: effectiveThreadId, title: input.title.trim().slice(0, 80) }
					: effectiveThreadId,
				// Mastra reads memoryConfig from options.memory?.options —
				// lastMessages controls the recall window (how many recent
				// thread messages the model sees per turn). Settings are
				// re-read per request (loadSettings above), so a saved
				// window applies immediately.
				options: { lastMessages: reqState.settings.lastMessages },
			},
		};
		if (compactionSummary) {
			// System messages are never persisted by Memory.saveMessages, so
			// the summary is seen by the model every turn without bloating
			// storage or polluting the next compaction's input.
			opts.system = `Summary of the earlier conversation (older messages may be outside the recall window):\n${compactionSummary}`;
		}
		if (input.signal) opts.abortSignal = input.signal;
		current = await (
			agent!.stream as unknown as (
				messages: string,
				options: Record<string, unknown>,
			) => Promise<Awaited<ReturnType<Agent["stream"]>>>
		)(scopedMessage, opts);
	} catch (err) {
		if (!input.signal?.aborted) {
			yield { type: "error", message: errorMessage(err) };
			yield { type: "done" };
		}
		return;
	}

	const aborted = () => input.signal?.aborted === true;

	// W2a harness plan: emit ONCE at stream start, before the agent loop, with
	// every step pending. The plan is DERIVED from the registered tool
	// surface (tool-family → phase label); the client tracks status
	// transitions from the tool-call events as they flow. An already-aborted
	// run emits nothing (matches the abort-before-consumption contract).
	if (aborted()) return;
	yield { type: "plan", steps: derivePlanSteps(registry.list().map((tool) => tool.name)) };

	let text = "";
	// P3 turn checkpoints: snapshot the submission's grading state on the
	// FIRST grading write tool-call of the turn (before the write lands),
	// then never again for this run.
	let checkpointed = false;

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
						// P3 turn checkpoint: on the FIRST grading write tool-call
						// of the turn, snapshot the submission's grading state
						// BEFORE the write lands, persist it under the turn id,
						// and emit the checkpoint event. Best-effort — a failed
						// snapshot still emits the event with the empty snapshot
						// (reverting a no-op turn is a no-op) and never throws.
						// Per-submission scope only: an assignment-scoped chat
						// has no submission to revert, so no checkpoint is
						// emitted (the client's Revert button stays hidden).
						if (
							!checkpointed &&
							reqState.submissionId &&
							GRADING_WRITE_TOOLS.has(chunk.payload.toolName)
						) {
							checkpointed = true;
							const snapshot = await snapshotGradingState(
								reqState.assignmentId,
								reqState.submissionId,
							);
							try {
								await saveCheckpoint(effectiveThreadId, turnId, snapshot);
							} catch {
								// Persistence failure is invisible to the teacher —
								// the in-stream snapshot still enables the revert.
							}
							yield { type: "checkpoint", turnId, snapshot };
						}
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
							// W2d change ledger: grading write tools return
							// `previous`; emit the structured change list so
							// the client can render the accept/reject ledger.
							// Non-grading tools / missing previous → [] (no
							// event emitted — the ledger is additive).
							const changes = extractChangesFromToolResult(
								chunk.payload.toolName,
								result,
							);
							if (changes.length > 0) {
								yield { type: "change", changes };
							}
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
					case "tripwire":
						// Wave 3a input guardrails: a processor that BLOCKS the turn
						// (PromptInjectionDetector strategy "block") bails the run
						// with a single tripwire chunk. Surface it as the existing
						// `error` event so the teacher sees WHY the turn was
						// rejected — the run ends without reaching the model.
						yield {
							type: "error",
							message:
								typeof chunk.payload?.reason === "string" && chunk.payload.reason
									? chunk.payload.reason
									: "Input was blocked by a guardrail",
						};
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

/** Cap a string at maxLen chars, appending an ellipsis when cut. URLs are
 * kept whole — they are short, high-value (the search-docs summary must
 * keep its grounding link for the model), and the old string-slice
 * preserved them by accident. */
function truncateString(value: string, maxLen: number): string {
	if (value.length <= maxLen) return value;
	if (/^https?:\/\//.test(value)) return value;
	return `${value.slice(0, maxLen)}…`;
}

/**
 * Structural JSON truncation for tool-result summaries: keeps the JSON
 * VALID while capping its size, so the client's ToolArgs can parse it and
 * render key/value rows instead of a raw truncated blob. Long strings are
 * shortened; arrays/objects keep the first entries and append a count
 * marker. Falls back to the raw string when the value is not JSON-safe.
 */
function truncateJson(value: unknown, budget: number): unknown {
	// Strings inside a structure share the budget: cap each at a quarter of
	// it (min 16) so a multi-field item (e.g. a search-docs hit with title +
	// URL + snippet) still fits and isn't dropped whole.
	const stringCap = Math.max(16, Math.floor(budget / 4));
	if (value === null || typeof value !== "object") {
		return typeof value === "string" ? truncateString(value, stringCap) : value;
	}
	if (Array.isArray(value)) {
		const kept: unknown[] = [];
		let used = 0;
		for (const item of value) {
			const t = truncateJson(item, Math.max(16, budget - used));
			const s = JSON.stringify(t) ?? "";
			if (used + s.length > budget) break;
			kept.push(t);
			used += s.length;
		}
		if (kept.length < value.length) kept.push(`… +${value.length - kept.length} more`);
		return kept;
	}
	const record = value as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	let used = 0;
	for (const [key, val] of Object.entries(record)) {
		const t = truncateJson(val, Math.max(16, budget - used));
		const s = JSON.stringify(t) ?? "";
		if (used + s.length > budget) break;
		out[key] = t;
		used += s.length;
	}
	const remaining = Object.keys(record).length - Object.keys(out).length;
	if (remaining > 0) out["…"] = `+${remaining} more keys`;
	return out;
}

/** Short JSON summary of a tool result (truncated), or undefined when empty.
 * Budget 400 chars: lean enough for the model's per-turn context, generous
 * enough that a search-docs hit (URL + title + snippet) or a grading
 * envelope's key fields survive structural truncation. */
const TOOL_RESULT_SUMMARY_BUDGET = 400;

function summarizeToolResult(result: unknown): string | undefined {
	if (result === undefined || result === null) return undefined;
	let json: string;
	try {
		json = JSON.stringify(result);
	} catch {
		json = String(result);
	}
	if (json.length <= TOOL_RESULT_SUMMARY_BUDGET) return json;
	// Structural truncation keeps the JSON valid so the client's ToolArgs
	// can render key/value rows instead of a raw truncated blob.
	try {
		return JSON.stringify(truncateJson(result, TOOL_RESULT_SUMMARY_BUDGET));
	} catch {
		return `${json.slice(0, TOOL_RESULT_SUMMARY_BUDGET)}…`;
	}
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
