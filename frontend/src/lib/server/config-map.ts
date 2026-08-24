/**
 * @file Live configuration-inventory aggregation for GET /api/config/map (A1).
 *
 * Builds a full inventory of the running server's configuration: settings
 * group (data/settings.yaml + grading_config.yaml + env + localStorage),
 * assignment group (assignments.yaml enabled entries), deploy group
 * (process.env), and code group (engineering constants). Every row carries a
 * stable id, where the value lives, whether it is a secret, where the user
 * edits it (affordance), and when a change takes effect (reload).
 *
 * Contract notes:
 * - The API key row only reports PRESENCE: value is "••••" when set, null
 *   when unset — the real key is never exposed (it lives in env/process,
 *   never in settings.yaml — see settings.ts).
 * - The empty-assignment-group decision: when no assignment is enabled we
 *   emit a single `assignment.none` row with status "unset" instead of an
 *   empty group, so the UI can show the group with an explicit state.
 * - Env-fallback detection for llm.base_url / llm.model: when the env var is
 *   set and the effective value equals it, the row is "env-fallback"
 *   (settings.yaml has no llm.* override in effect). When the env var is
 *   unset the value is the code default and the row is "ok".
 * - Cheap by construction: every loader is a file read / env lookup.
 *   Never touches secrets beyond presence.
 *
 * This module runs only on the SvelteKit server (`$lib/server/`).
 */

import { getEnabledAssignments } from "$lib/server/assignments";
import { hasApiKey } from "$lib/server/api-key-store";
import { loadGradingConfigFile } from "$lib/server/grading-config-writer";
import { getDataDir } from "$lib/server/metadata";
import { loadSettings } from "$lib/server/settings";
import type { Assignment } from "$lib/types/assignments";

// ---------------------------------------------------------------------------
// Row model (exact contract — consumed by the Settings configuration map)
// ---------------------------------------------------------------------------

export type RowStatus = "ok" | "unset" | "env-fallback" | "readonly" | "secret-set";

export interface ConfigMapRow {
	/** Stable key, e.g. "llm.model". */
	id: string;
	group: "settings" | "assignment" | "deploy" | "code";
	name: string;
	description: string;
	value: string | null;
	source:
		| "settings.yaml"
		| "grading_config.yaml"
		| "assignments.yaml"
		| "criteria/<id>.yaml"
		| "scoring/<id>.yaml"
		| "env"
		| "localStorage"
		| "code";
	status: RowStatus;
	affordance: "this-page" | "assignment-editor" | "env-file" | "none";
	reload: "hot" | "next-request" | "restart";
	secret?: boolean;
}

export interface ConfigMapResponse {
	rows: ConfigMapRow[];
	generatedAt: string;
}

// ---------------------------------------------------------------------------
// Code-group constants (source-of-truth literals)
// ---------------------------------------------------------------------------
// These live in modules that do NOT export them (module-private `const` or an
// inline constructor argument, or Python env defaults). Importing those
// modules just to read a number would drag in heavy import graphs (routes,
// agent wiring) for zero benefit, so the literals are mirrored here exactly as
// they appear in source — same approach as the static configuration-map card.
// If any of these ever becomes an exported constant, prefer importing it.

/** Bounded concurrency for KI Connect calls — src/routes/api/submissions/pre-evaluate/+server.ts:53. */
const CODE_CONCURRENCY = 2;
/** PromptInjectionDetector threshold — src/lib/server/copilot/agent.ts:522 (Mastra documented default). */
const CODE_INJECTION_THRESHOLD = 0.7;
/** Minimum textarea length before evidence-fill kicks in — src/lib/server/copilot/post-process.ts:921. */
const CODE_TEXTAREA_MIN_CHARS = 20;
/** Rich-output caps — executor/runner.py:57-58 (env-driven defaults). */
const CODE_RICH_IMAGE_BYTES = 5 * 1024 * 1024; // RICH_OUTPUT_MAX_IMAGE_BYTES default: 5 MiB
const CODE_RICH_HTML_CHARS = 200_000; // RICH_OUTPUT_MAX_HTML_CHARS default: 200k

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/**
 * Build the live configuration inventory. All loaders are file reads / env
 * lookups, so the endpoint stays cheap; nothing is cached (config edits apply
 * on the next request).
 */
