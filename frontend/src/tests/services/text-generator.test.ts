/**
 * @file Unit tests for text-generator.ts
 *
 * Tests evaluation text generation (plain text and Markdown),
 * feedback extraction, and evaluation object generation.
 */
import { describe, it, expect } from "vitest";
import {
	generateEvaluationText,
	generateEvaluationMarkdown,
	generateEvaluation,
} from "$lib/services/text-generator";
import type { ReviewSession, CategorySelections } from "$lib/types/session";
import type { MergedRubric, Category } from "$lib/types/criteria";
import type { GradingConfig, GradingInputs, GradeResult } from "$lib/types/grading";
import { categoryKeyOf } from "$lib/types/criteria";
import { dimensionKeyOf } from "$lib/types/grading";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeCategory(overrides?: Partial<Category>): Category {
	return {
		title: overrides?.title ?? "Test Category",
		additional_notes: overrides?.additional_notes ?? false,
		positive: overrides?.positive ?? [
			{ main_point: "Good", sub_points: [{ text: "did_well" }] },
		],
		neutral: overrides?.neutral ?? [{ main_point: "OK", sub_points: [{ text: "acceptable" }] }],
		negative: overrides?.negative ?? [
			{ main_point: "Bad", sub_points: [{ text: "needs_work" }] },
		],
	};
}

const TEST_RUBRIC: MergedRubric = {
	categories: [
		{
			key: categoryKeyOf("code_quality"),
			category: makeCategory({ title: "Code Quality" }),
		},
		{
			key: categoryKeyOf("documentation"),
			category: {
				title: "Documentation",
				additional_notes: true,
				positive: [{ main_point: "Docs", sub_points: [{ text: "well_documented" }] }],
				neutral: [],
				negative: [],
			},
		},
		{
			key: categoryKeyOf("specific_topic"),
			category: makeCategory({ title: "Specific Topic" }),
		},
	],
};

const TEST_CONFIG: GradingConfig = {
	dimensions: [
		{
			key: dimensionKeyOf("code_quality_design"),
			title: "Code Quality & Design",
			max_points: 6,
			weight: 4,
		},
		{ key: dimensionKeyOf("creativity"), title: "Creativity", max_points: 4, weight: 1 },
	],
	grade_boundaries: [
		{ min_percentage: 95, grade: 1.0, label: "excellent", us_equiv: "A+" },
		{ min_percentage: 50, grade: 4.0, label: "sufficient", us_equiv: "D" },
		{ min_percentage: 0, grade: 5.0, label: "fail", us_equiv: "F" },
	],
};

function makeSession(overrides?: Partial<ReviewSession>): ReviewSession {
	return {
		student_id: "2026SS_42",
		assignment_id: "atom_interaction",
		mode: "student",
		category_selections: {
			[categoryKeyOf("code_quality")]: {
				checked_items: new Set(["did_well"]),
				notes: "",
				comments: {},
				deductions: {},
			},
		} as Record<string, CategorySelections>,
		grading: {
			code_quality_design: 0,
			code_execution_results: 0,
			assignment_requirements: 0,
			scientific_programming: 0,
			creativity: 0,
		} as unknown as GradingInputs,
		generated_text: "",
		started_at: "2026-01-01T00:00:00.000Z",
		updated_at: "2026-01-02T00:00:00.000Z",
		...overrides,
	};
}

function makeGradeResult(percentage: number): GradeResult {
	const boundary =
		TEST_CONFIG.grade_boundaries.find((b) => b.min_percentage <= percentage) ??
		TEST_CONFIG.grade_boundaries[TEST_CONFIG.grade_boundaries.length - 1];
	return {
		dimensions: [
			{
				dimension: TEST_CONFIG.dimensions[0],
				score: 4,
				weighted_score: 16,
				weighted_max: 24,
				percentage: 66.7,
			},
			{
				dimension: TEST_CONFIG.dimensions[1],
				score: 2,
				weighted_score: 2,
				weighted_max: 4,
				percentage: 50,
			},
		],
		total_weighted: 18,
		total_weighted_max: 28,
		percentage,
		grade: boundary.grade,
		label: boundary.label,
		us_equiv: boundary.us_equiv,
		points_to_next_grade: null,
		points_above_boundary: percentage - boundary.min_percentage,
	};
}

// ---------------------------------------------------------------------------
// generateEvaluationText
// ---------------------------------------------------------------------------

