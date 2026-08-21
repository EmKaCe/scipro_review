/**
 * @file KI Connect LLM client — TypeScript server-side sibling of
 *       `executor/ki_connect.py`.
 *
 * Provides the same `analyze()` and `autofix()` interface for
 * lightweight analysis tasks on the teacher side.
 *
 * This module runs only on the SvelteKit server (`$lib/server/`).
 * It is NOT imported by client/browser code.
 *
 * Environment variables (set via .env or Docker environment):
 *   KI_CONNECT_API_KEY  — Bearer token for the KI Connect API
 *   KI_CONNECT_BASE_URL — Base URL (default: https://chat.kiconnect.nrw/api/v1)
 *   KI_CONNECT_MODEL    — Model name (default: qwen3-30b-a3b-instruct-2507)
 */

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { extractAndParseJSON } from "$lib/server/copilot/json-repair";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface KiConnectOptions {
	apiKey?: string;
	baseUrl?: string;
	model?: string;
	timeout?: number;
}

export interface AnalysisResult {
	tasks?: Array<{
		id: number;
		title: string;
		cell_indices: number[];
		description: string;
	}>;
	cell_annotations?: Array<{
		index: number;
		purpose: string;
		issues: string[] | null;
	}>;
	notebook_summary?: string;
	cell_count?: number;
	has_errors?: boolean;
	[key: string]: unknown;
}

export interface AutofixResult {
	suggestion?: string;
	explanation?: string;
	confidence?: number;
	fix_type?: string;
	skipped?: true;
	[key: string]: unknown;
}

/** Thrown when KI Connect rate-limits a request (HTTP 429). Carries the
 * server's Retry-After hint when one was provided. */
class RateLimitedError extends Error {
	readonly retryAfterMs: number | undefined;
	constructor(retryAfterMs?: number) {
		super("KI Connect: rate limited (429)");
		this.name = "RateLimitedError";
		this.retryAfterMs = retryAfterMs;
	}
}

export interface CellInfo {
	index?: number;
	type?: string;
	cell_type?: string;
	source?: string;
	[key: string]: unknown;
}