export async function getConfigMap(): Promise<ConfigMapResponse> {
	const settings = await loadSettings();

	const rows: ConfigMapRow[] = [
		// -- Settings group -------------------------------------------------
		...(await settingsRows(settings)),
		...(await assignmentRows()),
		...deployRows(),
		...codeRows(),
	];

	return { rows, generatedAt: new Date().toISOString() };
}

/** Settings group: data/settings.yaml + api-key presence + grading config + appearance. */
async function settingsRows(
	settings: Awaited<ReturnType<typeof loadSettings>>,
): Promise<ConfigMapRow[]> {
	return [
		llmRow(
			"llm.base_url",
			"LLM base URL",
			"KI Connect base URL (settings.yaml llm.base_url; env fallback KI_CONNECT_BASE_URL).",
			settings.llm.baseUrl,
			"KI_CONNECT_BASE_URL",
		),
		llmRow(
			"llm.model",
			"LLM model",
			"KI Connect model id (settings.yaml llm.model; env fallback KI_CONNECT_MODEL).",
			settings.llm.model,
			"KI_CONNECT_MODEL",
		),
		{
			id: "llm.timeout_ms",
			group: "settings",
			name: "LLM timeout (ms)",
			description: "LLM request timeout in milliseconds (settings.yaml llm.timeout_ms).",
			value: String(settings.llm.timeoutMs),
			source: "settings.yaml",
			status: "ok",
			affordance: "this-page",
			reload: "hot",
		},
		{
			id: "executor.request_timeout_ms",
			group: "settings",
			name: "Executor request timeout (ms)",
			description:
				"Single-notebook HTTP request timeout (settings.yaml executor.request_timeout_ms).",
			value: String(settings.executor.requestTimeoutMs),
			source: "settings.yaml",
			status: "ok",
			affordance: "this-page",
			reload: "hot",
		},
		{
			id: "executor.notebook_timeout_ms",
			group: "settings",
			name: "Executor notebook timeout (ms)",
			description:
				"Per-notebook time budget for a batch run (settings.yaml executor.notebook_timeout_ms).",
			value: String(settings.executor.notebookTimeoutMs),
			source: "settings.yaml",
			status: "ok",
			affordance: "this-page",
			reload: "hot",
		},
		{
			id: "executor.cell_timeout_s",
			group: "settings",
			name: "Executor cell timeout (s)",
			description:
				"Per-cell execution timeout sent to the executor (settings.yaml executor.cell_timeout_s).",
			value: String(settings.executor.cellTimeoutS),
			source: "settings.yaml",
			status: "ok",
			affordance: "this-page",
			reload: "hot",
		},
		{
			id: "copilot.mode",
			group: "settings",
			name: "Copilot mode",
			description: "Approval mode: ask | read-only | auto-approve-all (settings.yaml).",
			value: settings.copilot.mode,
			source: "settings.yaml",
			status: "ok",
			affordance: "this-page",
			reload: "hot",
		},
		{
			id: "copilot.allowed_tools",
			group: "settings",
			name: "Allowed tools",
			description:
				"Tools auto-approvable in ask mode, session-capped (settings.yaml copilot.allowed_tools).",
			value:
				settings.copilot.allowedTools.length > 0
					? settings.copilot.allowedTools.join(", ")
					: "(none)",
			source: "settings.yaml",
			status: "ok",
			affordance: "this-page",
			reload: "hot",
		},
		{
			id: "copilot.deny_tools",
			group: "settings",
			name: "Denied tools",
			description: "Tools that are never callable (settings.yaml copilot.deny_tools).",
			value:
				settings.copilot.denyTools.length > 0
					? settings.copilot.denyTools.join(", ")
					: "(none)",
			source: "settings.yaml",
			status: "ok",
			affordance: "this-page",
			reload: "hot",
		},
		{
			id: "copilot.approval_ttl_seconds",
			group: "settings",
			name: "Approval TTL (s)",
			description:
				"How long an approval card stays valid before it must be re-asked (settings.yaml).",
			value: String(settings.copilot.approvalTtlSeconds),
			source: "settings.yaml",
			status: "ok",
			affordance: "this-page",
			reload: "hot",
		},
		{
			id: "copilot.session_cap",
			group: "settings",
			name: "Session cap",
			description:
				"Per-session auto-approval budget in ask mode (settings.yaml copilot.session_cap).",
			value: String(settings.copilot.sessionCap),
			source: "settings.yaml",
			status: "ok",
			affordance: "this-page",
			reload: "hot",
		},
		{
			id: "copilot.last_messages",
			group: "settings",
			name: "Recall window (last messages)",
			description:
				"How many recent thread messages the model sees per turn (settings.yaml copilot.last_messages).",
			value: String(settings.copilot.lastMessages),
			source: "settings.yaml",
			status: "ok",
			affordance: "this-page",
			reload: "hot",
		},
		{
			id: "copilot.auto_compact",
			group: "settings",
			name: "Auto-compact",
			description:
				"Summarize out-of-window messages when the thread outgrows the recall window (settings.yaml).",
			value: String(settings.copilot.autoCompact),
			source: "settings.yaml",
			status: "ok",
			affordance: "this-page",
			reload: "hot",
		},
		apiKeyRow(),
		await gradingRow(),
		{
			id: "appearance",
			group: "settings",
			name: "Appearance",
			description:
				"Color scheme (light / dark / system) + autosave. Per-device, stored in the browser (localStorage) — not shared across devices.",
			value: null,
			source: "localStorage",
			status: "ok",
			affordance: "this-page",
			reload: "hot",
		},
	];
}

