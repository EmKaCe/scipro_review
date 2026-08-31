/**
 * @file Pure model-recommendation tagging for the onboarding LLM picker.
 *
 * Badges degrade gracefully: a model is only badged when its id is present
 * in the LIVE list offered by the instance (never hardcode a recommendation
 * that cannot be honored).
 *
 * Mirror rule: keep the id sets in sync with
 * - frontend/src/lib/server/copilot/pipeline/prompts.ts
 *   (`PHASE_2_MODEL_DEFAULT` — the pipeline-tuned grading model)
 * - frontend/src/lib/server/copilot/model-context.ts
 *   (`MODEL_CONTEXT_TOKENS` keys — cheap validation models)
 */

/** The pipeline-tuned grading model (badge "Recommended"). */
export const RECOMMENDED_MODEL_IDS: readonly string[] = ["openai-gpt-oss-120b", "gpt-oss-120b"];

/** Cheap/fast validation models (badge "Fast — good for validation"). */
export const FAST_MODEL_IDS: readonly string[] = [
	"openai-gpt5.2",
	"gpt-5.2",
	"qwen3-30b-a3b-instruct-2507",
];

export type ModelBadge = "recommended" | "fast";

export interface ModelRecommendation {
	badge?: ModelBadge;
}

/**
 * Recommend a badge for a model id, but ONLY when the id is present in the
 * live list (degrade gracefully to no badge otherwise).
 */
export function recommendModel(id: string, liveIds: ReadonlySet<string>): ModelRecommendation {
	if (!liveIds.has(id)) return {};
	if (RECOMMENDED_MODEL_IDS.includes(id)) return { badge: "recommended" };
	if (FAST_MODEL_IDS.includes(id)) return { badge: "fast" };
	return {};
}