/** A model listed by the KI Connect API (`GET {baseUrl}/models`). */
export interface KiConnectModel {
	id: string;
	object: string;
	created: number;
	owned_by: string;
	context_length?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = "https://chat.kiconnect.nrw/api/v1";
const DEFAULT_MODEL = "qwen3-30b-a3b-instruct-2507";
const DEFAULT_TIMEOUT = 60_000; // ms

// Prompt templates (mirror the Python client)
const ANALYSIS_SYSTEM_PROMPT = `You are an expert programming teaching assistant analyzing Jupyter notebook submissions for a Scientific Programming course. Your task is to analyze the student's notebook structure and provide structured annotations.

Analyze the notebook cells and provide:
1. Task segmentation — group cells into logical task groups based on the assignment context
2. Per-cell annotations — describe what each cell does
3. Issues detected — any problematic patterns (missing imports, incorrect approaches)

Return your analysis as a JSON object exactly matching this structure:
{
  "tasks": [
    {
      "id": 1,
      "title": "Task name",
      "cell_indices": [0, 1, 2],
      "description": "Brief description of what this task does"
    }
  ],
  "cell_annotations": [
    {
      "index": 0,
      "purpose": "What this cell does",
      "issues": ["any issues detected"] or null
    }
  ],
  "notebook_summary": "One-sentence summary of the notebook",
  "cell_count": 37,
  "has_errors": false
}`;

const AUTOFIX_SYSTEM_PROMPT = `You are an expert Python debugger helping a student fix a broken Jupyter notebook cell. Analyze the error, the cell source, and the surrounding context cells. Provide a fix suggestion.

Return a JSON object exactly matching this structure:
{
  "suggestion": "The corrected cell source code",
  "explanation": "Brief explanation of what was wrong and how the fix works",
  "confidence": 0.95,
  "fix_type": "import_fix" | "syntax_fix" | "logic_fix" | "api_fix" | "other"
}`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getEnv(key: string, fallback: string): string {
	// Try process.env (works in Node/SvelteKit server and bun)
	if (typeof process !== "undefined" && process.env && process.env[key]) {
		return process.env[key]!;
	}
	return fallback;
}

function formatCellsForPrompt(cells: CellInfo[]): string {
	const lines: string[] = [];
	for (let i = 0; i < cells.length; i++) {
		const cell = cells[i];
		const cellType = cell.type ?? cell.cell_type ?? "code";
		let source = cell.source ?? "";

		if (source.length > 2000) {
			source = source.slice(0, 2000) + "\n# ... [truncated]";
		}

		lines.push(`[Cell ${i}] type=${cellType}`);
		lines.push(source);
		lines.push("---");
	}
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class KiConnectClient {
	private apiKey: string;
	private baseUrl: string;
	private model: string;
	private timeout: number;

	constructor(opts: KiConnectOptions = {}) {
		this.apiKey = opts.apiKey ?? getEnv("KI_CONNECT_API_KEY", "");
		this.baseUrl = (opts.baseUrl ?? getEnv("KI_CONNECT_BASE_URL", DEFAULT_BASE_URL)).replace(
			/\/+$/,
			"",
		);
		this.model = opts.model ?? getEnv("KI_CONNECT_MODEL", DEFAULT_MODEL);
		this.timeout = opts.timeout ?? DEFAULT_TIMEOUT;
	}

	// ------------------------------------------------------------------
	// Public API
	// ------------------------------------------------------------------

	/**
	 * Analyze notebook cells and return structured analysis.
	 * Returns `null` if the API is unavailable or returns an error.
	 */
	async analyze(
		notebookCells: CellInfo[],
		assignmentContext?: string,
	): Promise<AnalysisResult | null> {
		if (!this.apiKey) {
			console.debug("[ki-connect] analyze skipped (no API key)");
			return null;
		}

		const cellsText = formatCellsForPrompt(notebookCells);
		let userPrompt = `Analyze this Jupyter notebook:\n\n${cellsText}`;
		if (assignmentContext) {
			userPrompt = `Assignment context:\n${assignmentContext}\n\n${cellsText}`;
		}

		try {
			const response = await this.chatCompletion(ANALYSIS_SYSTEM_PROMPT, userPrompt, 0.1, {
				type: "json_object",
			});
			return response as AnalysisResult;
		} catch (err) {
			console.error("[ki-connect] analysis failed:", err);
			return null;
		}
	}

	/**
	 * Suggest a fix for a broken cell.
	 * Returns `{ skipped: true }` on failure or if API is unavailable.
	 */
	async autofix(
		cellSource: string,
		cellError: string,
		contextCells?: CellInfo[],
	): Promise<AutofixResult> {
		if (!this.apiKey) {
			console.debug("[ki-connect] autofix skipped (no API key)");
			return { skipped: true };
		}

		let contextText = "";
		if (contextCells && contextCells.length > 0) {
			contextText =
				"Context cells (surrounding the broken cell):\n" +
				formatCellsForPrompt(contextCells);
		}

		const userPrompt =
			`Fix this broken cell:\n\n` +
			"```python\n" +
			cellSource +
			"\n```\n\n" +
			`Error:\n\`\`\`\n${cellError}\n\`\`\`\n\n` +
			contextText;

		try {
			const response = await this.chatCompletion(AUTOFIX_SYSTEM_PROMPT, userPrompt, 0.2, {
				type: "json_object",
			});
			return response as AutofixResult;
		} catch (err) {
			console.error("[ki-connect] autofix failed:", err);
			return { skipped: true };
		}
	}

	/**
	 * List the models available on the KI Connect deployment
	 * (`GET {baseUrl}/models`).
	 *
	 * Returns an empty array on any failure (non-2xx, network error,
	 * no API key) — never throws. Callers fall back to the static model
	 * map when the live list is unavailable.
	 */
	async listModels(): Promise<KiConnectModel[]> {
		const url = `${this.baseUrl}/models`;
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), this.timeout);

		try {
			const resp = await fetch(url, {
				method: "GET",
				headers: {
					...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
				},
				signal: controller.signal,
			});
			if (!resp.ok) {
				console.warn(`[ki-connect] listModels failed (HTTP ${resp.status})`);
				return [];
			}
			const data = (await resp.json()) as { data?: KiConnectModel[] };
			return Array.isArray(data?.data) ? data.data : [];
		} catch (err) {
			console.warn("[ki-connect] listModels failed:", err);
			return [];
		} finally {
			clearTimeout(timeoutId);
		}
	}

