/**
 * @file Append-only JSONL audit log for copilot tool calls.
 *
 * Every copilot tool invocation (before + after) is recorded as one JSON
 * line in:
 *   <DATA_DIR>/copilot/audit.jsonl
 *
 * The log is the accountability trail for the permission gate and doubles as
 * the gate's test oracle: decision ("auto" | "approved" | "denied") and ok
 * are recorded per call. It is strictly append-only — lines are never
 * rewritten, so the file is safe to tail and to diff across runs.
 *
 * Arguments are redacted before they are written (see redactArgs): long
 * strings are truncated and sensitive keys are masked, so the log never
 * contains student code or credentials.
 *
 * Environment:
 *   DATA_DIR — data root (default: ./data, i.e. /app/data in Docker)
 *
 * This module runs only on the SvelteKit server (`$lib/server/`).
 */

import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

import { getDataDir } from "$lib/server/metadata";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Whether the call required explicit teacher approval. */
export type AuditPermission = "auto" | "approval";

/** Gate decision recorded for a call. */
export type AuditDecision = "auto" | "approved" | "denied";

/** One audit line: a single tool call attempt or its outcome. */
export interface AuditEntry {
	/** ISO timestamp of the event. */
	ts: string;
	/** Conversation/thread id when available. */
	threadId?: string;
	/** Tool name, e.g. "executeNotebook". */
	tool: string;
	/** Whether the call required explicit teacher approval. */
	permission: AuditPermission;
	/** Redacted JSON of the tool arguments. */
	argsRedacted: string;
	/** Gate decision for this call. */
	decision: AuditDecision;
	/** True when the call succeeded (beforeToolCall: the attempt happened). */
	ok: boolean;
}

/**
 * Context passed to the audit hooks. Structural — the caller (agent.ts)
 * adapts Mastra's ToolHooks shape to these keys:
 *
 *   tool       — tool name (string)
 *   args       — tool arguments (any JSON-serializable value)
 *   permission — "auto" | "approval" (default "auto")
 *   decision   — "auto" | "approved" | "denied" (default "auto")
 *   ok         — success flag (default true)
 */
export interface AuditHookContext {
	tool?: string;
	args?: unknown;
	permission?: AuditPermission;
	decision?: AuditDecision;
	ok?: boolean;
	[key: string]: unknown;
}

export type AuditHook = (ctx: Record<string, unknown>) => void | Promise<void>;

export interface AuditHooks {
	beforeToolCall: AuditHook;
	afterToolCall: AuditHook;
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

const MAX_STRING_LENGTH = 200;
const ELLIPSIS = "…";
const REDACTED = "[redacted]";

/** Content-bearing keys whose values are always masked. */
const SENSITIVE_CONTENT_KEY = /source|cellSource|notes|content|feedback|reason|justification/i;

/**
 * Credential-like keys, belt-and-braces — tools never see the API key, but
 * we never risk it. Case-insensitive substring match, so "apiKey",
 * "access_token", "clientSecret" all match.
 */
const SECRET_KEY = /key|token|secret/i;

/** Recursively redact a JSON-serializable value. */
function redactValue(value: unknown): unknown {
	if (typeof value === "string") {
		return value.length > MAX_STRING_LENGTH
			? `${value.slice(0, MAX_STRING_LENGTH)}${ELLIPSIS}`
			: value;
	}
	if (Array.isArray(value)) {
		return value.map((item) => redactValue(item));
	}
	if (value !== null && typeof value === "object") {
		// Special objects (Date, class instances with toJSON) — normalize via
		// a JSON round-trip so they redact as plain data.
		if (typeof (value as { toJSON?: unknown }).toJSON === "function") {
			const serialized = JSON.stringify(value);
			return serialized === undefined ? REDACTED : redactValue(JSON.parse(serialized));
		}
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) {
			if (SECRET_KEY.test(key) || SENSITIVE_CONTENT_KEY.test(key)) {
				out[key] = REDACTED;
			} else {
				out[key] = redactValue(item);
			}
		}
		return out;
	}
	return value;
}

/**
 * Serialize tool arguments for the audit log, applying the redaction rules:
 *   1. string values longer than 200 chars are truncated (200 + ellipsis);
 *   2. content-bearing keys (source, notes, content, ...) are masked;
 *   3. credential-like keys (key, token, secret) are masked.
 */
export function redactArgs(args: unknown): string {
	return JSON.stringify(redactValue(args)) ?? "undefined";
}

// ---------------------------------------------------------------------------
// Append-only writer
// ---------------------------------------------------------------------------

/**
 * Append one audit entry as a single JSON line to
 * `<dir>/copilot/audit.jsonl` (creating the directory tree as needed).
 *
 * @param dir Data root; defaults to getDataDir() (DATA_DIR or ./data).
 *            The file is always at `<dir>/copilot/audit.jsonl`.
 */
export async function appendAuditEntry(entry: AuditEntry, dir?: string): Promise<void> {
	const auditDir = path.join(dir ?? getDataDir(), "copilot");
	await mkdir(auditDir, { recursive: true });
	await appendFile(path.join(auditDir, "audit.jsonl"), `${JSON.stringify(entry)}\n`, "utf-8");
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/**
 * Build the audit hooks for one thread. beforeToolCall logs the attempt
 * (ok: true, decision from ctx, default "auto"); afterToolCall logs the
 * outcome (ok from ctx, default true).
 */
export function createAuditHooks(threadId?: string): AuditHooks {
	const makeEntry = (ctx: Record<string, unknown>, ok: boolean): AuditEntry => {
		const permission: AuditPermission = ctx.permission === "approval" ? "approval" : "auto";
		const rawDecision = ctx.decision;
		const decision: AuditDecision =
			rawDecision === "approved" || rawDecision === "denied" ? rawDecision : "auto";
		return {
			ts: new Date().toISOString(),
			threadId,
			tool: typeof ctx.tool === "string" ? ctx.tool : "unknown",
			permission,
			argsRedacted: redactArgs(ctx.args),
			decision,
			ok,
		};
	};
	return {
		beforeToolCall(ctx) {
			return appendAuditEntry(makeEntry(ctx, true));
		},
		afterToolCall(ctx) {
			return appendAuditEntry(makeEntry(ctx, ctx.ok !== false));
		},
	};
}
