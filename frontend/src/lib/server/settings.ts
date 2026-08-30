/**
 * @file data/settings.yaml loader + writer for server-side routes.
 *
 * Holds teacher-adjustable execution and LLM configuration that is shared
 * across the SvelteKit server (executor client, KI Connect client) and the
 * Settings UI. Env vars remain the fallback for anything not present in the
 * file, so existing Docker/deploy configuration keeps working.
 *
 * Layout (all keys optional; defaults shown):
 *   executor:
 *     request_timeout_ms: 30000     # single notebook HTTP request timeout
 *     notebook_timeout_ms: 120000   # per-notebook budget for a batch run
 *     cell_timeout_s: 30            # per-cell execution timeout sent to the executor
 *   llm:
 *     base_url: https://chat.kiconnect.nrw/api/v1
 *     model: qwen3-30b-a3b-instruct-2507
 *     timeout_ms: 60000
 *     embedding_model: e5-mistral-7b-instruct  # optional — docs-RAG embedder
 *   copilot:
 *     mode: ask                     # ask | read-only | auto-approve-all
 *     allowed_tools: []             # tools auto-approvable in ask mode (session-capped)
 *     deny_tools: []                # tools that are never callable
 *     approval_ttl_seconds: 60      # approval card lifetime
 *     session_cap: 20               # auto-approvals per session in ask mode
 *     last_messages: 16             # recall window (1-50); omit to follow the model
 *     auto_compact: true            # summarize out-of-window messages
 *
 * Secrets (KI_CONNECT_API_KEY) are never written to the settings file — the
 * key lives in the environment (and can be replaced at runtime via
 * PATCH /api/settings, which updates the in-memory store + env only).
 *
 * Environment:
 *   DATA_DIR — data root (default: ./data, i.e. /app/data in Docker)
 *
 * This module runs only on the SvelteKit server (`$lib/server/`).
 */

import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import path from "node:path";
import * as yaml from "js-yaml";

import { getDataDir } from "./metadata";
import { resolveLastMessagesDefault } from "./copilot/model-context";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExecutorSettings {
	/** HTTP request timeout for a single notebook execution (ms). */
	requestTimeoutMs: number;
	/** Per-notebook timeout budget for a batch run (ms). */
	notebookTimeoutMs: number;
	/** Per-cell execution timeout forwarded to the executor (seconds). */
	cellTimeoutS: number;
}

export interface LlmSettings {
	baseUrl: string;
	model: string;
	timeoutMs: number;
	/**
	 * Embedding model for the docs-RAG vector leg (settings.yaml
	 * llm.embedding_model; env fallback KI_CONNECT_EMBEDDING_MODEL). Optional:
	 * when absent, resolveEmbeddingModel() falls back to the env var, then the
	 * built-in default (the model of the downloadable prebuilt corpus —
	 * e5-mistral-7b-instruct — so a fresh deploy stays option-A-compatible).
	 */
	embeddingModel?: string;
}

export type CopilotMode = "ask" | "read-only" | "auto-approve-all";

export interface CopilotSettings {
	/** Approval mode for copilot tools. */
	mode: CopilotMode;
	/** Tools auto-approvable in ask mode, up to sessionCap per session. */
	allowedTools: string[];
	/** Tools that are never callable, regardless of mode. */
	denyTools: string[];
	/** How long an approval card stays valid before it must be re-asked (s). */
	approvalTtlSeconds: number;
	/** Per-session auto-approval budget in ask mode. */
	sessionCap: number;
	/**
	 * Recall window: how many recent thread messages the model sees per turn
	 * (Mastra BaseMemoryConfig.lastMessages). When the yaml omits it, the
	 * default resolves from the configured LLM's context size.
	 */
	lastMessages: number;
	/**
	 * Automatic compaction: when the thread outgrows the recall
	 * window (messageCount >= 2 * lastMessages), the server summarizes the
	 * out-of-window messages with the LLM and injects the summary as a
	 * system message on subsequent turns. Default true; false disables the
	 * extra LLM summarization calls entirely (cost guard).
	 */
	autoCompact: boolean;
}

export interface AppSettings {
	executor: ExecutorSettings;
	llm: LlmSettings;
	copilot: CopilotSettings;
}

