// @vitest-environment node
/**
 * @file D1+D2 tests — optional `dimensions` attribution on criteria.
 *
 * Covers:
 *   - round-trip through toEditableMainPoint/fromServerCategories/
 *     toServerCategories (dimensions preserved; empty arrays omitted on
 *     save so legacy YAML stays byte-stable)
 *   - resolveSubPointDimensions / resolveEditableSubPointDimensions:
 *     override ?? group ?? [] with NO merge
 *   - validateCriteriaYaml soft enforcement: malformed shapes always
 *     rejected; unknown keys rejected only when grading_config.yaml loads
 *     (temp DATA_DIR); membership check skipped when the file is missing.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as yaml from "js-yaml";

import {
	emptyMainPoint,
	emptySubPoint,
	fromServerCategories,
	resolveEditableSubPointDimensions,
	toServerCategories,
	type EditableMainPoint,
	type EditableSubPoint,
} from "$lib/components/assignments/criteria-editor-model";
import { resolveSubPointDimensions, type MainPoint, type SubPoint } from "$lib/types/criteria";
import { CriteriaValidationError, validateCriteriaYaml } from "$lib/server/criteria";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const KNOWN_DIMENSIONS = [
	"code_quality_design",
	"code_execution_results",
	"assignment_requirements",
	"scientific_programming",
	"creativity",
];

const GRADING_YAML = `dimensions:
  - key: code_quality_design
    title: Code Quality & Design
    max_points: 6
    weight: 4
  - key: code_execution_results
    title: Code Execution & Results
    max_points: 6
    weight: 4
  - key: assignment_requirements
    title: Assignment Requirements
    max_points: 6
    weight: 4
  - key: scientific_programming
    title: Scientific Programming
    max_points: 6
    weight: 4
  - key: creativity
    title: Creativity
    max_points: 4
    weight: 1

grade_boundaries:
  - min_percentage: 95
    grade: 1.0
    label: excellent
    us_equiv: A+
`;

/** A minimal valid criteria document with NO dimensions anywhere. */
const PLAIN_YAML = `categories:
  pandas:
    title: Pandas
    additional_notes: true
    positive:
      - main_point: Good pandas usage
        sub_points:
          - text: correct_dataframe_ops
    neutral: []
    negative: []
`;

/** Wrap a categories map as YAML text (what the save routes hand the validator). */
function docYaml(categories: Record<string, unknown>): string {
	return yaml.dump({ categories });
}

// ---------------------------------------------------------------------------
// Setup: isolated DATA_DIR per test (grading-config-dependent cases)
// ---------------------------------------------------------------------------

let dataDir: string | null = null;

/** Point DATA_DIR at a fresh temp dir; optionally seed grading_config.yaml. */
async function useTempDataDir(withGradingConfig: boolean): Promise<void> {
	dataDir = await mkdtemp(path.join(tmpdir(), "criteria-dimensions-"));
	vi.stubEnv("DATA_DIR", dataDir);
	if (withGradingConfig) {
		await writeFile(path.join(dataDir, "grading_config.yaml"), GRADING_YAML);
	}
}

beforeEach(() => {
	// No DATA_DIR by default: malformed-shape cases must be environment-free,
	// and grading-config-missing cases need a temp dir with NO config file.
	vi.unstubAllEnvs();
});

afterEach(async () => {
	vi.unstubAllEnvs();
	if (dataDir) {
		await rm(dataDir, { recursive: true, force: true });
		dataDir = null;
	}
});

// ---------------------------------------------------------------------------
// D1 — editable model round-trip + resolvers
// ---------------------------------------------------------------------------

describe("criteria editor model — dimensions round-trip", () => {
	it("preserves dimensions through fromServerCategories → toServerCategories", () => {
		const categories = {
			pandas: {
				title: "Pandas",
				additional_notes: true,
				positive: [
					{
						main_point: "Good pandas usage",
						dimensions: ["scientific_programming"],
						sub_points: [
							{ text: "correct_dataframe_ops" },
							{
								text: "creative plotting",
								dimensions: ["code_quality_design", "creativity"],
							},
						],
					},
				],
				neutral: [],
				negative: [],
			},
		};
		const editable = fromServerCategories(categories);
		expect(editable[0]!.positive[0]!.dimensions).toEqual(["scientific_programming"]);
		expect(editable[0]!.positive[0]!.sub_points[0]!.dimensions).toEqual([]);
		expect(editable[0]!.positive[0]!.sub_points[1]!.dimensions).toEqual([
			"code_quality_design",
			"creativity",
		]);

		const rebuilt = toServerCategories(editable);
		const rebuiltPandas = rebuilt.pandas as {
			positive: Record<string, unknown>[];
		};
		const mainPoint = rebuiltPandas.positive[0] as {
			dimensions: unknown;
			sub_points: Record<string, unknown>[];
		};
		expect(mainPoint.dimensions).toEqual(["scientific_programming"]);
		const subPoints = mainPoint.sub_points;
		expect(subPoints[0]).toEqual({ text: "correct_dataframe_ops" });
		expect(subPoints[1]).toEqual({
			text: "creative plotting",
			dimensions: ["code_quality_design", "creativity"],
		});
	});

	it("omits empty dimensions on save — legacy YAML stays byte-stable", () => {
		const categories = {
			pandas: {
				title: "Pandas",
				additional_notes: true,
				positive: [
					{
						main_point: "Good pandas usage",
						dimensions: [],
						sub_points: [{ text: "correct_dataframe_ops", dimensions: [] }],
					},
				],
				neutral: [],
				negative: [],
			},
		};
		const yamlText = yaml.dump({
			categories: toServerCategories(fromServerCategories(categories)),
		});
		expect(yamlText).not.toContain("dimensions");
		expect(yamlText).toContain("correct_dataframe_ops");
	});

	it("emptySubPoint/emptyMainPoint start with empty dimensions and omit them on save", () => {
		const editable = [
			{
				key: "new_category",
				title: "New Category",
				additional_notes: true,
				positive: [emptyMainPoint()],
				neutral: [],
				negative: [],
			},
		];
		const sp = emptySubPoint();
		expect(sp.dimensions).toEqual([]);
		editable[0]!.positive[0]!.sub_points.push(sp);

		const yamlText = yaml.dump({ categories: toServerCategories(editable) });
		expect(yamlText).not.toContain("dimensions");
	});
});

