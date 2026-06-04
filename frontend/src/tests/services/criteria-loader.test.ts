/**
 * @file Unit tests for criteria-loader.ts
 *
 * Tests YAML loading, merging, caching, and error handling.
 * Uses mocked fetch to avoid network requests.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
	loadAssignments,
	getEnabledAssignments,
	loadCriteriaForAssignment,
	getCriteriaForAssignment,
	clearCache,
} from "$lib/services/criteria-loader";

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const MOCK_ASSIGNMENTS_YAML = `
assignments:
  - id: atom_interaction
    title: "Atom Interaction"
    enabled: true
    criteria_files:
      - "data/criteria/general.yaml"
      - "data/criteria/atom_interaction.yaml"
    dimensions:
      - code_quality_design
      - code_execution_results
      - assignment_requirements
      - scientific_programming
      - creativity
  - id: molecular_dynamics
    title: "Molecular Dynamics"
    enabled: true
    criteria_files:
      - "data/criteria/general.yaml"
      - "data/criteria/molecular_dynamics.yaml"
    dimensions:
      - code_quality_design
      - code_execution_results
      - assignment_requirements
      - scientific_programming
      - creativity
  - id: disabled_assignment
    title: "Disabled Assignment"
    enabled: false
    criteria_files:
      - "data/criteria/general.yaml"
    dimensions:
      - code_quality_design
`;

const MOCK_GENERAL_YAML = `
categories:
  code_formatting:
    title: "Code Formatting"
    additional_notes: false
    positive:
      - main_point: "Good formatting"
        sub_points:
          - text: "consistent_indentation"
          - text: "proper_naming"
    neutral:
      - main_point: "Acceptable formatting"
        sub_points:
          - text: "acceptable_style"
    negative:
      - main_point: "Poor formatting"
        sub_points:
          - text: "inconsistent_style"
`;

const MOCK_ATOM_YAML = `
categories:
  atom_interaction_basics:
    title: "Atom Interaction Basics"
    additional_notes: true
    positive:
      - main_point: "Good understanding"
        sub_points:
          - text: "correct_force_calculation"
    neutral:
      - main_point: "Acceptable understanding"
        sub_points:
          - text: "partial_understanding"
    negative:
      - main_point: "Poor understanding"
        sub_points:
          - text: "wrong_force_calculation"
`;

// ---------------------------------------------------------------------------
// Mock fetch
// ---------------------------------------------------------------------------

function mockFetch(urlMap: Record<string, string>) {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
		const url =
			typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		for (const [path, content] of Object.entries(urlMap)) {
			if (url.endsWith(path) || url.includes(path)) {
				return new Response(content, {
					status: 200,
					headers: { "Content-Type": "text/yaml" },
				});
			}
		}
		return new Response("Not Found", { status: 404 });
	}) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
	return () => {
		globalThis.fetch = originalFetch;
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
	clearCache();
});

describe("loadAssignments", () => {
	it("loads and parses assignments.yaml", async () => {
		const restore = mockFetch({
			"data/assignments.yaml": MOCK_ASSIGNMENTS_YAML,
		});

		const registry = await loadAssignments();
		expect(registry).not.toBeNull();
		expect(registry!.assignments).toHaveLength(3);
		expect(registry!.assignments[0].id).toBe("atom_interaction");
		expect(registry!.assignments[0].enabled).toBe(true);

		restore();
	});

	it("caches assignments after first load", async () => {
		const restore = mockFetch({
			"data/assignments.yaml": MOCK_ASSIGNMENTS_YAML,
		});

		await loadAssignments();
		await loadAssignments(); // Second call should use cache

		// fetch should only be called once (second call uses cache)
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);

		restore();
	});

	it("returns null on fetch failure", async () => {
		const restore = mockFetch({}); // No URLs mapped

		const result = await loadAssignments();
		expect(result).toBeNull();

		restore();
	});

	it("returns null on invalid YAML", async () => {
		// js-yaml is lenient, so test with missing 'assignments' key
		const restore = mockFetch({
			"data/assignments.yaml": "something_else: true",
		});

		const result = await loadAssignments();
		expect(result).toBeNull();

		restore();
	});
});

describe("getEnabledAssignments", () => {
	it("returns only enabled assignments", async () => {
		const restore = mockFetch({
			"data/assignments.yaml": MOCK_ASSIGNMENTS_YAML,
		});

		const enabled = await getEnabledAssignments();
		expect(enabled).toHaveLength(2);
		expect(enabled.every((a) => a.enabled)).toBe(true);

		restore();
	});

	it("returns empty array on fetch failure", async () => {
		const restore = mockFetch({}); // No URLs mapped

		const enabled = await getEnabledAssignments();
		expect(enabled).toEqual([]);

		restore();
	});
});

describe("loadCriteriaForAssignment", () => {
	it("loads and merges criteria files", async () => {
		const restore = mockFetch({
			"data/criteria/general.yaml": MOCK_GENERAL_YAML,
			"data/criteria/atom_interaction.yaml": MOCK_ATOM_YAML,
		});

		const rubric = await loadCriteriaForAssignment("atom_interaction", [
			"data/criteria/general.yaml",
			"data/criteria/atom_interaction.yaml",
		]);

		expect(rubric).not.toBeNull();
		expect(rubric!.categories.length).toBe(2);
		expect(rubric!.categories[0].category.title).toBe("Code Formatting");
		expect(rubric!.categories[1].category.title).toBe("Atom Interaction Basics");

		restore();
	});

	it("caches rubrics after first load", async () => {
		const restore = mockFetch({
			"data/criteria/general.yaml": MOCK_GENERAL_YAML,
			"data/criteria/atom_interaction.yaml": MOCK_ATOM_YAML,
		});

		await loadCriteriaForAssignment("atom_interaction", [
			"data/criteria/general.yaml",
			"data/criteria/atom_interaction.yaml",
		]);
		await loadCriteriaForAssignment("atom_interaction", [
			"data/criteria/general.yaml",
			"data/criteria/atom_interaction.yaml",
		]);

		// Criteria files should only be fetched once (second call uses cache)
		expect(globalThis.fetch).toHaveBeenCalledTimes(2); // general + atom

		restore();
	});

	it("returns null when all criteria files fail to load", async () => {
		const restore = mockFetch({}); // No URLs mapped

		const rubric = await loadCriteriaForAssignment("atom_interaction", [
			"data/criteria/nonexistent.yaml",
		]);

		expect(rubric).not.toBeNull(); // Returns empty rubric, not null
		expect(rubric!.categories).toEqual([]);

		restore();
	});

	it("preserves order of criteria files (general first, then specific)", async () => {
		const restore = mockFetch({
			"data/criteria/general.yaml": MOCK_GENERAL_YAML,
			"data/criteria/atom_interaction.yaml": MOCK_ATOM_YAML,
		});

		const rubric = await loadCriteriaForAssignment("atom_interaction", [
			"data/criteria/general.yaml",
			"data/criteria/atom_interaction.yaml",
		]);

		expect(rubric!.categories[0].category.title).toBe("Code Formatting");
		expect(rubric!.categories[1].category.title).toBe("Atom Interaction Basics");

		restore();
	});
});

describe("getCriteriaForAssignment", () => {
	it("loads criteria by assignment ID", async () => {
		const restore = mockFetch({
			"data/assignments.yaml": MOCK_ASSIGNMENTS_YAML,
			"data/criteria/general.yaml": MOCK_GENERAL_YAML,
			"data/criteria/atom_interaction.yaml": MOCK_ATOM_YAML,
		});

		const rubric = await getCriteriaForAssignment("atom_interaction");
		expect(rubric).not.toBeNull();
		expect(rubric!.categories.length).toBeGreaterThan(0);

		restore();
	});

	it("returns null for unknown assignment ID", async () => {
		const restore = mockFetch({
			"data/assignments.yaml": MOCK_ASSIGNMENTS_YAML,
		});

		const rubric = await getCriteriaForAssignment("nonexistent");
		expect(rubric).toBeNull();

		restore();
	});
});

describe("clearCache", () => {
	it("clears all cached data", async () => {
		const restore = mockFetch({
			"data/assignments.yaml": MOCK_ASSIGNMENTS_YAML,
		});

		await loadAssignments();
		clearCache();

		// After clearing, fetch should be called again
		await loadAssignments();
		expect(globalThis.fetch).toHaveBeenCalledTimes(2);

		restore();
	});
});