/** llm.* row with env-fallback detection (file value wins; env value only shows when it is in effect). */
function llmRow(
	id: string,
	name: string,
	description: string,
	value: string,
	envKey: string,
): ConfigMapRow {
	const envValue = process.env[envKey]?.trim() ?? "";
	const status: RowStatus = envValue !== "" && value === envValue ? "env-fallback" : "ok";
	return {
		id,
		group: "settings",
		name,
		description,
		value,
		source: "settings.yaml",
		status,
		affordance: "this-page",
		reload: "next-request",
	};
}

/** API-key presence row. The key lives in env/process only (never settings.yaml) and is masked. */
function apiKeyRow(): ConfigMapRow {
	const present = hasApiKey();
	return {
		id: "llm.api_key",
		group: "settings",
		name: "KI Connect API key",
		description:
			"KI Connect bearer token (env KI_CONNECT_API_KEY, replaceable at runtime via Settings). Stored in the server process only — presence is reported, the value is never returned.",
		value: present ? "••••" : null,
		source: "env",
		status: present ? "secret-set" : "unset",
		affordance: "this-page",
		reload: "next-request",
		secret: true,
	};
}

/** Grading dimensions + grade boundaries, live from data/grading_config.yaml. */
async function gradingRow(): Promise<ConfigMapRow> {
	const config = await loadGradingConfigFile();
	if (!config) {
		return {
			id: "grading.dimensions",
			group: "settings",
			name: "Grading dimensions & boundaries",
			description:
				"data/grading_config.yaml missing — no grading dimensions or grade boundaries configured.",
			value: null,
			source: "grading_config.yaml",
			status: "unset",
			affordance: "this-page",
			reload: "hot",
		};
	}

	const dimensions = config.dimensions
		.map((d) => `${d.key} (${d.title}, ${d.max_points} pts)`)
		.join(", ");
	const boundaries = config.grade_boundaries
		.map((b) => `${b.min_percentage}%→${b.grade} ${b.label}`)
		.join(", ");
	return {
		id: "grading.dimensions",
		group: "settings",
		name: "Grading dimensions & boundaries",
		description: `Grade boundaries: ${boundaries}.`,
		value: dimensions,
		source: "grading_config.yaml",
		status: "ok",
		affordance: "this-page",
		reload: "hot",
	};
}

/**
 * Assignment group: one row per enabled assignment (deep-links to the
 * assignment editor). When nothing is enabled we emit a single "unset" row so
 * the UI shows the group with an explicit state instead of an empty one.
 */
async function assignmentRows(): Promise<ConfigMapRow[]> {
	const enabled = await getEnabledAssignments();
	if (enabled.length === 0) {
		return [
			{
				id: "assignment.none",
				group: "assignment",
				name: "No enabled assignments",
				description:
					"No enabled assignments in assignments.yaml — create/enable one in the assignment editor.",
				value: null,
				source: "assignments.yaml",
				status: "unset",
				affordance: "assignment-editor",
				reload: "next-request",
			},
		];
	}
	return enabled.map((a) => ({
		id: `assignment.${a.id}`,
		group: "assignment",
		name: a.title,
		description: describeAssignment(a),
		value: a.id,
		source: "assignments.yaml",
		status: "ok",
		affordance: "assignment-editor",
		reload: "next-request",
	}));
}