describe("resolveSubPointDimensions (server canonical)", () => {
	const group = (dimensions?: readonly string[]): MainPoint => ({
		main_point: "Group",
		sub_points: [],
		...(dimensions ? { dimensions } : {}),
	});
	const sub = (dimensions?: readonly string[]): SubPoint => ({
		text: "Sub",
		...(dimensions ? { dimensions } : {}),
	});

	it("sub-point override wins over the group default", () => {
		expect(
			resolveSubPointDimensions(
				group(["scientific_programming"]),
				sub(["code_quality_design"]),
			),
		).toEqual(["code_quality_design"]);
	});

	it("override REPLACES — never merges", () => {
		const result = resolveSubPointDimensions(
			group(["scientific_programming"]),
			sub(["code_quality_design"]),
		);
		expect(result).toEqual(["code_quality_design"]);
		expect(result).not.toContain("scientific_programming");
	});

	it("group default applies when the sub-point has no override", () => {
		expect(resolveSubPointDimensions(group(["scientific_programming"]), sub())).toEqual([
			"scientific_programming",
		]);
	});

	it("both absent → []", () => {
		expect(resolveSubPointDimensions(group(), sub())).toEqual([]);
	});
});

describe("resolveEditableSubPointDimensions (client mirror)", () => {
	it("matches the server resolver semantics (override ?? group ?? [])", () => {
		const group = (dimensions: string[]): EditableMainPoint => ({
			main_point: "Group",
			sub_points: [],
			dimensions,
		});
		const sub = (dimensions: string[]): EditableSubPoint => ({
			text: "Sub",
			comment: false,
			point_deduction: false,
			dimensions,
		});

		const withOverride = group(["scientific_programming"]);
		withOverride.sub_points.push(sub(["code_quality_design"]));
		const noOverride = group(["scientific_programming"]);
		noOverride.sub_points.push(sub([]));
		const empty = group([]);
		empty.sub_points.push(sub([]));

		expect(
			resolveEditableSubPointDimensions(withOverride, withOverride.sub_points[0]!),
		).toEqual(["code_quality_design"]);
		expect(resolveEditableSubPointDimensions(noOverride, noOverride.sub_points[0]!)).toEqual([
			"scientific_programming",
		]);
		expect(resolveEditableSubPointDimensions(empty, empty.sub_points[0]!)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// D2 — soft validator enforcement
// ---------------------------------------------------------------------------

const VALID_CATEGORIES = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
	pandas: {
		title: "Pandas",
		additional_notes: true,
		positive: [
			{
				main_point: "Good pandas usage",
				sub_points: [{ text: "correct_dataframe_ops" }],
				...overrides,
			},
		],
		neutral: [],
		negative: [],
	},
});

describe("validateCriteriaYaml — malformed dimensions (no grading config needed)", () => {
	it.each([
		["string", "scientific_programming"],
		["empty array", []],
		["array with non-string entry", ["scientific_programming", 42]],
		["array with empty string entry", ["scientific_programming", ""]],
	] as const)("rejects dimensions given as %s", async (_label, dimensions) => {
		await expect(
			validateCriteriaYaml(docYaml(VALID_CATEGORIES({ dimensions })), "rubric.yaml"),
		).rejects.toThrow(CriteriaValidationError);
		await expect(
			validateCriteriaYaml(docYaml(VALID_CATEGORIES({ dimensions })), "rubric.yaml"),
		).rejects.toThrow(
			'category "pandas".positive[0].dimensions must be a non-empty array of strings',
		);
	});

	it("rejects a malformed sub-point dimensions field with the sub-point path", async () => {
		const categories = {
			pandas: {
				title: "Pandas",
				additional_notes: true,
				positive: [
					{
						main_point: "Good pandas usage",
						sub_points: [{ text: "x", dimensions: "creativity" }],
					},
				],
				neutral: [],
				negative: [],
			},
		};
		await expect(validateCriteriaYaml(docYaml(categories), "rubric.yaml")).rejects.toThrow(
			'category "pandas".positive[0].sub_points[0].dimensions must be a non-empty array of strings',
		);
	});

	it("absent dimensions are always allowed (plain legacy document passes)", async () => {
		await expect(validateCriteriaYaml(PLAIN_YAML, "rubric.yaml")).resolves.toMatchObject({
			fileName: "rubric.yaml",
		});
	});

	it("preserves existing behavior for text/comment/point_deduction", async () => {
		const categories = {
			pandas: {
				title: "Pandas",
				additional_notes: true,
				positive: [
					{
						main_point: "Good pandas usage",
						sub_points: [{ text: "x", comment: true, point_deduction: true }],
					},
				],
				neutral: [],
				negative: [],
			},
		};
		await expect(
			validateCriteriaYaml(docYaml(categories), "rubric.yaml"),
		).resolves.toMatchObject({
			fileName: "rubric.yaml",
		});
	});
});

describe("validateCriteriaYaml — dimension key membership (grading config present)", () => {
	beforeEach(async () => {
		await useTempDataDir(true);
	});

	it("rejects an unknown key on a main point, listing the known set", async () => {
		const promise = validateCriteriaYaml(
			docYaml(VALID_CATEGORIES({ dimensions: ["not_a_dimension"] })),
			"rubric.yaml",
		);
		await expect(promise).rejects.toThrow(CriteriaValidationError);
		await expect(
			validateCriteriaYaml(
				docYaml(VALID_CATEGORIES({ dimensions: ["not_a_dimension"] })),
				"rubric.yaml",
			),
		).rejects.toThrow(
			'category "pandas".positive[0].dimensions contains unknown key "not_a_dimension"',
		);
		const err = await validateCriteriaYaml(
			docYaml(VALID_CATEGORIES({ dimensions: ["not_a_dimension"] })),
			"rubric.yaml",
		).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(CriteriaValidationError);
		for (const known of KNOWN_DIMENSIONS) {
			expect((err as Error).message).toContain(known);
		}
	});

	it("rejects an unknown key on a sub-point, listing the known set", async () => {
		const categories = {
			pandas: {
				title: "Pandas",
				additional_notes: true,
				positive: [
					{
						main_point: "Good pandas usage",
						sub_points: [{ text: "x", dimensions: ["bogus_dim"] }],
					},
				],
				neutral: [],
				negative: [],
			},
		};
		await expect(validateCriteriaYaml(docYaml(categories), "rubric.yaml")).rejects.toThrow(
			'category "pandas".positive[0].sub_points[0].dimensions contains unknown key "bogus_dim" (known: code_quality_design, code_execution_results, assignment_requirements, scientific_programming, creativity)',
		);
	});

	it("accepts known dimension keys on main points and sub-points", async () => {
		const categories = {
			pandas: {
				title: "Pandas",
				additional_notes: true,
				positive: [
					{
						main_point: "Good pandas usage",
						dimensions: ["scientific_programming"],
						sub_points: [
							{ text: "x", dimensions: ["code_quality_design", "creativity"] },
						],
					},
				],
				neutral: [],
				negative: [],
			},
		};
		await expect(
			validateCriteriaYaml(docYaml(categories), "rubric.yaml"),
		).resolves.toMatchObject({ fileName: "rubric.yaml" });
	});

	it("keeps tolerating unknown YAML keys that are not dimensions", async () => {
		const categories = {
			pandas: {
				title: "Pandas",
				additional_notes: true,
				positive: [
					{
						main_point: "Good pandas usage",
						some_future_key: "ignored",
						sub_points: [{ text: "x", another_unknown: true }],
					},
				],
				neutral: [],
				negative: [],
			},
		};
		await expect(
			validateCriteriaYaml(docYaml(categories), "rubric.yaml"),
		).resolves.toMatchObject({ fileName: "rubric.yaml" });
	});
});

describe("validateCriteriaYaml — grading config missing/unloadable (soft skip)", () => {
	it("skips the membership check when grading_config.yaml is absent", async () => {
		await useTempDataDir(false); // temp DATA_DIR with NO grading_config.yaml
		await expect(
			validateCriteriaYaml(
				docYaml(VALID_CATEGORIES({ dimensions: ["not_a_dimension"] })),
				"rubric.yaml",
			),
		).resolves.toMatchObject({ fileName: "rubric.yaml" });
	});

	it("skips the membership check when grading_config.yaml exists but is corrupt", async () => {
		dataDir = await mkdtemp(path.join(tmpdir(), "criteria-dimensions-"));
		vi.stubEnv("DATA_DIR", dataDir);
		await writeFile(path.join(dataDir, "grading_config.yaml"), "dimensions: [unclosed\n");

		await expect(
			validateCriteriaYaml(
				docYaml(VALID_CATEGORIES({ dimensions: ["not_a_dimension"] })),
				"rubric.yaml",
			),
		).resolves.toMatchObject({ fileName: "rubric.yaml" });
	});
});