// ---------------------------------------------------------------------------
// Defaults (mirror the env fallbacks in executor-client.ts and ki-connect.ts)
// ---------------------------------------------------------------------------

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_NOTEBOOK_TIMEOUT_MS = 120_000; // ~10x a single notebook's wall time
const DEFAULT_CELL_TIMEOUT_S = 30;
const DEFAULT_LLM_BASE_URL = "https://chat.kiconnect.nrw/api/v1";
const DEFAULT_LLM_MODEL = "qwen3-30b-a3b-instruct-2507";
const DEFAULT_LLM_TIMEOUT_MS = 60_000;
/** Docs-RAG embedding model default (the downloadable prebuilt corpus model). */
const DEFAULT_EMBEDDING_MODEL = "e5-mistral-7b-instruct";
const DEFAULT_COPILOT_MODE: CopilotMode = "ask";
const DEFAULT_COPILOT_ALLOWED_TOOLS: string[] = [];
const DEFAULT_COPILOT_DENY_TOOLS: string[] = [];
const DEFAULT_COPILOT_APPROVAL_TTL_SECONDS = 60;
const DEFAULT_COPILOT_SESSION_CAP = 20;
const DEFAULT_COPILOT_AUTO_COMPACT = true;

function envNumber(key: string, fallback: number): number {
	const raw = process.env[key];
	if (raw === undefined || raw === "") return fallback;
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function envString(key: string, fallback: string): string {
	return process.env[key]?.trim() || fallback;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export function getSettingsPath(): string {
	return path.join(getDataDir(), "settings.yaml");
}

/** Validate a parsed settings object; returns the raw shape or null. */
function parseSettings(raw: unknown): {
	executor?: Record<string, unknown>;
	llm?: Record<string, unknown>;
	copilot?: Record<string, unknown>;
} | null {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
	const obj = raw as Record<string, unknown>;
	if (
		obj.executor !== undefined &&
		(typeof obj.executor !== "object" || obj.executor === null || Array.isArray(obj.executor))
	) {
		return null;
	}
	if (
		obj.llm !== undefined &&
		(typeof obj.llm !== "object" || obj.llm === null || Array.isArray(obj.llm))
	) {
		return null;
	}
	if (
		obj.copilot !== undefined &&
		(typeof obj.copilot !== "object" || obj.copilot === null || Array.isArray(obj.copilot))
	) {
		return null;
	}
	return obj as {
		executor?: Record<string, unknown>;
		llm?: Record<string, unknown>;
		copilot?: Record<string, unknown>;
	};
}

/**
 * Load and parse data/settings.yaml. Missing file → defaults merged with env.
 * A present-but-invalid file throws (a broken config should surface, not
 * silently fall back to defaults the teacher no longer sees in the UI).
 */
export async function loadSettings(): Promise<AppSettings> {
	let raw: string;
	try {
		raw = await readFile(getSettingsPath(), "utf-8");
	} catch (err) {
		if (isNodeError(err) && err.code === "ENOENT") {
			return defaults();
		}
		throw err;
	}

	let parsed: unknown;
	try {
		parsed = yaml.load(raw);
	} catch (err) {
		throw new Error(`settings.yaml is invalid YAML: ${(err as Error).message}`, {
			cause: err,
		});
	}
	const file = parseSettings(parsed);
	if (!file) {
		throw new Error(
			`settings.yaml must be an object with optional executor/llm/copilot sections`,
		);
	}
	return defaults(file);
}

/** Merge file values over env defaults. Missing file keys fall back to env. */
function defaults(file?: {
	executor?: Record<string, unknown>;
	llm?: Record<string, unknown>;
	copilot?: Record<string, unknown>;
}): AppSettings {
	const executor = file?.executor ?? {};
	const llm = file?.llm ?? {};
	const copilot = file?.copilot ?? {};
	// The recall-window default is model-aware: when the yaml
	// omits copilot.last_messages, the effective window follows the
	// configured LLM's context size, so model switches apply automatically.
	const llmModel = stringValue(llm.model, envString("KI_CONNECT_MODEL", DEFAULT_LLM_MODEL));
	// Optional key — stays ABSENT unless configured: file wins, then env;
	// blank/whitespace values count as absent (never forces settings.yaml churn).
	const embeddingModel =
		optionalString(llm.embedding_model) ??
		optionalString(process.env.KI_CONNECT_EMBEDDING_MODEL);

	return {
		executor: {
			requestTimeoutMs: fileNumber(
				executor.request_timeout_ms,
				"EXECUTOR_REQUEST_TIMEOUT_MS",
				DEFAULT_REQUEST_TIMEOUT_MS,
			),
			notebookTimeoutMs: fileNumber(
				executor.notebook_timeout_ms,
				"EXECUTOR_NOTEBOOK_TIMEOUT_MS",
				DEFAULT_NOTEBOOK_TIMEOUT_MS,
			),
			cellTimeoutS: fileNumber(
				executor.cell_timeout_s,
				"EXECUTOR_CELL_TIMEOUT_S",
				DEFAULT_CELL_TIMEOUT_S,
			),
		},
		llm: {
			baseUrl: fileString(llm.base_url, "KI_CONNECT_BASE_URL", DEFAULT_LLM_BASE_URL),
			model: llmModel,
			timeoutMs: fileNumber(llm.timeout_ms, "KI_CONNECT_TIMEOUT_MS", DEFAULT_LLM_TIMEOUT_MS),
			...(embeddingModel !== undefined ? { embeddingModel } : {}),
		},
		copilot: {
			mode: copilotModeValue(copilot.mode, DEFAULT_COPILOT_MODE),
			allowedTools: stringList(copilot.allowed_tools, DEFAULT_COPILOT_ALLOWED_TOOLS),
			denyTools: stringList(copilot.deny_tools, DEFAULT_COPILOT_DENY_TOOLS),
			approvalTtlSeconds: positiveNumber(
				copilot.approval_ttl_seconds,
				DEFAULT_COPILOT_APPROVAL_TTL_SECONDS,
			),
			sessionCap: positiveNumber(copilot.session_cap, DEFAULT_COPILOT_SESSION_CAP),
			lastMessages: lastMessagesValue(
				copilot.last_messages,
				resolveLastMessagesDefault(llmModel),
			),
			autoCompact: booleanValue(copilot.auto_compact, DEFAULT_COPILOT_AUTO_COMPACT),
		},
	};
}

function positiveNumber(value: unknown, fallback: number): number {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
	if (typeof value === "string") {
		const parsed = Number(value);
		if (Number.isFinite(parsed) && parsed > 0) return parsed;
	}
	return fallback;
}

/**
 * Resolve the effective docs-RAG embedding model:
 * `settings.llm.embeddingModel` → `KI_CONNECT_EMBEDDING_MODEL` env → built-in
 * default (`e5-mistral-7b-instruct`, the model of the downloadable prebuilt
 * corpus, so a fresh deploy with no config stays option-A-compatible).
 *
 * Used by the docs-embed build job and the config-map row. A blank value
 * behaves like an absent one (never "wins" over the next chain link).
 */
export function resolveEmbeddingModel(settings: Pick<AppSettings, "llm">): string {
	return (
		settings.llm.embeddingModel ||
		envString("KI_CONNECT_EMBEDDING_MODEL", DEFAULT_EMBEDDING_MODEL)
	);
}

function stringValue(value: unknown, fallback: string): string {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

/** Non-empty trimmed string, or undefined when absent/blank (optional keys). */
function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** YAML number with env fallback: file value wins, then env, then default. */
function fileNumber(fileValue: unknown, envKey: string, fallback: number): number {
	return positiveNumber(fileValue, envNumber(envKey, fallback));
}

/** YAML string with env fallback: file value wins, then env, then default. */
function fileString(fileValue: unknown, envKey: string, fallback: string): string {
	return stringValue(fileValue, envString(envKey, fallback));
}

/** Boolean yaml value; anything that is not a real boolean falls back. */
function booleanValue(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function copilotModeValue(value: unknown, fallback: CopilotMode): CopilotMode {
	return value === "ask" || value === "read-only" || value === "auto-approve-all"
		? value
		: fallback;
}

function stringList(value: unknown, fallback: string[]): string[] {
	if (!Array.isArray(value)) return fallback;
	return value
		.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
		.map((item) => item.trim());
}

/** Recall window: finite integer in 1-50; anything else falls back to the
 * model-aware default (matches the PUT route's isAppSettings guard). */
function lastMessagesValue(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 50
		? value
		: fallback;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** Serialize settings to YAML (wire shape, snake_case keys). */
export function toSettingsYaml(settings: AppSettings): string {
	return yaml.dump(
		{
			executor: {
				request_timeout_ms: settings.executor.requestTimeoutMs,
				notebook_timeout_ms: settings.executor.notebookTimeoutMs,
				cell_timeout_s: settings.executor.cellTimeoutS,
			},
			llm: {
				base_url: settings.llm.baseUrl,
				model: settings.llm.model,
				timeout_ms: settings.llm.timeoutMs,
				// Optional — serialize only when set, or every teacher save would
				// write the resolved default into the tracked settings.yaml (churn).
				...(settings.llm.embeddingModel !== undefined
					? { embedding_model: settings.llm.embeddingModel }
					: {}),
			},
			copilot: {
				mode: settings.copilot.mode,
				allowed_tools: settings.copilot.allowedTools,
				deny_tools: settings.copilot.denyTools,
				approval_ttl_seconds: settings.copilot.approvalTtlSeconds,
				session_cap: settings.copilot.sessionCap,
				last_messages: settings.copilot.lastMessages,
				auto_compact: settings.copilot.autoCompact,
			},
		},
		{ noRefs: true },
	);
}

/** Atomically write data/settings.yaml (temp file + rename). */
export async function writeSettings(settings: AppSettings): Promise<void> {
	const filePath = getSettingsPath();
	await mkdir(path.dirname(filePath), { recursive: true });
	const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
	await writeFile(tmpPath, toSettingsYaml(settings), "utf-8");
	await rename(tmpPath, filePath);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
	return err instanceof Error && "code" in err;
}
