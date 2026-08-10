/**
 * @file Model-context math for the copilot (Task U.1, shared with Task V).
 *
 * Single source of truth for how the recall window and compaction budgets
 * derive from the configured LLM's context size. The default recall window
 * (`lastMessages`) adapts to the model so teachers never have to tune it;
 * an explicit value in data/settings.yaml always wins.
 */

/** Verified context-token sizes for known models (provider docs). Add new
 * models here; unknown models fall back to a conservative 32_768. */
export const MODEL_CONTEXT_TOKENS: Record<string, number> = {
	// Qwen3-30B-A3B family: 32_768 native, 131_072 with YaRN; the 2507 build
	// advertises 256K long-context but that needs server-side extension —
	// use the native number, conservatively.
	"qwen3-30b-a3b-instruct-2507": 32_768,

	// GPT-OSS family (OpenAI, open-weight): 128K native context.
	"gpt-oss-120b": 131_072,

	// Mistral family (open-weight)
	"mistral-7b-instruct-v0.3": 32_768,
	"mistral-nemo-instruct-2407": 128_000,
	"mistral-large-instruct-2407": 128_000,
	"mistral-small-instruct-2409": 32_768,

	// Llama 3.1 family (open-weight, Meta): 128K native context
	"llama-3.1-8b-instruct": 131_072,
	"llama-3.1-70b-instruct": 131_072,
	"llama-3.1-405b-instruct": 131_072,

	// Llama 3 family (open-weight): 8K native context
	"llama-3-8b-instruct": 8_192,
	"llama-3-70b-instruct": 8_192,
};
export const UNKNOWN_MODEL_CONTEXT_TOKENS = 32_768;

/**
 * True for open-weight model families (qwen, gpt-oss, mistral, llama /
 * meta-llama). Closed-weight models (gpt-4o, claude, …) come with strict
 * quotas, so callers can warn the teacher before using one.
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