describe("generateEvaluationText", () => {
	it("includes the student ID and assignment in output", () => {
		const session = makeSession({ student_id: "2026SS_99" });
		const text = generateEvaluationText(session, TEST_RUBRIC);
		expect(text).toContain("2026SS_99");
		expect(text).toContain("atom_interaction");
	});

	it("includes positive criteria when selected", () => {
		const session = makeSession({
			category_selections: {
				[categoryKeyOf("code_quality")]: {
					checked_items: new Set(["did_well"]),
					notes: "",
					comments: {},
					deductions: {},
				},
			} as Record<string, CategorySelections>,
		});
		const text = generateEvaluationText(session, TEST_RUBRIC);
		expect(text).toContain("Positive Observations");
		expect(text).toContain("did_well");
	});

	it("includes negative criteria when selected", () => {
		const session = makeSession({
			category_selections: {
				[categoryKeyOf("code_quality")]: {
					checked_items: new Set(["needs_work"]),
					notes: "",
					comments: {},
					deductions: {},
				},
			} as Record<string, CategorySelections>,
		});
		const text = generateEvaluationText(session, TEST_RUBRIC);
		expect(text).toContain("Areas for Improvement");
		expect(text).toContain("needs_work");
	});

	it("includes neutral criteria when selected", () => {
		const session = makeSession({
			category_selections: {
				[categoryKeyOf("code_quality")]: {
					checked_items: new Set(["acceptable"]),
					notes: "",
					comments: {},
					deductions: {},
				},
			} as Record<string, CategorySelections>,
		});
		const text = generateEvaluationText(session, TEST_RUBRIC);
		expect(text).toContain("General Observations");
		expect(text).toContain("acceptable");
	});

	it("handles empty selections gracefully", () => {
		const session = makeSession({ category_selections: {} });
		const text = generateEvaluationText(session, TEST_RUBRIC);
		expect(text).toContain("Evaluation for 2026SS_42");
		expect(text).not.toContain("## Positive Observations");
		expect(text).not.toContain("## General Observations");
		expect(text).not.toContain("## Areas for Improvement");
	});

	it("includes additional notes when provided", () => {
		const session = makeSession({
			category_selections: {
				[categoryKeyOf("documentation")]: {
					checked_items: new Set(["well_documented"]),
					notes: "Overall solid documentation",
					comments: {},
					deductions: {},
				},
			} as Record<string, CategorySelections>,
		});
		const text = generateEvaluationText(session, TEST_RUBRIC);
		expect(text).toContain("Additional Notes");
		expect(text).toContain("Overall solid documentation");
	});

	it("includes comments for checked items", () => {
		const session = makeSession({
			category_selections: {
				[categoryKeyOf("code_quality")]: {
					checked_items: new Set(["did_well"]),
					notes: "",
					comments: { did_well: "Excellent code structure" },
					deductions: {},
				},
			} as Record<string, CategorySelections>,
		});
		const text = generateEvaluationText(session, TEST_RUBRIC);
		expect(text).toContain("Excellent code structure");
	});

	it("includes deductions for checked items", () => {
		const session = makeSession({
			category_selections: {
				[categoryKeyOf("code_quality")]: {
					checked_items: new Set(["needs_work"]),
					notes: "",
					comments: {},
					deductions: { needs_work: 3 },
				},
			} as Record<string, CategorySelections>,
		});
		const text = generateEvaluationText(session, TEST_RUBRIC);
		expect(text).toContain("-3 points");
	});

	it("groups feedback by category within sentiment sections", () => {
		const session = makeSession({
			category_selections: {
				[categoryKeyOf("code_quality")]: {
					checked_items: new Set(["did_well"]),
					notes: "",
					comments: {},
					deductions: {},
				},
				[categoryKeyOf("specific_topic")]: {
					checked_items: new Set(["did_well"]),
					notes: "",
					comments: {},
					deductions: {},
				},
			} as Record<string, CategorySelections>,
		});
		const text = generateEvaluationText(session, TEST_RUBRIC);
		// Both categories should appear under "Positive Observations"
		const positiveIdx = text.indexOf("## Positive Observations");
		expect(positiveIdx).toBeGreaterThanOrEqual(0);
		expect(text).toContain("Code Quality");
		expect(text).toContain("Specific Topic");
	});
});

// ---------------------------------------------------------------------------
// generateEvaluationMarkdown
// ---------------------------------------------------------------------------

