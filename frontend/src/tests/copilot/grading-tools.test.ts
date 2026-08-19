/**
 * @file Unit tests for the copilot grading WRITE tools (grading-tools.ts).
 *
 * Each test gets a fresh temp DATA_DIR (mkdtemp) with real fixture files on
 * disk: assignments.yaml (for the assignment fallback) and a metadata.json
 * carrying one submission with pre-seeded grading state. Tools are registered
 * into a fresh createRegistry() — never the agent singleton — and invoked
 * through registry.run(name, args, ctx) so argument validation is exercised
 * too.
 *
 * Covers: set-rubric-item touches only the rubric map, update-grade-dimension
 * rejects out-of-range values with the typed argument error, write-notes
 * persists notes, save-grading merges (untouched fields survive), the
 * ctx.submissionId fallback chain, and the approval permission on all four.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { registerGradingTools } from "$lib/server/copilot/tools/grading-tools";
import {
	CopilotToolArgumentError,
	createRegistry,
	type ToolContext,
} from "$lib/server/copilot/registry";
import { getSubmission, type SubmissionRecord } from "$lib/server/metadata";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ASSIGNMENT = "soil_contamination";

const ASSIGNMENTS_YAML = `assignments:
  - id: soil_contamination
    title: Soil Contamination by Factories
    enabled: true
    criteria_files:
      - data/criteria/general.yaml
      - data/criteria/soil_contamination.yaml
    dimensions:
      - code_quality_design
      - code_execution_results
      - assignment_requirements
      - scientific_programming
      - creativity
  - id: molecular_dynamics
    title: Molecular Dynamics
    enabled: false
    criteria_files: []
    dimensions: []
`;

const STUDENT = "2026SS_01";

/** Real global grading config — dimensions carry their max_points (0..max). */
const GRADING_CONFIG_SOURCE = "/root/projects/svelte-review-copilot/data/grading_config.yaml";

/** Pre-seeded grading state: rubric, dimensions, feedback, and notes. */
const METADATA: Record<string, SubmissionRecord> = {
	[STUDENT]: {
		id: STUDENT,
		studentId: STUDENT,
		assignmentId: ASSIGNMENT,
		semester: "2026SS",
		fileName: "2026SS_01.ipynb",
		notebookPath: `submissions/${ASSIGNMENT}/2026SS_01.ipynb`,
		status: "executed",
		grading: {
			rubric: { clarity: "good" },
			dimensions: { code_quality_design: 2 },
			feedback: {
				clarity: {
					checked: ["Uses readable variable names"],
					comments: {},
					deductions: {},
					notes: "",
				},
			},
			notes: "Nice work overall",
			updatedAt: "2026-08-08T10:00:00.000Z",
		},
		createdAt: "2026-08-01T09:00:00.000Z",
		updatedAt: "2026-08-08T10:00:00.000Z",
	},
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let dataDir: string;
let registry: ReturnType<typeof createRegistry>;

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
	return { signal: new AbortController().signal, ...overrides };
}

function freshRegistry() {
	const reg = createRegistry();
	registerGradingTools(reg);
	return reg;
}

/** Read the persisted record straight from the metadata service. */
async function readRecord(): Promise<SubmissionRecord> {
	const record = await getSubmission(ASSIGNMENT, STUDENT);
	expect(record).not.toBeNull();
	return record!;
}

beforeEach(async () => {
	dataDir = await mkdtemp(path.join(os.tmpdir(), "scipro-grading-tools-"));
	process.env.DATA_DIR = dataDir;

	await mkdir(path.join(dataDir, "submissions", ASSIGNMENT), { recursive: true });
	await writeFile(path.join(dataDir, "assignments.yaml"), ASSIGNMENTS_YAML);
	await writeFile(
		path.join(dataDir, "grading_config.yaml"),
		await readFile(GRADING_CONFIG_SOURCE, "utf-8"),
	);
	await writeFile(
		path.join(dataDir, "submissions", ASSIGNMENT, "metadata.json"),
		JSON.stringify(METADATA, null, 2),
	);

	registry = freshRegistry();
});

