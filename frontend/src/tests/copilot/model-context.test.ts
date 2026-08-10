/**
 * @file Unit tests for model-context.ts (Task U.1) — the model-aware recall
 * window and compaction budget math shared by settings and Task V.
 *
 * MODEL_CONTEXT_TOKENS is a mutable exported record (const only prevents
 * reassignment), so tiny/huge context cases are exercised by registering
 * throwaway model ids and deleting them afterwards.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
	MODEL_CONTEXT_TOKENS,
	isOpenWeightModel,
	resolveLastMessagesDefault,
	resolveSummarySizeTokens,
	resolveSummaryTokenCap,
} from "$lib/server/copilot/model-context";

const KNOWN = "qwen3-30b-a3b-instruct-2507";
const TEST_KEYS: string[] = [];

afterEach(() => {
	for (const key of TEST_KEYS.splice(0)) delete MODEL_CONTEXT_TOKENS[key];
});

/** Register a throwaway model with the given context size for one test. */
function withContext(modelId: string, context: number): void {
	MODEL_CONTEXT_TOKENS[modelId] = context;
	TEST_KEYS.push(modelId);
}

describe("model-context.ts", () => {
	describe("MODEL_CONTEXT_TOKENS registry", () => {
		it("qwen3-30b-a3b-instruct-2507 -> 32_768", () => {
			expect(MODEL_CONTEXT_TOKENS[KNOWN]).toBe(32_768);
		});

		it("gpt-oss-120b -> 131_072 (128K)", () => {
			expect(MODEL_CONTEXT_TOKENS["gpt-oss-120b"]).toBe(131_072);
		});

		it("mistral family contexts", () => {
			expect(MODEL_CONTEXT_TOKENS["mistral-7b-instruct-v0.3"]).toBe(32_768);
			expect(MODEL_CONTEXT_TOKENS["mistral-nemo-instruct-2407"]).toBe(128_000);
			expect(MODEL_CONTEXT_TOKENS["mistral-large-instruct-2407"]).toBe(128_000);
			expect(MODEL_CONTEXT_TOKENS["mistral-small-instruct-2409"]).toBe(32_768);
		});

		it("llama 3.1 family -> 131_072 (128K)", () => {
			expect(MODEL_CONTEXT_TOKENS["llama-3.1-8b-instruct"]).toBe(131_072);
			expect(MODEL_CONTEXT_TOKENS["llama-3.1-70b-instruct"]).toBe(131_072);
			expect(MODEL_CONTEXT_TOKENS["llama-3.1-405b-instruct"]).toBe(131_072);
		});

		it("llama 3 family -> 8_192", () => {
			expect(MODEL_CONTEXT_TOKENS["llama-3-8b-instruct"]).toBe(8_192);
			expect(MODEL_CONTEXT_TOKENS["llama-3-70b-instruct"]).toBe(8_192);
		});

		it("unknown model is not in the registry (32K fallback applies)", () => {
			expect(MODEL_CONTEXT_TOKENS["gpt-4o"]).toBeUndefined();
		});
	});

	describe("resolveLastMessagesDefault", () => {
		it("known model (qwen3-30b-a3b-instruct-2507) -> 16", () => {
			expect(resolveLastMessagesDefault(KNOWN)).toBe(16);
		});

		it("gpt-oss-120b (128K) -> 50 (cap)", () => {
			expect(resolveLastMessagesDefault("gpt-oss-120b")).toBe(50);
		});

		it("mistral-nemo-instruct-2407 (128K) -> 50 (cap)", () => {
			expect(resolveLastMessagesDefault("mistral-nemo-instruct-2407")).toBe(50);
		});

		it("llama-3.1-8b-instruct (128K) -> 50 (cap)", () => {
			expect(resolveLastMessagesDefault("llama-3.1-8b-instruct")).toBe(50);
		});

		it("llama-3-8b-instruct (8K) -> 5 (floor)", () => {
			expect(resolveLastMessagesDefault("llama-3-8b-instruct")).toBe(5);
		});

		it("unknown model falls back to the conservative 32K context -> 16", () => {
			expect(resolveLastMessagesDefault("some-unknown-model")).toBe(16);
		});

		it("tiny context floors at 5 (floor(8K * 0.4 / 800) = 4 -> 5)", () => {
			withContext("tiny-model", 8_192);
			expect(resolveLastMessagesDefault("tiny-model")).toBe(5);
		});

		it("huge context caps at 50", () => {
			withContext("huge-model", 1_000_000);
			expect(resolveLastMessagesDefault("huge-model")).toBe(50);
		});
	});

	describe("resolveSummaryTokenCap", () => {
		it("known model -> floor(32_768 * 0.8) = 26_214", () => {
			expect(resolveSummaryTokenCap(KNOWN)).toBe(26_214);
		});

		it("gpt-oss-120b -> min(100_000, floor(131_072 * 0.8)) = 100_000", () => {
			expect(resolveSummaryTokenCap("gpt-oss-120b")).toBe(100_000);
		});

		it("never exceeds the 100_000 cap", () => {
			withContext("huge-model", 1_000_000);
			expect(resolveSummaryTokenCap("huge-model")).toBe(100_000);
		});
	});

	describe("resolveSummarySizeTokens", () => {
		it("known model -> floor(32_768 * 0.05) = 1_638", () => {
			expect(resolveSummarySizeTokens(KNOWN)).toBe(1_638);
		});

		it("gpt-oss-120b -> min(4_000, floor(131_072 * 0.05)) = 4_000", () => {
			expect(resolveSummarySizeTokens("gpt-oss-120b")).toBe(4_000);
		});

		it("unknown model -> 1_638 (same 32K fallback)", () => {
			expect(resolveSummarySizeTokens("some-unknown-model")).toBe(1_638);
		});

		it("huge context caps at 4_000", () => {
			withContext("huge-model", 1_000_000);
			expect(resolveSummarySizeTokens("huge-model")).toBe(4_000);
		});
	});

	describe("isOpenWeightModel", () => {
		it("returns true for the open-weight families", () => {
			expect(isOpenWeightModel("gpt-oss-120b")).toBe(true);
			expect(isOpenWeightModel("gpt-oss-20b")).toBe(true);
			expect(isOpenWeightModel("qwen3-30b-a3b-instruct-2507")).toBe(true);
			expect(isOpenWeightModel("mistral-nemo-instruct-2407")).toBe(true);
			expect(isOpenWeightModel("mistral-small-instruct-2409")).toBe(true);
			expect(isOpenWeightModel("llama-3.1-8b-instruct")).toBe(true);
			expect(isOpenWeightModel("meta-llama/llama-3.1-405b-instruct")).toBe(true);
		});

		it("returns false for closed-weight models", () => {
			expect(isOpenWeightModel("gpt-4o")).toBe(false);
			expect(isOpenWeightModel("claude-3-5-sonnet")).toBe(false);
			expect(isOpenWeightModel("gemini-2.0-flash")).toBe(false);
			expect(isOpenWeightModel("")).toBe(false);
		});

		it("is case-insensitive", () => {
			expect(isOpenWeightModel("GPT-OSS-120B")).toBe(true);
			expect(isOpenWeightModel("Llama-3.1-70B-Instruct")).toBe(true);
		});
	});
});
