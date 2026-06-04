/**
 * @file Unit tests for session-persistence.ts
 *
 * Tests serialization, deserialization, YAML/JSON export/import,
 * file download, and format detection.
 */
import { describe, it, expect, vi } from "vitest";
import {
	serializeSession,
	deserializeSession,
	exportAsYaml,
	exportAsMarkdown,
	exportSession,
	parseYamlImport,
	parseJsonImport,
	parseImport,
	downloadFile,
} from "$lib/services/session-persistence";
import type { ReviewSession, CategorySelections } from "$lib/types/session";
import type { MergedRubric } from "$lib/types/criteria";
import type { GradingConfig, GradeResult } from "$lib/types/grading";
import { categoryKeyOf } from "$lib/types/criteria";
import { dimensionKeyOf } from "$lib/types/grading";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeSession(overrides?: Partial<ReviewSession>): ReviewSession {
	return {
		student_id: "2026SS_42",
		assignment_id: "atom_interaction",
		mode: "student",
		category_selections: {
			[categoryKeyOf("code_quality")]: {
				checked_items: new Set(["did_well", "needs_work"]),
				notes: "Mixed quality",
				comments: { did_well: "Nice work" },
				deductions: { needs_work: 2 },
			},
		} as Record<string, any>, // eslint-disable-line @typescript-eslint/no-explicit-any
		grading: {
			code_quality_design: 4,
			code_execution_results: 5,
			assignment_requirements: 3,
			scientific_programming: 4,
			creativity: 2,
		} as unknown as import("$lib/types/grading").GradingInputs,
		generated_text: "Evaluation text here",
		started_at: "2026-01-01T00:00:00.000Z",
		updated_at: "2026-01-02T00:00:00.000Z",
		...overrides,
	};
}

