/**
 * @file Unit tests — model-recommendations tagging helper.
 *
 * Badges must degrade gracefully: a model is only badged when its id is
 * present in the LIVE list offered by the instance.
 */
import { describe, expect, it } from "vitest";

import { recommendModel } from "$lib/components/settings/model-recommendations.js";

describe("recommendModel", () => {
	it("badges the pipeline-tuned grading model only when present in the live list", () => {
		const live = new Set(["openai-gpt-oss-120b", "qwen3-30b-a3b-instruct-2507"]);
		expect(recommendModel("openai-gpt-oss-120b", live)).toEqual({ badge: "recommended" });
	});

	it("badges fast validation models only when present in the live list", () => {
		const live = new Set(["openai-gpt-oss-120b", "openai-gpt5.2"]);
		expect(recommendModel("openai-gpt5.2", live)).toEqual({ badge: "fast" });
		expect(recommendModel("qwen3-30b-a3b-instruct-2507", live)).toEqual({});
	});

	it("returns no badge for unknown models", () => {
		const live = new Set(["some-unknown-model", "openai-gpt-oss-120b"]);
		expect(recommendModel("some-unknown-model", live)).toEqual({});
	});

	it("degrades gracefully when the recommended id is not in the live list", () => {
		// The instance does not offer the tuned model — no badge at all.
		const live = new Set(["qwen3-30b-a3b-instruct-2507"]);
		expect(recommendModel("openai-gpt-oss-120b", live)).toEqual({});
	});

	it("never badges an id absent from the live list, regardless of the static map", () => {
		expect(recommendModel("openai-gpt-oss-120b", new Set())).toEqual({});
		expect(recommendModel("openai-gpt5.2", new Set())).toEqual({});
	});
});
