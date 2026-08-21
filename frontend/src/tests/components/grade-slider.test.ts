/**
 * @file Smoke tests for grade-slider.svelte
 *
 * Tests rendering with value, min, max, label props,
 * slider input changes, and label display.
 */
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, screen } from "@testing-library/svelte";
import GradeSlider from "$lib/components/grade-slider.svelte";
import type { GradeDimension } from "$lib/types/grading";
import { dimensionKeyOf } from "$lib/types/grading";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TEST_DIMENSION: GradeDimension = {
	key: dimensionKeyOf("code_quality_design"),
	title: "Code Quality & Design",
	max_points: 6,
	weight: 4,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("grade-slider.svelte", () => {
	it("renders the dimension title as label", () => {
		render(GradeSlider, {
			dimension: TEST_DIMENSION,
			value: 3,
			onChange: vi.fn(),
		});

		expect(screen.getByText("Code Quality & Design")).toBeDefined();
	});

	it("displays current value and max points", () => {
		render(GradeSlider, {
			dimension: TEST_DIMENSION,
			value: 4,
			onChange: vi.fn(),
		});

		// Should show "4.0/6" somewhere in the rendered output
		expect(screen.getByText("4.0")).toBeDefined();
		expect(screen.getByText("/6")).toBeDefined();
	});

	it("fires onChange with correct value when slider changes", async () => {
		const onChange = vi.fn();

		render(GradeSlider, {
			dimension: TEST_DIMENSION,
			value: 3,
			onChange,
		});

		const slider = screen.getByRole("slider") as HTMLInputElement;
		expect(slider).not.toBeNull();

		// Simulate a change event on the slider
		await fireEvent.input(slider, { target: { value: "5" } });

		expect(onChange).toHaveBeenCalledWith("code_quality_design", 5);
	});

	it("renders with disabled prop", () => {
		render(GradeSlider, {
			dimension: TEST_DIMENSION,
			value: 3,
			disabled: true,
			onChange: vi.fn(),
		});

		const slider = screen.getByRole("slider") as HTMLInputElement;
		expect(slider).not.toBeNull();
	});

	it("displays contribution and max contribution text", () => {
		// value=3, weight=4 => contribution = 12
		// max_points=6, weight=4 => maxContribution = 24
		render(GradeSlider, {
			dimension: TEST_DIMENSION,
			value: 3,
			onChange: vi.fn(),
		});

		// The contribution is shown as "12" and "/24"
		expect(screen.getByText("12")).toBeDefined();
		expect(screen.getByText("/24")).toBeDefined();
	});

	it("slider has correct min and max attributes", () => {
		render(GradeSlider, {
			dimension: TEST_DIMENSION,
			value: 3,
			onChange: vi.fn(),
		});

		const slider = screen.getByRole("slider") as HTMLInputElement;
		expect(slider.min).toBe("0");
		expect(slider.max).toBe("6");
		expect(slider.step).toBe("0.5");
	});
});