const TEST_RUBRIC: MergedRubric = {
	categories: [
		{
			key: categoryKeyOf("code_quality"),
			category: {
				title: "Code Quality",
				additional_notes: true,
				positive: [{ main_point: "Good", sub_points: [{ text: "did_well" }] }],
				neutral: [],
				negative: [
					{
						main_point: "Bad",
						sub_points: [{ text: "needs_work", point_deduction: true }],
					},
				],
			},
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

const TEST_RESULT: GradeResult = {
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
	percentage: 64.3,
	grade: 2.7,
	label: "good-",
	us_equiv: "B-",
	points_to_next_grade: 0.7,
	points_above_boundary: 14.3,
};

// ---------------------------------------------------------------------------
// serializeSession / deserializeSession
// ---------------------------------------------------------------------------

describe("serializeSession", () => {
	it("produces valid JSON from a ReviewSession", () => {
		const session = makeSession();
		const json = serializeSession(session);
		const parsed = JSON.parse(json);
		expect(parsed.student_id).toBe("2026SS_42");
		expect(parsed.assignment_id).toBe("atom_interaction");
	});

	it("converts Set to Array in serialization", () => {
		const session = makeSession();
		const json = serializeSession(session);
		const parsed = JSON.parse(json);
		const checkedItems = (parsed.category_selections as Record<string, any>)["code_quality"] // eslint-disable-line @typescript-eslint/no-explicit-any
			.checked_items;
		expect(Array.isArray(checkedItems)).toBe(true);
		expect(checkedItems).toContain("did_well");
		expect(checkedItems).toContain("needs_work");
	});
});

describe("deserializeSession", () => {
	it("round-trips: serialize → deserialize preserves state", () => {
		const original = makeSession();
		const json = serializeSession(original);
		const restored = deserializeSession(json);
		expect(restored).not.toBeNull();
		expect(restored!.student_id).toBe(original.student_id);
		expect(restored!.assignment_id).toBe(original.assignment_id);
		expect(restored!.mode).toBe(original.mode);
	});

	it("converts Array back to Set in deserialization", () => {
		const original = makeSession();
		const json = serializeSession(original);
		const restored = deserializeSession(json);
		const checkedItems = (restored!.category_selections as Record<string, any>)["code_quality"] // eslint-disable-line @typescript-eslint/no-explicit-any
			.checked_items;
		expect(checkedItems).toBeInstanceOf(Set);
		expect(checkedItems.has("did_well")).toBe(true);
		expect(checkedItems.has("needs_work")).toBe(true);
	});

	it("returns null for invalid JSON", () => {
		const result = deserializeSession("not valid json {{{");
		expect(result).toBeNull();
	});

	it("preserves comments and deductions", () => {
		const original = makeSession();
		const json = serializeSession(original);
		const restored = deserializeSession(json);
		expect(
			(restored!.category_selections as Record<string, any>)["code_quality"].comments, // eslint-disable-line @typescript-eslint/no-explicit-any
		).toEqual({
			did_well: "Nice work",
		});
		expect(
			(restored!.category_selections as Record<string, any>)["code_quality"].deductions, // eslint-disable-line @typescript-eslint/no-explicit-any
		).toEqual({
			needs_work: 2,
		});
	});
});

// ---------------------------------------------------------------------------
// exportAsYaml
// ---------------------------------------------------------------------------

describe("exportAsYaml", () => {
	it("produces valid YAML with student_id", () => {
		const session = makeSession();
		const yaml = exportAsYaml(session, TEST_RUBRIC, TEST_RESULT, "Reviewer");
		expect(yaml).toContain("2026SS_42");
		expect(yaml).toContain("atom_interaction");
	});

	it("includes feedback section", () => {
		const session = makeSession();
		const yaml = exportAsYaml(session, TEST_RUBRIC, TEST_RESULT, "Reviewer");
		expect(yaml).toContain("feedback");
	});

	it("includes scores section", () => {
		const session = makeSession();
		const yaml = exportAsYaml(session, TEST_RUBRIC, TEST_RESULT, "Reviewer");
		expect(yaml).toContain("scores");
	});
});

// ---------------------------------------------------------------------------
// exportAsMarkdown
// ---------------------------------------------------------------------------

describe("exportAsMarkdown", () => {
	it("produces Markdown with YAML frontmatter", () => {
		const session = makeSession();
		const md = exportAsMarkdown(session, TEST_RUBRIC, TEST_RESULT);
		expect(md).toContain("---");
		expect(md).toContain('student_id: "2026SS_42"');
	});

	it("includes checked items as checkboxes", () => {
		const session = makeSession();
		const md = exportAsMarkdown(session, TEST_RUBRIC, TEST_RESULT);
		expect(md).toContain("- [x] did_well");
	});
});

// ---------------------------------------------------------------------------
// exportSession
// ---------------------------------------------------------------------------

describe("exportSession", () => {
	it("exports as YAML when format is 'yaml'", () => {
		const session = makeSession();
		const result = exportSession(session, TEST_RUBRIC, TEST_RESULT, "yaml", "Reviewer");
		expect(result).toContain("student_id");
	});

	it("exports as Markdown when format is 'md'", () => {
		const session = makeSession();
		const result = exportSession(session, TEST_RUBRIC, TEST_RESULT, "md", "Reviewer");
		expect(result).toContain("---");
	});

	it("exports as JSON when format is 'json'", () => {
		const session = makeSession();
		const result = exportSession(session, TEST_RUBRIC, TEST_RESULT, "json", "Reviewer");
		const parsed = JSON.parse(result);
		expect(parsed.student_id).toBe("2026SS_42");
	});

	it("throws for unknown format", () => {
		const session = makeSession();
		expect(() =>
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			exportSession(session, TEST_RUBRIC, TEST_RESULT, "csv" as any, "Reviewer"),
		).toThrow("Unknown export format");
	});
});

// ---------------------------------------------------------------------------
// parseYamlImport
// ---------------------------------------------------------------------------

describe("parseYamlImport", () => {
	it("parses a valid v2 YAML evaluation", () => {
		const yaml = `
student_id: "2026SS_42"
assignment: "atom_interaction"
reviewer: "Dr. Smith"
date: "2026-01-15"
scores:
  code_quality_design: 4
  creativity: 2
feedback:
  code_quality:
    checked:
      - did_well
    comments:
      did_well: "Nice work"
    deductions: {}
    notes: ""
result:
  percentage: 75
  grade: 2.3
  label: "good"
`;
		const session = parseYamlImport(yaml);
		expect(session).not.toBeNull();
		expect(session!.student_id).toBe("2026SS_42");
		expect(session!.assignment_id).toBe("atom_interaction");
	});

	it("returns null for YAML without feedback key", () => {
		const yaml = `
student_id: "2026SS_42"
assignment: "atom_interaction"
`;
		const result = parseYamlImport(yaml);
		expect(result).toBeNull();
	});

	it("returns null for invalid YAML", () => {
		const result = parseYamlImport("{{invalid yaml {{{");
		expect(result).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// parseJsonImport
// ---------------------------------------------------------------------------

describe("parseJsonImport", () => {
	it("parses a valid v2 JSON evaluation", () => {
		const data = {
			student_id: "2026SS_42",
			assignment: "atom_interaction",
			reviewer: "Dr. Smith",
			date: "2026-01-15",
			scores: { code_quality_design: 4 },
			feedback: {
				code_quality: {
					checked: ["did_well"],
					comments: {},
					deductions: {},
					notes: "",
				},
			},
		};
		const json = JSON.stringify(data);
		const session = parseJsonImport(json);
		expect(session).not.toBeNull();
		expect(session!.student_id).toBe("2026SS_42");
	});

	it("parses a valid v1 JSON session (with category_selections)", () => {
		const data = {
			student_id: "2026SS_42",
			assignment_id: "atom_interaction",
			mode: "student",
			category_selections: {
				code_quality: {
					checked_items: ["did_well"],
					notes: "",
					comments: {},
					deductions: {},
				},
			},
			grading: { code_quality_design: 4 },
			generated_text: "",
			started_at: "2026-01-01T00:00:00.000Z",
			updated_at: "2026-01-02T00:00:00.000Z",
		};
		const json = JSON.stringify(data);
		const session = parseJsonImport(json);
		expect(session).not.toBeNull();
		expect(session!.student_id).toBe("2026SS_42");
		expect(
			(session!.category_selections as Record<string, CategorySelections>)["code_quality"]
				.checked_items,
		).toBeInstanceOf(Set);
	});

	it("returns null for JSON without feedback or category_selections", () => {
		const data = { student_id: "2026SS_42", random_key: "value" };
		const json = JSON.stringify(data);
		const result = parseJsonImport(json);
		expect(result).toBeNull();
	});

	it("returns null for invalid JSON", () => {
		const result = parseJsonImport("not valid json {{{");
		expect(result).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// parseImport (format detection)
// ---------------------------------------------------------------------------

describe("parseImport", () => {
	it("detects .yaml extension and uses YAML parser", () => {
		const yaml = `
student_id: "2026SS_42"
assignment: "atom_interaction"
scores:
  code_quality_design: 4
feedback:
  code_quality:
    checked:
      - did_well
    comments: {}
    deductions: {}
    notes: ""
`;
		const session = parseImport(yaml, "evaluation.yaml");
		expect(session).not.toBeNull();
		expect(session!.student_id).toBe("2026SS_42");
	});

	it("detects .yml extension and uses YAML parser", () => {
		const yaml = `
student_id: "2026SS_42"
assignment: "atom_interaction"
scores:
  code_quality_design: 4
feedback:
  code_quality:
    checked:
      - did_well
    comments: {}
    deductions: {}
    notes: ""
`;
		const session = parseImport(yaml, "evaluation.yml");
		expect(session).not.toBeNull();
	});

	it("detects .json extension and uses JSON parser", () => {
		const data = {
			student_id: "2026SS_42",
			assignment_id: "atom_interaction",
			mode: "student",
			category_selections: {
				code_quality: {
					checked_items: ["did_well"],
					notes: "",
					comments: {},
					deductions: {},
				},
			},
			grading: { code_quality_design: 4 },
			generated_text: "",
			started_at: "2026-01-01T00:00:00.000Z",
			updated_at: "2026-01-02T00:00:00.000Z",
		};
		const json = JSON.stringify(data);
		const session = parseImport(json, "evaluation.json");
		expect(session).not.toBeNull();
	});

	it("returns null for unsupported file extensions", () => {
		const result = parseImport("some content", "evaluation.csv");
		expect(result).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// downloadFile
// ---------------------------------------------------------------------------

describe("downloadFile", () => {
	it("creates a download link and triggers download", () => {
		const clickMock = vi.fn();
		const removeChildMock = vi.fn();

		const mockLink = {
			href: "",
			download: "",
			click: clickMock,
			style: {},
		};

		const mockBody = {
			appendChild: vi.fn(),
			removeChild: removeChildMock,
		};

		// Mock document methods
		const originalCreateElement = document.createElement;
		const originalCreateObjectURL = globalThis.URL.createObjectURL;
		const originalRevokeObjectURL = globalThis.URL.revokeObjectURL;

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		vi.spyOn(document, "createElement").mockReturnValue(mockLink as any);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		vi.spyOn(document, "body", "get").mockReturnValue(mockBody as any);
		globalThis.URL.createObjectURL = vi.fn(() => "blob:http://localhost/fake");
		globalThis.URL.revokeObjectURL = vi.fn();

		downloadFile("test content", "test.yaml", "text/yaml");

		expect(clickMock).toHaveBeenCalled();
		expect(mockLink.download).toBe("test.yaml");

		// Restore
		document.createElement = originalCreateElement;
		Object.defineProperty(document, "body", { value: originalCreateObjectURL, writable: true });
		globalThis.URL.createObjectURL = originalCreateObjectURL;
		globalThis.URL.revokeObjectURL = originalRevokeObjectURL;
		vi.restoreAllMocks();
	});
});