afterEach(async () => {
	delete process.env.DATA_DIR;
	await rm(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe("registerGradingTools", () => {
	it("registers the four grading write tools as approval tools with kebab-case names", () => {
		const tools = registry.list();
		expect(tools.map((tool) => tool.name).sort()).toEqual([
			"save-grading",
			"set-rubric-item",
			"update-grade-dimension",
			"write-notes",
		]);
		for (const tool of tools) {
			expect(tool.permission).toBe("approval");
			expect(tool.destructive).toBeUndefined();
		}
	});

	it("is idempotent — re-registering the same module skips existing tools", () => {
		expect(() => registerGradingTools(registry)).not.toThrow();
		expect(registry.list()).toHaveLength(4);
	});
});

// ---------------------------------------------------------------------------
// set-rubric-item
// ---------------------------------------------------------------------------

describe("set-rubric-item", () => {
	it("updates only the rubric map and reports the written item", async () => {
		const result = (await registry.run(
			"set-rubric-item",
			{ submissionId: STUDENT, criterionKey: "structure", optionKey: "excellent" },
			makeContext(),
		)) as Record<string, unknown>;

		expect(result["rubricItem"]).toEqual({
			criterionKey: "structure",
			optionKey: "excellent",
		});
		expect(result["submissionId"]).toBe(STUDENT);
		expect(result["rubric"]).toEqual({ clarity: "good", structure: "excellent" });

		// Persisted: rubric gained the item; dimensions, feedback, notes survive.
		const record = await readRecord();
		expect(record.grading?.rubric).toEqual({ clarity: "good", structure: "excellent" });
		expect(record.grading?.dimensions).toEqual({ code_quality_design: 2 });
		expect(record.grading?.notes).toBe("Nice work overall");
		expect(record.grading?.feedback).toEqual(METADATA[STUDENT]!.grading?.feedback);
	});

	it("overwrites an existing selection for the same criterion", async () => {
		const result = (await registry.run(
			"set-rubric-item",
			{ submissionId: STUDENT, criterionKey: "clarity", optionKey: "poor" },
			makeContext(),
		)) as Record<string, unknown>;

		// Change-ledger: the previous selection for the overwritten criterion.
		expect(result["previous"]).toBe("good");

		const record = await readRecord();
		expect(record.grading?.rubric).toEqual({ clarity: "poor" });
		expect(Object.keys(record.grading?.rubric ?? {})).toHaveLength(1);
	});

	it("reports previous undefined when the criterion was unset", async () => {
		const result = (await registry.run(
			"set-rubric-item",
			{ submissionId: STUDENT, criterionKey: "structure", optionKey: "excellent" },
			makeContext(),
		)) as Record<string, unknown>;

		expect(result["previous"]).toBeUndefined();
		expect(result["rubricItem"]).toEqual({
			criterionKey: "structure",
			optionKey: "excellent",
		});
	});
});

// ---------------------------------------------------------------------------
// update-grade-dimension
// ---------------------------------------------------------------------------

describe("update-grade-dimension", () => {
	it("updates only the dimensions map and reports the written dimension", async () => {
		const result = (await registry.run(
			"update-grade-dimension",
			{ submissionId: STUDENT, dimensionId: "creativity", value: 3.5 },
			makeContext(),
		)) as Record<string, unknown>;

		expect(result["dimension"]).toEqual({ dimensionId: "creativity", value: 3.5 });
		expect(result["dimensions"]).toEqual({ code_quality_design: 2, creativity: 3.5 });

		const record = await readRecord();
		expect(record.grading?.dimensions).toEqual({ code_quality_design: 2, creativity: 3.5 });
		// untouched
		expect(record.grading?.rubric).toEqual({ clarity: "good" });
		expect(record.grading?.notes).toBe("Nice work overall");
	});

	it("rejects a negative value with the typed argument error", async () => {
		await expect(
			registry.run(
				"update-grade-dimension",
				{ submissionId: STUDENT, dimensionId: "code_quality_design", value: -1 },
				makeContext(),
			),
		).rejects.toThrow(CopilotToolArgumentError);
	});

	it("rejects values above the dimension's max_points and non-finite values", async () => {
		// Grading dimensions are POINTS on [0, max_points] (code_quality_design
		// has max_points 6). Values on the old 0-1000 scale (500-800) are
		// out of range and must be rejected — this is the B7 regression: a
		// 0-1000-scale value would be silently clamped by the grade calculator.
		await expect(
			registry.run(
				"update-grade-dimension",
				{ submissionId: STUDENT, dimensionId: "code_quality_design", value: 7 },
				makeContext(),
			),
		).rejects.toThrow(CopilotToolArgumentError);
		await expect(
			registry.run(
				"update-grade-dimension",
				{ submissionId: STUDENT, dimensionId: "code_quality_design", value: 100 },
				makeContext(),
			),
		).rejects.toThrow(CopilotToolArgumentError);
		// Old 0-1000-scale values like the recorded 500/800 are long past the
		// max_points bound — reject, not silently clamp.
		await expect(
			registry.run(
				"update-grade-dimension",
				{ submissionId: STUDENT, dimensionId: "code_quality_design", value: 800 },
				makeContext(),
			),
		).rejects.toThrow(CopilotToolArgumentError);
		// Non-finite are still schema-rejected.
		for (const value of [Number.POSITIVE_INFINITY, Number.NaN]) {
			await expect(
				registry.run(
					"update-grade-dimension",
					{ submissionId: STUDENT, dimensionId: "code_quality_design", value },
					makeContext(),
				),
			).rejects.toThrow(CopilotToolArgumentError);
		}
	});

	it("accepts valid points within the dimension's max_points", async () => {
		// creativity max_points is 4 — 3.5 is valid; exactly max is valid.
		const result = (await registry.run(
			"update-grade-dimension",
			{ submissionId: STUDENT, dimensionId: "creativity", value: 4 },
			makeContext(),
		)) as Record<string, unknown>;
		expect(result["dimension"]).toEqual({ dimensionId: "creativity", value: 4 });
	});

	it("reports the previous score for an overwritten dimension", async () => {
		const result = (await registry.run(
			"update-grade-dimension",
			{ submissionId: STUDENT, dimensionId: "code_quality_design", value: 4 },
			makeContext(),
		)) as Record<string, unknown>;

		// Change-ledger: the pre-write score of the changed dimension.
		expect(result["previous"]).toBe(2);
		expect(result["dimension"]).toEqual({ dimensionId: "code_quality_design", value: 4 });
	});

	it("reports previous undefined when the dimension was unset", async () => {
		const result = (await registry.run(
			"update-grade-dimension",
			{ submissionId: STUDENT, dimensionId: "creativity", value: 3.5 },
			makeContext(),
		)) as Record<string, unknown>;

		expect(result["previous"]).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// write-notes
// ---------------------------------------------------------------------------

describe("write-notes", () => {
	it("persists the notes and leaves the rest of the grading state alone", async () => {
		const result = (await registry.run(
			"write-notes",
			{ submissionId: STUDENT, notes: "Needs to explain the normalization step." },
			makeContext(),
		)) as Record<string, unknown>;

		expect(result["notes"]).toBe("Needs to explain the normalization step.");

		const record = await readRecord();
		expect(record.grading?.notes).toBe("Needs to explain the normalization step.");
		expect(record.grading?.rubric).toEqual({ clarity: "good" });
		expect(record.grading?.dimensions).toEqual({ code_quality_design: 2 });
	});

	it("clears the notes when given an empty string", async () => {
		const result = (await registry.run(
			"write-notes",
			{ submissionId: STUDENT, notes: "" },
			makeContext(),
		)) as Record<string, unknown>;

		// Change-ledger: the pre-write notes string.
		expect(result["previous"]).toBe("Nice work overall");

		const record = await readRecord();
		expect(record.grading?.notes).toBe("");
	});

	it("reports previous null when the submission has no grading state yet", async () => {
		const other = "2026SS_02";
		await writeFile(
			path.join(dataDir, "submissions", ASSIGNMENT, "metadata.json"),
			JSON.stringify({
				...METADATA,
				[other]: {
					id: other,
					studentId: other,
					assignmentId: ASSIGNMENT,
					semester: "2026SS",
					fileName: "2026SS_02.ipynb",
					notebookPath: `submissions/${ASSIGNMENT}/2026SS_02.ipynb`,
					status: "executed",
					createdAt: "2026-08-02T09:00:00.000Z",
					updatedAt: "2026-08-03T10:00:00.000Z",
				},
			}),
		);

		const result = (await registry.run(
			"write-notes",
			{ submissionId: other, notes: "First notes." },
			makeContext(),
		)) as Record<string, unknown>;

		expect(result["previous"]).toBeNull();
		expect(result["notes"]).toBe("First notes.");
	});
});

// ---------------------------------------------------------------------------
// save-grading
// ---------------------------------------------------------------------------

describe("save-grading", () => {
	it("merges — a rubric-only save leaves pre-seeded dimensions and notes intact", async () => {
		const result = (await registry.run(
			"save-grading",
			{
				submissionId: STUDENT,
				rubric: { clarity: "excellent", structure: "good" },
			},
			makeContext(),
		)) as Record<string, unknown>;

		expect(result["persisted"]).toEqual(["rubric"]);
		expect(result["rubric"]).toEqual({ clarity: "excellent", structure: "good" });

		const record = await readRecord();
		expect(record.grading?.rubric).toEqual({ clarity: "excellent", structure: "good" });
		// not clobbered by the rubric-only save
		expect(record.grading?.dimensions).toEqual({ code_quality_design: 2 });
		expect(record.grading?.notes).toBe("Nice work overall");
		expect(record.grading?.feedback).toEqual(METADATA[STUDENT]!.grading?.feedback);
	});

	it("persists dimensions, feedback, and notes in one merged save", async () => {
		const result = (await registry.run(
			"save-grading",
			{
				submissionId: STUDENT,
				dimensions: { code_quality_design: 4, creativity: 1 },
				feedback: {
					structure: {
						checked: ["Clear intro"],
						comments: { "Clear intro": "Good." },
						deductions: {},
						notes: "See comments",
					},
				},
				notes: "Revised after feedback.",
			},
			makeContext(),
		)) as Record<string, unknown>;

		expect(result["persisted"]).toEqual(["dimensions", "feedback", "notes"]);
		expect(result["feedbackCategories"]).toBe(2);

		const record = await readRecord();
		expect(record.grading?.dimensions).toEqual({ code_quality_design: 4, creativity: 1 });
		expect(record.grading?.notes).toBe("Revised after feedback.");
		// feedback merged across categories, not replaced
		expect(record.grading?.feedback).toEqual({
			clarity: METADATA[STUDENT]!.grading?.feedback?.clarity,
			structure: {
				checked: ["Clear intro"],
				comments: { "Clear intro": "Good." },
				deductions: {},
				notes: "See comments",
			},
		});
	});

	it("rejects malformed feedback with the typed argument error", async () => {
		await expect(
			registry.run(
				"save-grading",
				{
					submissionId: STUDENT,
					feedback: { clarity: { checked: "not-an-array" } },
				},
				makeContext(),
			),
		).rejects.toThrow(CopilotToolArgumentError);
	});

	it("reports the previous value of every persisted field", async () => {
		const result = (await registry.run(
			"save-grading",
			{
				submissionId: STUDENT,
				rubric: { clarity: "excellent", structure: "good" },
				dimensions: { code_quality_design: 4 },
				notes: "Revised after feedback.",
			},
			makeContext(),
		)) as Record<string, unknown>;

		expect(result["persisted"]).toEqual(["rubric", "dimensions", "notes"]);
		// Change-ledger: pre-write values for exactly the persisted fields.
		expect(result["previous"]).toEqual({
			rubric: { clarity: "good" },
			dimensions: { code_quality_design: 2 },
			notes: "Nice work overall",
		});
	});

	it("reports empty defaults for fields persisted onto a submission with no grading state", async () => {
		const other = "2026SS_02";
		await writeFile(
			path.join(dataDir, "submissions", ASSIGNMENT, "metadata.json"),
			JSON.stringify({
				...METADATA,
				[other]: {
					id: other,
					studentId: other,
					assignmentId: ASSIGNMENT,
					semester: "2026SS",
					fileName: "2026SS_02.ipynb",
					notebookPath: `submissions/${ASSIGNMENT}/2026SS_02.ipynb`,
					status: "executed",
					createdAt: "2026-08-02T09:00:00.000Z",
					updatedAt: "2026-08-03T10:00:00.000Z",
				},
			}),
		);

		const result = (await registry.run(
			"save-grading",
			{
				submissionId: other,
				rubric: { clarity: "good" },
				notes: "First notes.",
			},
			makeContext(),
		)) as Record<string, unknown>;

		expect(result["previous"]).toEqual({
			rubric: {},
			notes: null,
		});
	});
});

// ---------------------------------------------------------------------------
// Target resolution (fallback chain)
// ---------------------------------------------------------------------------

describe("target resolution", () => {
	it("falls back to ctx.submissionId and ctx.assignmentId when the args omit them", async () => {
		await registry.run(
			"write-notes",
			{ notes: "Written via context." },
			makeContext({ submissionId: STUDENT, assignmentId: ASSIGNMENT }),
		);

		const record = await readRecord();
		expect(record.grading?.notes).toBe("Written via context.");
	});

	it("prefers an explicit args.submissionId over ctx.submissionId", async () => {
		const other = "2026SS_02";
		await writeFile(
			path.join(dataDir, "submissions", ASSIGNMENT, "metadata.json"),
			JSON.stringify(
				{
					...METADATA,
					[other]: {
						id: other,
						studentId: other,
						assignmentId: ASSIGNMENT,
						semester: "2026SS",
						fileName: "2026SS_02.ipynb",
						notebookPath: `submissions/${ASSIGNMENT}/2026SS_02.ipynb`,
						status: "executed",
						createdAt: "2026-08-02T09:00:00.000Z",
						updatedAt: "2026-08-03T10:00:00.000Z",
					},
				},
				null,
				2,
			),
		);

		await registry.run(
			"write-notes",
			{ submissionId: other, notes: "Second student." },
			makeContext({ submissionId: STUDENT }),
		);

		const first = await getSubmission(ASSIGNMENT, STUDENT);
		expect(first?.grading?.notes).toBe("Nice work overall");
		const second = await getSubmission(ASSIGNMENT, other);
		expect(second?.grading?.notes).toBe("Second student.");
	});

	it("rejects when no submissionId is available from args or ctx", async () => {
		await expect(
			registry.run("write-notes", { notes: "nowhere" }, makeContext()),
		).rejects.toThrow(/requires a submissionId/);
	});
});
