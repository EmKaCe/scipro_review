/**
 * @file Model-context math for the copilot (Task U.1, shared with Task V).
 *
 * Single source of truth for how the recall window and compaction budgets
 * derive from the configured LLM's context size. The default recall window
 * (`lastMessages`) adapts to the model so teachers never have to tune it;
 * an explicit value in data/settings.yaml always wins.
 *
 * Model list source: chat.kiconnect.nrw deployments page (2026-08-10).
 * Only models actually deployed on KI Connect are listed.
 */

/** Verified context-token sizes for KI Connect models.
 * Unknown models fall back to a conservative 32_768. */
export const MODEL_CONTEXT_TOKENS: Record<string, number> = {
	// ── Open-weight models (no strict quotas) ──

	// Qwen3-30B-A3B: 32_768 native. Operator: Academiccloud, Germany only.
	"qwen3-30b-a3b-instruct-2507": 32_768,

	// GPT-OSS 120B: ~128K native context. Operator: Inferenz NRW, Germany only.
	"gpt-oss-120b": 131_072,

	// Llama 3.1 8B Instruct: 128K native context. Operator: Academiccloud, Germany only.
	"llama-3.1-8b": 131_072,

	// Mistral Small 4 119B (2603 build): ~128K context. Operator: Inferenz NRW, Germany only.
	"mistral-small-4-119b-2603": 131_072,

	// ── Closed-weight models (strict quotas — AVOID for batch workloads) ──

	// GPT-5.2: large context (reasoning). Operator: Academiccloud, worldwide.
	"gpt-5.2": 131_072,

	// GPT-5: large context (reasoning). Operator: Academiccloud, worldwide.
	"gpt-5": 131_072,

	// GPT-4.1: 128K context. Operator: Academiccloud, worldwide.
	"gpt-4.1": 131_072,

	// GPT-4.1-Mini: 128K context. Operator: Academiccloud, worldwide.
	"gpt-4.1-mini": 131_072,
};

export const UNKNOWN_MODEL_CONTEXT_TOKENS = 32_768;

/**
 * True for models with open weights (no strict quotas).
 * Closed-weight models (gpt-5.2, gpt-5, gpt-4.1, gpt-4.1-mini) have
 * strict quotas — callers should warn the teacher before using one.
 */
export function isOpenWeightModel(modelId: string): boolean {
	const lower = modelId.toLowerCase();
	return (
		lower.includes("qwen") ||
		lower.includes("gpt-oss") ||
		lower.includes("mistral") ||
		lower.includes("llama")
	);
}

/**
 * Recommended default model for batch pre-evaluation.
 * gpt-oss-120b is preferred for its large context (128K) and open-weight licensing.
 * Falls back to qwen3-30b if the API key lacks Inferenz NRW access.
 */
export const RECOMMENDED_MODEL = "gpt-oss-120b";
export const FALLBACK_MODEL = "qwen3-30b-a3b-instruct-2507";

/** ~40% of context budgeted for message history; the rest goes to
 * instructions + 27 tool definitions + summary + current turn + output. */
const HISTORY_BUDGET_FRACTION = 0.4;
/** Conservative average tokens per stored message (teacher chats + tool cards). */
const AVG_MSG_TOKENS = 800;

export function resolveLastMessagesDefault(modelId: string): number {
	const context = MODEL_CONTEXT_TOKENS[modelId] ?? UNKNOWN_MODEL_CONTEXT_TOKENS;
	return Math.min(
		50,
		Math.max(5, Math.floor((context * HISTORY_BUDGET_FRACTION) / AVG_MSG_TOKENS)),
	);
}

/** Compaction input cap: never load more history than ~80% of the model's context. */
export function resolveSummaryTokenCap(modelId: string): number {
	const context = MODEL_CONTEXT_TOKENS[modelId] ?? UNKNOWN_MODEL_CONTEXT_TOKENS;
	return Math.min(100_000, Math.floor(context * 0.8));
}

/** Summary SIZE cap: keep the injected summary at ~5% of context, ≤ 4_000
 * tokens. Hermes caps summaries the same way (`min(context × 0.05, 12_000)`)
 * — a verbose summary injected as a system message would eat the context it
 * is supposed to save. For the default model: 0.05 × 32_768 ≈ 1_638 tokens. */
export function resolveSummarySizeTokens(modelId: string): number {
	const context = MODEL_CONTEXT_TOKENS[modelId] ?? UNKNOWN_MODEL_CONTEXT_TOKENS;
	return Math.min(4_000, Math.floor(context * 0.05));
}