	// ------------------------------------------------------------------
	// Internal HTTP
	// ------------------------------------------------------------------

	/**
	 * Call the chat completions endpoint and return the parsed JSON response.
	 * Throws on HTTP errors or network failure.
	 *
	 * The response content is parsed with `extractAndParseJSON` (markdown
	 * fence extraction + common JSON error repair). If that fails, the raw
	 * content is sent back to the model once for correction (temperature 0,
	 * `json_object` format); if the retry also fails to parse, an error
	 * carrying the first 500 chars of the original content is thrown.
	 *
	 * An optional Zod `schema` validates the parsed result before it is
	 * returned; validation failures throw with the joined Zod error messages.
	 *
	 * An optional `timeoutMs` overrides the instance timeout for THIS call
	 * only (applies to the initial request AND the JSON-repair retry); when
	 * omitted, the instance timeout (constructor `opts.timeout`, default
	 * {@link DEFAULT_TIMEOUT}) is used.
	 */
	async chatCompletion(
		system: string,
		user: string,
		temperature: number = 0.1,
		responseFormat?: { type: string },
		schema?: import("zod").ZodType<unknown>,
		timeoutMs?: number,
		model?: string,
	): Promise<Record<string, unknown>> {
		const effectiveModel = model ?? this.model;
		const body: Record<string, unknown> = {
			model: effectiveModel,
			messages: [
				{ role: "system", content: system },
				{ role: "user", content: user },
			],
			temperature,
		};
		if (responseFormat) {
			body.response_format = responseFormat;
		}

		const content = await this.postChatCompletion(body, timeoutMs);

		let parsed: unknown;
		try {
			parsed = extractAndParseJSON(content);
		} catch {
			// One retry: ask the model to return corrected JSON.
			const retryBody: Record<string, unknown> = {
				model: effectiveModel,
				messages: [
					{
						role: "system",
						content:
							"Your previous response was not valid JSON. Return ONLY the corrected JSON object — no markdown fences, no extra text.",
					},
					{ role: "user", content: `Fix this JSON:\n${content}` },
				],
				temperature: 0,
				response_format: { type: "json_object" },
			};

			let retryContent: string;
			try {
				retryContent = await this.postChatCompletion(retryBody, timeoutMs);
			} catch (retryErr) {
				const status =
					retryErr instanceof Error
						? (retryErr.message.match(/\b\d{3}\b/)?.[0] ?? undefined)
						: undefined;
				if (status !== undefined) {
					throw new Error(
						`KI Connect: JSON repair retry failed with HTTP status ${status}`,
						{ cause: retryErr },
					);
				}
				throw retryErr;
			}

			try {
				parsed = extractAndParseJSON(retryContent);
			} catch {
				throw new Error(
					`KI Connect: model returned invalid JSON even after a repair retry. Original content (first 500 chars): ${content.slice(0, 500)}`,
				);
			}
		}

		if (schema) {
			const result = schema.safeParse(parsed);
			if (!result.success) {
				throw new Error(
					`KI Connect: response failed schema validation: ${result.error.issues
						.map((issue) => issue.message)
						.join("; ")}`,
				);
			}
			return result.data as Record<string, unknown>;
		}

		return parsed as Record<string, unknown>;
	}

