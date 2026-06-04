/**
 * @file Unit tests for utils.ts
 *
 * Tests grade mapping, formatting helpers, and filename generation.
 */
import { describe, it, expect } from "vitest";
import {
	germanGradeFromPercentage,
	isNearGradeBoundary,
	formatFileSize,
	generateFilename,
} from "$lib/utils";

// ---------------------------------------------------------------------------
// germanGradeFromPercentage
// ---------------------------------------------------------------------------

describe("germanGradeFromPercentage", () => {
	it("returns 1.0 / A+ for 100%", () => {
		const result = germanGradeFromPercentage(100);
		expect(result.grade).toBe("1.0");
		expect(result.us).toBe("A+");
	});

	it("returns 5.0 / F for 0%", () => {
		const result = germanGradeFromPercentage(0);
		expect(result.grade).toBe("5.0");
		expect(result.us).toBe("F");
	});

	it("returns 4.0 / D+ for exactly 50%", () => {
		const result = germanGradeFromPercentage(50);
		expect(result.grade).toBe("4.0");
		expect(result.us).toBe("D+");
	});

	it("returns 2.3 / B for 75%", () => {
		const result = germanGradeFromPercentage(75);
		expect(result.grade).toBe("2.3");
		expect(result.us).toBe("B");
	});

	it("returns 5.0 / F for percentages below 40%", () => {
		const result = germanGradeFromPercentage(30);
		expect(result.grade).toBe("5.0");
		expect(result.us).toBe("F");
	});

	it("returns 1.3 / A for 92%", () => {
		const result = germanGradeFromPercentage(92);
		expect(result.grade).toBe("1.3");
		expect(result.us).toBe("A");
	});
});

// ---------------------------------------------------------------------------
// isNearGradeBoundary
// ---------------------------------------------------------------------------

describe("isNearGradeBoundary", () => {
	it("returns near=true when within 2 points of next boundary", () => {
		// 48% is within 2 points of the 50% boundary (4.0 / D+)
		const result = isNearGradeBoundary(48);
		expect(result.near).toBe(true);
		expect(result.target).toBeTruthy();
	});

	it("returns near=false when far from any boundary", () => {
		// 70% is at the 2.7 boundary, not within 2 points of the next (75%)
		const result = isNearGradeBoundary(70);
		// 70% is exactly at 2.7 boundary, 5 points away from 75%
		expect(result.near).toBe(false);
	});

	it("returns near=false at 100% (no higher boundary)", () => {
		const result = isNearGradeBoundary(100);
		expect(result.near).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// formatFileSize
// ---------------------------------------------------------------------------

describe("formatFileSize", () => {
	it("formats bytes", () => {
		expect(formatFileSize(256)).toBe("256 B");
	});

	it("formats kilobytes", () => {
		expect(formatFileSize(1536)).toBe("1.5 KB");
	});

	it("formats megabytes", () => {
		expect(formatFileSize(1572864)).toBe("1.5 MB");
	});

	it("formats 0 bytes", () => {
		expect(formatFileSize(0)).toBe("0 B");
	});
});

// ---------------------------------------------------------------------------
// generateFilename
// ---------------------------------------------------------------------------

describe("generateFilename", () => {
	it("generates YAML filename", () => {
		const filename = generateFilename("2026SS_42", "atom_interaction", "yaml");
		expect(filename).toBe("2026SS_42_atom_interaction_eval.yaml");
	});

	it("generates Markdown filename", () => {
		const filename = generateFilename("2026SS_42", "atom_interaction", "md");
		expect(filename).toBe("2026SS_42_atom_interaction_eval.md");
	});

	it("generates JSON filename", () => {
		const filename = generateFilename("2026SS_42", "atom_interaction", "json");
		expect(filename).toBe("2026SS_42_atom_interaction_eval.json");
	});

	it("sanitizes assignment name to lowercase snake_case", () => {
		const filename = generateFilename("2026SS_42", "Atom Interaction", "yaml");
		expect(filename).toBe("2026SS_42_atom_interaction_eval.yaml");
	});

	it("removes trailing underscores from sanitized name", () => {
		const filename = generateFilename("2026SS_42", "Atom Interaction!", "yaml");
		expect(filename).toBe("2026SS_42_atom_interaction_eval.yaml");
	});
});
