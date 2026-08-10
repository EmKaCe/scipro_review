/**
 * @file Model-context math for the copilot.
 *
 * Single source of truth for how the recall window and compaction budgets
 * derive from the configured LLM's context size. The default recall window
 * (`lastMessages`) adapts to the model so teachers never have to tune it;
 * an explicit value in data/settings.yaml always wins.
 *
 * Model list source: chat.kiconnect.nrw deployments page (2026-08-10).
 * Context sizes verified from KI Connect token limits + provider docs.
 */

/**
 * Fallback context-token sizes for KI Connect models (max input tokens).
 *
 * The PRIMARY source of model metadata is the live `GET /api/settings/models`
 * endpoint (KiConnectClient.listModels, using `context_length` from the API).
 * This static map is the fallback when KI Connect is unreachable or returns
 * no model list; unknown models fall back to a conservative 32_768.
 */
export const MODEL_CONTEXT_TOKENS: Record<string, number> = {
	// ── Open-weight models (no strict quotas) ──

	// Qwen3-30B-A3B: 262,144 natively (KI Connect: 262.1k). HuggingFace confirms.
	// Operator: Academiccloud, Germany only.
	"qwen3-30b-a3b-instruct-2507": 262_144,

	// GPT-OSS 120B: 131,072 context (KI Connect: 131.1k). OpenAI docs confirm.
	// Operator: Inferenz NRW, Germany only.
	"gpt-oss-120b": 131_072,

	// Llama 3.1 8B Instruct: 128K context (KI Connect: 128k).
	// Operator: Academiccloud, Germany only.
	"llama-3.1-8b": 131_072,

	// Mistral Small 4 119B: 262,144 context (KI Connect: 262.1k). HuggingFace: 256k.
	// Operator: Inferenz NRW, Germany only.
	"mistral-small-4-119b-2603": 262_144,

	// ── Closed-weight models (strict quotas — AVOID for batch workloads) ──

	// GPT-5.2: 400,000 context (KI Connect: 400k). Reasoning model.
	// Operator: Academiccloud, worldwide.
	"gpt-5.2": 400_000,

	// GPT-5: 400,000 context (KI Connect: 400k). Reasoning model.
	// Operator: Academiccloud, worldwide.
	"gpt-5": 400_000,

	// GPT-4.1: 1,047,576 context (KI Connect: 1047.6k).
	// Operator: Academiccloud, worldwide.
	"gpt-4.1": 1_047_576,

	// GPT-4.1-Mini: 1,047,576 context (KI Connect: 1047.6k).
	// Operator: Academiccloud, worldwide.
	"gpt-4.1-mini": 1_047_576,
};

export const UNKNOWN_MODEL_CONTEXT_TOKENS = 32_768;

/**
 * Resolve the context-token size for a model ID, normalizing KI Connect's
 * vendor-prefixed names to our canonical keys.
 *
 * KI Connect prepends vendor prefixes the static map does not carry
 * (e.g. the live API returns `openai-gpt-oss-120b` but our key is
 * `gpt-oss-120b`).  This function strips known prefixes, lowercases,
 * and tries sub-string containment before falling back to
 * {@link UNKNOWN_MODEL_CONTEXT_TOKENS}.
 */