	/**
	 * Single-turn chat completion returning the RAW response text — no JSON
	 * extraction or repair. Used by pipeline steps whose output is free-form
	 * markdown (e.g. the pre-evaluation worksheet batch calls); the JSON
	 * parsing in {@link chatCompletion} would mangle markdown responses.
	 *
	 * An optional `timeoutMs` overrides the instance timeout for this call
	 * only (applies to the initial request only — there is no repair retry).
	 */
	async chatCompletionText(
		system: string,
		user: string,
		temperature: number = 0.1,
		timeoutMs?: number,
		model?: string,
	): Promise<string> {
		const body: Record<string, unknown> = {
			model: model ?? this.model,
			messages: [
				{ role: "system", content: system },
				{ role: "user", content: user },
			],
			temperature,
		};
		return this.postChatCompletion(body, timeoutMs);
	}

	/**
	 * POST a chat completion body and return the raw response content string.
	 * Throws on HTTP errors, network failure, or empty content. A per-call
	 * `timeoutMs` overrides the instance timeout for this request only.
	 */
	private async postChatCompletion(
		body: Record<string, unknown>,
		timeoutMs?: number,
	): Promise<string> {
		const url = `${this.baseUrl}/chat/completions`;
		const effectiveTimeout = timeoutMs ?? this.timeout;
		const MAX_ATTEMPTS = 4;

		let lastRateLimitMs = 1000;
		for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), effectiveTimeout);
			try {
				const resp = await fetch(url, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${this.apiKey}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify(body),
					signal: controller.signal,
				});

				if (resp.status === 401) {
					throw new Error("KI Connect: authentication failed (check KI_CONNECT_API_KEY)");
				}
				if (resp.status === 429) {
					// Rate limited — the deployment throttles burst concurrency/RPM.
					// Retry with backoff (respect Retry-After when provided) instead of
					// failing the row: a batch run must survive a transient 429.
					const retryAfterRaw = resp.headers.get("retry-after");
					const retryAfterMs = retryAfterRaw
						? Number(retryAfterRaw) * 1000 ||
							Date.parse(retryAfterRaw) - Date.now() ||
							1000
						: undefined;
					lastRateLimitMs = retryAfterMs ?? lastRateLimitMs;
					if (attempt < MAX_ATTEMPTS - 1) {
						await new Promise((r) => setTimeout(r, lastRateLimitMs * 2 ** attempt));
						continue;
					}
					throw new RateLimitedError(lastRateLimitMs);
				}
				if (resp.status >= 400 && resp.status < 500) {
					const detail = await resp.text().catch(() => "");
					throw new Error(`KI Connect returned ${resp.status}: ${detail.slice(0, 500)}`);
				}
				if (resp.status >= 500) {
					const detail = await resp.text().catch(() => "");
					throw new Error(
						`KI Connect server error ${resp.status}: ${detail.slice(0, 500)}`,
					);
				}

				const data = (await resp.json()) as {
					choices?: Array<{ message?: { content?: string } }>;
				};
				const content = data?.choices?.[0]?.message?.content ?? "";
				if (!content) {
					throw new Error("KI Connect: empty response content");
				}

				return content;
			} catch (err) {
				if (err instanceof RateLimitedError) {
					throw err; // exhausted retries — let the caller decide
				}
				if (err instanceof Error && err.name === "AbortError") {
					throw new Error("KI Connect request timed out", { cause: err });
				}
				throw err;
			} finally {
				clearTimeout(timeoutId);
			}
		}
		throw new RateLimitedError(lastRateLimitMs);
	}
}

/** Singleton instance (reuse across the server process). */
let _defaultInstance: KiConnectClient | null = null;

/** Get or create the default singleton KiConnectClient. */
export function getKiConnectClient(): KiConnectClient {
	if (!_defaultInstance) {
		_defaultInstance = new KiConnectClient();
	}
	return _defaultInstance;
}

/** Drop the singleton so the next {@link getKiConnectClient} call builds a
 * fresh instance (e.g. after the API key changed via the settings page). */
export function resetKiConnectClient(): void {
	_defaultInstance = null;
}