describe("generateEvaluationMarkdown", () => {
	it("includes YAML frontmatter with student and assignment info", () => {
		const session = makeSession();
		const result = makeGradeResult(75);
		const md = generateEvaluationMarkdown(session, TEST_RUBRIC, result);
		expect(md).toContain("---");
		expect(md).toContain('student_id: "2026SS_42"');
		expect(md).toContain('assignment: "atom_interaction"');
	});

	it("includes grade result in frontmatter", () => {
		const session = makeSession();
		const result = makeGradeResult(75);
		const md = generateEvaluationMarkdown(session, TEST_RUBRIC, result);
		expect(md).toContain("percentage:");
		expect(md).toContain("grade:");
		expect(md).toContain("label:");
	});

	it("includes dimension scores in frontmatter", () => {
		const session = makeSession();
		const result = makeGradeResult(75);
		const md = generateEvaluationMarkdown(session, TEST_RUBRIC, result);
		expect(md).toContain("code_quality_design:");
		expect(md).toContain("creativity:");
	});

	it("includes checked items as markdown checkboxes", () => {
		const session = makeSession({
			category_selections: {
				[categoryKeyOf("code_quality")]: {
					checked_items: new Set(["did_well"]),
					notes: "",
					comments: {},
					deductions: {},
				},
			} as Record<string, CategorySelections>,
		});
		const result = makeGradeResult(75);
		const md = generateEvaluationMarkdown(session, TEST_RUBRIC, result);
		expect(md).toContain("- [x] did_well");
	});

	it("includes comments as blockquotes", () => {
		const session = makeSession({
			category_selections: {
				[categoryKeyOf("code_quality")]: {
					checked_items: new Set(["did_well"]),
					notes: "",
					comments: { did_well: "Great work" },
					deductions: {},
				},
			} as Record<string, CategorySelections>,
		});
		const result = makeGradeResult(75);
		const md = generateEvaluationMarkdown(session, TEST_RUBRIC, result);
		expect(md).toContain("> Great work");
	});

	it("includes deductions in parentheses", () => {
		const session = makeSession({
			category_selections: {
				[categoryKeyOf("code_quality")]: {
					checked_items: new Set(["needs_work"]),
					notes: "",
					comments: {},
					deductions: { needs_work: 2 },
				},
			} as Record<string, CategorySelections>,
		});
		const result = makeGradeResult(75);
		const md = generateEvaluationMarkdown(session, TEST_RUBRIC, result);
		expect(md).toContain("(-2 points)");
	});

	it("includes additional notes section", () => {
		const session = makeSession({
			category_selections: {
				[categoryKeyOf("documentation")]: {
					checked_items: new Set(["well_documented"]),
					notes: "Good docs overall",
					comments: {},
					deductions: {},
				},
			} as Record<string, CategorySelections>,
		});
		const result = makeGradeResult(75);
		const md = generateEvaluationMarkdown(session, TEST_RUBRIC, result);
		expect(md).toContain("## Additional Notes");
		expect(md).toContain("Good docs overall");
	});
});

// ---------------------------------------------------------------------------
// generateEvaluation
// ---------------------------------------------------------------------------

describe("generateEvaluation", () => {
	it("produces an Evaluation object with correct student_id", () => {
		const session = makeSession();
		const result = makeGradeResult(75);
		const evaluation = generateEvaluation(session, TEST_RUBRIC, result, "Reviewer");
		expect(evaluation.student_id).toBe("2026SS_42");
	});

	it("produces an Evaluation object with correct assignment", () => {
		const session = makeSession();
		const result = makeGradeResult(75);
		const evaluation = generateEvaluation(session, TEST_RUBRIC, result, "Reviewer");
		expect(evaluation.assignment).toBe("atom_interaction");
	});

	it("includes reviewer name", () => {
		const session = makeSession();
		const result = makeGradeResult(75);
		const evaluation = generateEvaluation(session, TEST_RUBRIC, result, "Dr. Smith");
		expect(evaluation.reviewer).toBe("Dr. Smith");
	});

	it("includes feedback for categories with selections", () => {
		const session = makeSession({
			category_selections: {
				[categoryKeyOf("code_quality")]: {
					checked_items: new Set(["did_well", "needs_work"]),
					notes: "Mixed quality",
					comments: { did_well: "Nice" },
					deductions: { needs_work: 2 },
				},
			} as Record<string, CategorySelections>,
		});
		const result = makeGradeResult(75);
		const evaluation = generateEvaluation(session, TEST_RUBRIC, result, "Reviewer");
		const feedback = evaluation.feedback as Record<
			string,
			{
				checked: string[];
				comments: Record<string, string>;
				deductions: Record<string, number>;
				notes: string;
			}
		>;
		expect(feedback["code_quality"]).toBeDefined();
		expect(feedback["code_quality"].checked).toContain("did_well");
		expect(feedback["code_quality"].checked).toContain("needs_work");
		expect(feedback["code_quality"].notes).toBe("Mixed quality");
	});

	it("includes scores from grade result", () => {
		const session = makeSession();
		const result = makeGradeResult(75);
		const evaluation = generateEvaluation(session, TEST_RUBRIC, result, "Reviewer");
		expect(evaluation.scores).toBeDefined();
	});

	it("includes result with percentage, grade, and label", () => {
		const session = makeSession();
		const result = makeGradeResult(75);
		const evaluation = generateEvaluation(session, TEST_RUBRIC, result, "Reviewer");
		expect(evaluation.result.percentage).toBe(75);
		expect(evaluation.result.grade).toBeDefined();
		expect(evaluation.result.label).toBeDefined();
	});

	it("skips categories with no selections", () => {
		const session = makeSession({ category_selections: {} });
		const result = makeGradeResult(75);
		const evaluation = generateEvaluation(session, TEST_RUBRIC, result, "Reviewer");
		expect(Object.keys(evaluation.feedback)).toHaveLength(0);
	});
});