export function resolveContextTokens(modelId: string): number {
	// 1) Exact match
	if (MODEL_CONTEXT_TOKENS[modelId] !== undefined) return MODEL_CONTEXT_TOKENS[modelId];

	const lower = modelId.toLowerCase().trim();

	// 2) Lowercase exact match
	for (const [key, tokens] of Object.entries(MODEL_CONTEXT_TOKENS)) {
		if (key.toLowerCase() === lower) return tokens;
	}

	// 3) Strip vendor prefixes KI Connect adds
	const stripped = lower
		.replace(/^openai[-_]/, "")
		.replace(/^mistralai[-_]/, "")
		.replace(/^qwen[-_]/, "")
		.replace(/^e5[-_]/, "");

	for (const [key, tokens] of Object.entries(MODEL_CONTEXT_TOKENS)) {
		if (key.toLowerCase() === stripped) return tokens;
	}

	// 3b) Normalize spaces → dashes and try again (KI "LLAMA 3.1 8B" vs our "llama-3.1-8b")
	const spaceNormalized = stripped.replace(/\s+/g, "-");
	for (const [key, tokens] of Object.entries(MODEL_CONTEXT_TOKENS)) {
		if (key.toLowerCase() === spaceNormalized) return tokens;
	}

	// 3c) Try removing dashes/dots from our keys to match KI's compact forms
	//     (KI "openai-gpt5.2" → stripped "gpt5.2" → our key "gpt-5.2" → undashed "gpt52")
	//     (KI "openai-gpt41" → stripped "gpt41" → our key "gpt-4.1" → collapsed "gpt41")
	for (const [key, tokens] of Object.entries(MODEL_CONTEXT_TOKENS)) {
		const collapsed = key.toLowerCase().replace(/[-.]/g, "");
		if (collapsed === stripped.replace(/[-.]/g, "")) return tokens;
	}

	// 4) Sub-string containment: the static key must appear as a whole
	//    token inside the live id (e.g. live "LLAMA 3.1 8B" contains "llama")
	for (const [key, tokens] of Object.entries(MODEL_CONTEXT_TOKENS)) {
		const kl = key.toLowerCase();
		if (kl.length >= 6 && lower.includes(kl)) return tokens;
	}

	return UNKNOWN_MODEL_CONTEXT_TOKENS;
}

/**
 * True for models with open weights (no strict quotas).
 * Closed-weight models (gpt-5.2, gpt-5, gpt-4.1, gpt-4.1-mini) have
 * strict quotas — callers should warn the teacher before using one.
 *
 * Normalizes KI Connect vendor prefixes before checking.
 */
export function isOpenWeightModel(modelId: string): boolean {
	const lower = modelId.toLowerCase();
	// Strip KI Connect prefixes so "openai-gpt-oss-120b" → "gpt-oss-120b"
	const normalized = lower
		.replace(/^openai[-_]/, "")
		.replace(/^mistralai[-_]/, "");
	return (
		normalized.includes("qwen") ||
		normalized.includes("gpt-oss") ||
		normalized.includes("mistral") ||
		normalized.includes("llama")
	);
}

/**
 * Recommended default model for batch pre-evaluation.
 * qwen3-30b is preferred for its 262K context + Academiccloud operator
 * (our API key is Academiccloud-scoped). gpt-oss-120b is Inferenz NRW.
 */
export const RECOMMENDED_MODEL = "qwen3-30b-a3b-instruct-2507";
export const FALLBACK_MODEL = "qwen3-30b-a3b-instruct-2507";

/** ~40% of context budgeted for message history; the rest goes to
 * instructions + tool definitions + summary + current turn + output. */
const HISTORY_BUDGET_FRACTION = 0.4;
/** Conservative average tokens per stored message (teacher chats + tool cards). */
const AVG_MSG_TOKENS = 800;

export function resolveLastMessagesDefault(modelId: string): number {
	const context = resolveContextTokens(modelId);
	return Math.min(
		50,
		Math.max(5, Math.floor((context * HISTORY_BUDGET_FRACTION) / AVG_MSG_TOKENS)),
	);
}

/** Compaction input cap: never load more history than ~80% of the model's context. */
export function resolveSummaryTokenCap(modelId: string): number {
	const context = resolveContextTokens(modelId);
	return Math.min(100_000, Math.floor(context * 0.8));
}

/** Summary SIZE cap: keep the injected summary at ~5% of context, ≤ 4_000
 * tokens. Hermes caps summaries the same way (`min(context × 0.05, 12_000)`)
 * — a verbose summary injected as a system message would eat the context it
 * is supposed to save. For the default model: 0.05 × 262_144 ≈ 13_107 → cap 4_000. */
export function resolveSummarySizeTokens(modelId: string): number {
	const context = resolveContextTokens(modelId);
	return Math.min(4_000, Math.floor(context * 0.05));
}
