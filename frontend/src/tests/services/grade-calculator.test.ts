/**
 * @file Unit tests for grade-calculator.ts
 *
 * Tests weighted percentage calculation, grade boundary lookup,
 * deductions, edge cases, and default grading inputs.
 */
import { describe, it, expect } from "vitest";
import {
	calculateGrade,
	getGradeBoundary,
	defaultGradingInputsFromConfig,
} from "$lib/services/grade-calculator";
import type { GradingConfig, GradingInputs, GradeBoundary } from "$lib/types/grading";
import { dimensionKeyOf } from "$lib/types/grading";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** Standard grading config matching grading_config.yaml */
const TEST_CONFIG: GradingConfig = {
	dimensions: [
		{
			key: dimensionKeyOf("code_quality_design"),
			title: "Code Quality & Design",
			max_points: 6,
			weight: 4,
		},
		{
			key: dimensionKeyOf("code_execution_results"),
			title: "Code Execution & Results",
			max_points: 6,
			weight: 4,
		},
		{
			key: dimensionKeyOf("assignment_requirements"),
			title: "Assignment Requirements",
			max_points: 6,
			weight: 4,
		},
		{
			key: dimensionKeyOf("scientific_programming"),
			title: "Scientific Programming",
			max_points: 6,
			weight: 4,
		},
		{ key: dimensionKeyOf("creativity"), title: "Creativity", max_points: 4, weight: 1 },
	],
	grade_boundaries: [
		{ min_percentage: 95, grade: 1.0, label: "excellent", us_equiv: "A+" },
		{ min_percentage: 90, grade: 1.3, label: "very good+", us_equiv: "A" },
		{ min_percentage: 85, grade: 1.7, label: "very good", us_equiv: "A-" },
		{ min_percentage: 80, grade: 2.0, label: "good+", us_equiv: "B+" },
		{ min_percentage: 75, grade: 2.3, label: "good", us_equiv: "B" },
		{ min_percentage: 70, grade: 2.7, label: "good-", us_equiv: "B-" },
		{ min_percentage: 65, grade: 3.0, label: "satisfactory+", us_equiv: "C+" },
		{ min_percentage: 60, grade: 3.3, label: "satisfactory", us_equiv: "C" },
		{ min_percentage: 55, grade: 3.7, label: "satisfactory-", us_equiv: "C-" },
		{ min_percentage: 50, grade: 4.0, label: "sufficient", us_equiv: "D" },
		{ min_percentage: 0, grade: 5.0, label: "fail", us_equiv: "F" },
	],
};

const PERFECT_INPUTS: GradingInputs = {
	code_quality_design: 6,
	code_execution_results: 6,
	assignment_requirements: 6,
	scientific_programming: 6,
	creativity: 4,
};

const ZERO_INPUTS: GradingInputs = {
	code_quality_design: 0,
	code_execution_results: 0,
	assignment_requirements: 0,
	scientific_programming: 0,
	creativity: 0,
};

// ---------------------------------------------------------------------------
// calculateGrade
// ---------------------------------------------------------------------------

