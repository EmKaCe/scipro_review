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
 *
 * Secrets (KI_CONNECT_API_KEY) intentionally stay in the environment — the
 * settings file and its API never read or write API keys.
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
}

export interface AppSettings {
	executor: ExecutorSettings;
	llm: LlmSettings;
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
	return obj as { executor?: Record<string, unknown>; llm?: Record<string, unknown> };
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
		throw new Error(`settings.yaml must be an object with optional executor/llm sections`);
	}
	return defaults(file);
}

/** Merge file values over env defaults. Missing file keys fall back to env. */
function defaults(file?: {
	executor?: Record<string, unknown>;
	llm?: Record<string, unknown>;
}): AppSettings {
	const executor = file?.executor ?? {};
	const llm = file?.llm ?? {};

	return {
		executor: {
			requestTimeoutMs: positiveNumber(
				executor.request_timeout_ms,
				envNumber("EXECUTOR_REQUEST_TIMEOUT_MS", DEFAULT_REQUEST_TIMEOUT_MS),
			),
			notebookTimeoutMs: positiveNumber(
				executor.notebook_timeout_ms,
				envNumber("EXECUTOR_NOTEBOOK_TIMEOUT_MS", DEFAULT_NOTEBOOK_TIMEOUT_MS),
			),
			cellTimeoutS: positiveNumber(
				executor.cell_timeout_s,
				envNumber("EXECUTOR_CELL_TIMEOUT_S", DEFAULT_CELL_TIMEOUT_S),
			),
		},
		llm: {
			baseUrl: stringValue(
				llm.base_url,
				envString("KI_CONNECT_BASE_URL", DEFAULT_LLM_BASE_URL),
			),
			model: stringValue(llm.model, envString("KI_CONNECT_MODEL", DEFAULT_LLM_MODEL)),
			timeoutMs: positiveNumber(
				llm.timeout_ms,
				envNumber("KI_CONNECT_TIMEOUT_MS", DEFAULT_LLM_TIMEOUT_MS),
			),
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

function stringValue(value: unknown, fallback: string): string {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
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
