/**
 * @file Typed client for GET/PUT /api/settings.
 *
 * Mirrors the server-side AppSettings shape (see $lib/server/settings.ts).
 * The wire format is the same camelCase shape both sides use.
 */

// ---------------------------------------------------------------------------
// Wire types (API JSON shapes)
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
	 * (Mastra BaseMemoryConfig.lastMessages). The server resolves a
	 * model-aware default when the yaml omits it.
	 */
	lastMessages: number;
	/**
	 * Automatic compaction: summarize out-of-window messages with
	 * the LLM and inject the summary as a system message on later turns.
	 */
	autoCompact: boolean;
}

export interface AppSettings {
	executor: ExecutorSettings;
	llm: LlmSettings;
	copilot: CopilotSettings;
}

/** GET /api/settings response: AppSettings plus whether an API key is set.
 * The key itself is never exposed. */
export interface SettingsResponse extends AppSettings {
	hasApiKey: boolean;
}

/** One model entry from GET /api/settings/models. */
export interface ModelInfo {
	id: string;
	contextTokens: number;
	isOpenWeight: boolean;
	operator?: string;
}

export interface ModelsResponse {
	models: ModelInfo[];
	/** "live" — detected from KI Connect; "static" — fallback map. */
	source: "live" | "static";
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/** GET /api/settings — current executor + LLM settings. */
export async function fetchSettings(): Promise<SettingsResponse> {
	const resp = await fetch("/api/settings");
	if (!resp.ok) {
		throw new Error(`Failed to load settings (${resp.status})`);
	}
	return (await resp.json()) as SettingsResponse;
}

/** PUT /api/settings — persist settings to data/settings.yaml. */
export async function saveSettings(settings: AppSettings): Promise<SettingsResponse> {
	const resp = await fetch("/api/settings", {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(settings),
	});
	if (!resp.ok) {
		const body = await resp.json().catch(() => null);
		throw new Error(
			body && typeof body.message === "string"
				? body.message
				: `Failed to save settings (${resp.status})`,
		);
	}
	return (await resp.json()) as SettingsResponse;
}

/** GET /api/settings/models — live model list (static fallback on failure). */
export async function fetchModels(): Promise<ModelsResponse> {
	const resp = await fetch("/api/settings/models");
	if (!resp.ok) {
		throw new Error(`Failed to load models (${resp.status})`);
	}
	return (await resp.json()) as ModelsResponse;
}

/** PATCH /api/settings — replace the server-side KI Connect API key. */
export async function saveApiKey(apiKey: string): Promise<void> {
	const resp = await fetch("/api/settings", {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ apiKey }),
	});
	if (!resp.ok) {
		const body = await resp.json().catch(() => null);
		throw new Error(
			body && typeof body.message === "string"
				? body.message
				: `Failed to save API key (${resp.status})`,
		);
	}
}
