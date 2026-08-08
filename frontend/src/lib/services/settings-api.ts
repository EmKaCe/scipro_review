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
}

export interface AppSettings {
	executor: ExecutorSettings;
	llm: LlmSettings;
	copilot: CopilotSettings;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/** GET /api/settings — current executor + LLM settings. */
export async function fetchSettings(): Promise<AppSettings> {
	const resp = await fetch("/api/settings");
	if (!resp.ok) {
		throw new Error(`Failed to load settings (${resp.status})`);
	}
	return (await resp.json()) as AppSettings;
}

/** PUT /api/settings — persist settings to data/settings.yaml. */
export async function saveSettings(settings: AppSettings): Promise<AppSettings> {
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
	return (await resp.json()) as AppSettings;
}