describe("calculateGrade", () => {
	it("returns 1.0 (excellent) for perfect scores across all dimensions", () => {
		const result = calculateGrade(PERFECT_INPUTS, TEST_CONFIG);
		expect(result.percentage).toBe(100);
		expect(result.grade).toBe(1.0);
		expect(result.label).toBe("excellent");
		expect(result.us_equiv).toBe("A+");
	});

	it("returns 5.0 (fail) for all zeros", () => {
		const result = calculateGrade(ZERO_INPUTS, TEST_CONFIG);
		expect(result.percentage).toBe(0);
		expect(result.grade).toBe(5.0);
		expect(result.label).toBe("fail");
		expect(result.us_equiv).toBe("F");
	});

	it("returns 4.0 (sufficient) at exactly 50% weighted total", () => {
		const half: GradingInputs = {
			code_quality_design: 3,
			code_execution_results: 3,
			assignment_requirements: 3,
			scientific_programming: 3,
			creativity: 2,
		};
		const result = calculateGrade(half, TEST_CONFIG);
		expect(result.percentage).toBe(50);
		expect(result.grade).toBe(4.0);
	});

	it("computes dimension-level weighted_score and percentage", () => {
		const inputs: GradingInputs = {
			code_quality_design: 3,
			code_execution_results: 6,
			assignment_requirements: 0,
			scientific_programming: 4,
			creativity: 1,
		};
		const result = calculateGrade(inputs, TEST_CONFIG);

		const cqd = result.dimensions.find((d) => d.dimension.key === "code_quality_design")!;
		expect(cqd.weighted_score).toBe(3 * 4);
		expect(cqd.percentage).toBe(50);

		const cer = result.dimensions.find((d) => d.dimension.key === "code_execution_results")!;
		expect(cer.weighted_score).toBe(6 * 4);
		expect(cer.percentage).toBe(100);

		const ar = result.dimensions.find((d) => d.dimension.key === "assignment_requirements")!;
		expect(ar.percentage).toBe(0);
	});

	it("clamps negative scores to 0", () => {
		const negative: GradingInputs = {
			code_quality_design: -5,
			code_execution_results: -1,
			assignment_requirements: 0,
			scientific_programming: 0,
			creativity: 0,
		};
		const result = calculateGrade(negative, TEST_CONFIG);
		expect(result.percentage).toBe(0);
		expect(result.grade).toBe(5.0);
	});

	it("clamps scores above max to max", () => {
		const overMax: GradingInputs = {
			code_quality_design: 100,
			code_execution_results: 6,
			assignment_requirements: 6,
			scientific_programming: 6,
			creativity: 4,
		};
		const result = calculateGrade(overMax, TEST_CONFIG);
		// code_quality_design should be clamped to 6
		expect(result.percentage).toBe(100);
	});

	it("computes total_weighted and total_weighted_max correctly", () => {
		const inputs: GradingInputs = {
			code_quality_design: 2,
			code_execution_results: 4,
			assignment_requirements: 1,
			scientific_programming: 5,
			creativity: 3,
		};
		const result = calculateGrade(inputs, TEST_CONFIG);
		// total_weighted = 2*4 + 4*4 + 1*4 + 5*4 + 3*1 = 8+16+4+20+3 = 51
		expect(result.total_weighted).toBe(51);
		// total_weighted_max = 6*4 + 6*4 + 6*4 + 6*4 + 4*1 = 24+24+24+24+4 = 100
		expect(result.total_weighted_max).toBe(100);
	});

	it("applies deductions to reduce percentage", () => {
		const result = calculateGrade(PERFECT_INPUTS, TEST_CONFIG, 10);
		expect(result.percentage).toBe(90);
		expect(result.grade).toBe(1.3);
	});

	it("does not let deductions push percentage below 0", () => {
		const result = calculateGrade(ZERO_INPUTS, TEST_CONFIG, 50);
		expect(result.percentage).toBe(0);
	});

	it("computes points_to_next_grade as null at grade 1.0 (top)", () => {
		const result = calculateGrade(PERFECT_INPUTS, TEST_CONFIG);
		expect(result.points_to_next_grade).toBeNull();
	});

	it("computes points_to_next_grade from 0% to 50% boundary", () => {
		const result = calculateGrade(ZERO_INPUTS, TEST_CONFIG);
		expect(result.points_to_next_grade).toBe(50);
	});

	it("computes points_above_boundary correctly", () => {
		// 75% should be at the 2.3 boundary (min_percentage: 75)
		const inputs: GradingInputs = {
			code_quality_design: 4.5,
			code_execution_results: 4.5,
			assignment_requirements: 4.5,
			scientific_programming: 4.5,
			creativity: 3,
		};
		const result = calculateGrade(inputs, TEST_CONFIG);
		expect(result.percentage).toBe(75);
		expect(result.points_above_boundary).toBe(0);
	});

	it("handles missing dimension keys gracefully (defaults to 0)", () => {
		const partial: Record<string, number> = {
			code_quality_design: 6,
			code_execution_results: 6,
			assignment_requirements: 6,
			scientific_programming: 6,
			// creativity missing — should default to 0
		};
		const result = calculateGrade(partial as unknown as GradingInputs, TEST_CONFIG);
		// creativity defaults to 0, so percentage < 100
		expect(result.percentage).toBeLessThan(100);
	});
});

// ---------------------------------------------------------------------------
// getGradeBoundary
// ---------------------------------------------------------------------------

describe("getGradeBoundary", () => {
	it("returns 1.0 for 100%", () => {
		const boundary = getGradeBoundary(100, TEST_CONFIG.grade_boundaries);
		expect(boundary.grade).toBe(1.0);
	});

	it("returns 5.0 for 0%", () => {
		const boundary = getGradeBoundary(0, TEST_CONFIG.grade_boundaries);
		expect(boundary.grade).toBe(5.0);
	});

	it("returns 2.3 for 75%", () => {
		const boundary = getGradeBoundary(75, TEST_CONFIG.grade_boundaries);
		expect(boundary.grade).toBe(2.3);
	});

	it("returns 1.3 for 92%", () => {
		const boundary = getGradeBoundary(92, TEST_CONFIG.grade_boundaries);
		expect(boundary.grade).toBe(1.3);
	});

	it("returns 4.0 for exactly 50%", () => {
		const boundary = getGradeBoundary(50, TEST_CONFIG.grade_boundaries);
		expect(boundary.grade).toBe(4.0);
	});

	it("returns 5.0 for 49% (below all thresholds except 0)", () => {
		const boundary = getGradeBoundary(49, TEST_CONFIG.grade_boundaries);
		expect(boundary.grade).toBe(5.0);
	});

	it("returns the lowest boundary as fallback for negative percentages", () => {
		const boundary = getGradeBoundary(-10, TEST_CONFIG.grade_boundaries);
		expect(boundary.grade).toBe(5.0);
	});

	it("works with a minimal boundary list", () => {
		const minimal: GradeBoundary[] = [
			{ min_percentage: 50, grade: 4.0, label: "pass", us_equiv: "D" },
			{ min_percentage: 0, grade: 5.0, label: "fail", us_equiv: "F" },
		];
		expect(getGradeBoundary(75, minimal).grade).toBe(4.0);
		expect(getGradeBoundary(30, minimal).grade).toBe(5.0);
	});
});

// ---------------------------------------------------------------------------
// defaultGradingInputsFromConfig
// ---------------------------------------------------------------------------

describe("defaultGradingInputsFromConfig", () => {
	it("creates inputs with all dimensions set to 0", () => {
		const inputs = defaultGradingInputsFromConfig(TEST_CONFIG);
		for (const dim of TEST_CONFIG.dimensions) {
			expect(inputs[dim.key as keyof GradingInputs]).toBe(0);
		}
	});

	it("includes all dimension keys from the config", () => {
		const inputs = defaultGradingInputsFromConfig(TEST_CONFIG);
		const inputKeys = Object.keys(inputs);
		const configKeys = TEST_CONFIG.dimensions.map((d) => d.key);
		expect(inputKeys.sort()).toEqual(configKeys.sort());
	});
});
