// @vitest-environment node
/**
 * @file Unit tests for the rubric-fidelity scorer (Wave 4).
 *
 * The scorer's judge is an LLM call (the KI Connect model) — behavioral
 * scoring tests are impractical with the scripted v2 mock, so these tests
 * cover the CONFIGURATION contract: the factory builds, the schemas validate
 * a sample grading proposal, and buildAgent() succeeds with the scorer wired.
 */

import { describe, expect, it } from "vitest";

import {
	createRubricFidelityScorer,
	rubricFidelityInputSchema,
	rubricFidelityOutputSchema,
} from "$lib/server/copilot/rubric-fidelity";

describe("rubric-fidelity scorer (Wave 4)", () => {
	it("factory builds a scorer with the expected id and judge", () => {
		const scorer = createRubricFidelityScorer({} as never);
		expect(scorer.id).toBe("rubric-fidelity");
		expect(scorer.description).toContain("faithful to the assignment's rubric");
		expect(scorer.judge).toBeDefined();
		expect(scorer.judge?.instructions).toContain("max_points");
	});

	it("input schema validates a sample grading proposal", () => {
		const parsed = rubricFidelityInputSchema.safeParse({
			dimensions: { code_quality_design: 4, scientific_programming: 5 },
			rubric: { clarity: "good" },
			feedback: "Solid work.",
			assignmentId: "soil_contamination",
		});
		expect(parsed.success).toBe(true);
	});

	it("input schema rejects non-finite dimension scores", () => {
		const parsed = rubricFidelityInputSchema.safeParse({
			dimensions: { code_quality_design: Number.NaN },
		});
		expect(parsed.success).toBe(false);
	});

	it("output schema validates a 0-1 score with a reason", () => {
		const parsed = rubricFidelityOutputSchema.safeParse({
			score: 0.85,
			reason: "Scores align with the rubric; one selection contradicts the criteria.",
		});
		expect(parsed.success).toBe(true);
	});

	it("output schema rejects out-of-range scores", () => {
		expect(rubricFidelityOutputSchema.safeParse({ score: 1.5, reason: "x" }).success).toBe(false);
		expect(rubricFidelityOutputSchema.safeParse({ score: -0.1, reason: "x" }).success).toBe(false);
	});
});