/** Compact per-assignment summary: criteria files + scoring file + materials note. */
function describeAssignment(a: Assignment): string {
	const criteria =
		a.criteria_files.length > 0 ? `criteria: ${a.criteria_files.join(", ")}` : "criteria: none";
	const scoring = a.scoring_file
		? `scoring: ${a.scoring_file}`
		: "scoring: none (generic fallback)";
	return `${criteria}; ${scoring}; materials: <DATA_DIR>/materials/${a.id}/`;
}

/** Deploy group: live env values, read-only, restart to apply. */
function deployRows(): ConfigMapRow[] {
	const dataDir = getDataDir();
	const docsIndex = process.env.DOCS_INDEX_DIR ?? `(default: ${dataDir}/docs-index)`;
	const envRow = (
		id: string,
		name: string,
		description: string,
		value: string,
	): ConfigMapRow => ({
		id,
		group: "deploy",
		name,
		description,
		value,
		source: "env",
		status: "readonly",
		affordance: "env-file",
		reload: "restart",
	});

	return [
		envRow(
			"deploy.data_dir",
			"DATA_DIR",
			"Data root for all runtime config and state (env DATA_DIR; default ./data).",
			dataDir,
		),
		envRow(
			"deploy.docs_index_dir",
			"DOCS_INDEX_DIR",
			"Docs-RAG index directory — docs-index.json + vectors (env DOCS_INDEX_DIR; default <DATA_DIR>/docs-index).",
			docsIndex,
		),
		envRow(
			"deploy.origin",
			"ORIGIN",
			"Canonical origin URL of the deployment (env ORIGIN).",
			process.env.ORIGIN ?? "(unset)",
		),
		envRow(
			"deploy.pre_eval_critique",
			"PRE_EVAL_CRITIQUE",
			"Set to 0 to disable the pre-evaluation critique pass (env PRE_EVAL_CRITIQUE).",
			process.env.PRE_EVAL_CRITIQUE ?? "(unset)",
		),
		envRow(
			"deploy.ki_connect_base_url_env",
			"KI_CONNECT_BASE_URL (env)",
			"KI Connect base URL env fallback — in effect only when settings.yaml omits llm.base_url (see llm.base_url row).",
			process.env.KI_CONNECT_BASE_URL ?? "(unset)",
		),
	];
}

/** Code group: engineering constants — read-only, edit source + rebuild/restart. */
function codeRows(): ConfigMapRow[] {
	const codeRow = (
		id: string,
		name: string,
		description: string,
		value: string,
	): ConfigMapRow => ({
		id,
		group: "code",
		name,
		description,
		value,
		source: "code",
		status: "readonly",
		affordance: "none",
		reload: "restart",
	});

	return [
		codeRow(
			"code.concurrency",
			"KI Connect concurrency ceiling",
			`Bounded parallel KI Connect calls (${CODE_CONCURRENCY} in flight max — empirically safe ceiling; src/routes/api/submissions/pre-evaluate/+server.ts).`,
			String(CODE_CONCURRENCY),
		),
		codeRow(
			"code.injection_threshold",
			"Prompt-injection threshold",
			"PromptInjectionDetector threshold (Mastra documented default; strategy 'block'; src/lib/server/copilot/agent.ts).",
			String(CODE_INJECTION_THRESHOLD),
		),
		codeRow(
			"code.textarea_min_chars",
			"TEXTAREA_MIN_CHARS",
			"Minimum textarea length before evidence-fill kicks in (src/lib/server/copilot/post-process.ts).",
			String(CODE_TEXTAREA_MIN_CHARS),
		),
		codeRow(
			"code.rich_output_caps",
			"Rich-output caps",
			"RICH_OUTPUT_MAX_IMAGE_BYTES / RICH_OUTPUT_MAX_HTML_CHARS — env-driven defaults in executor/runner.py.",
			`image: ${CODE_RICH_IMAGE_BYTES} bytes; html: ${CODE_RICH_HTML_CHARS} chars`,
		),
	];
}
