/**
 * @file L5 tests for export-service.ts — grading YAML shape.
 *
 * Covers: full-record export shape (rubric / scores / notes / teacher grade),
 * omission of absent sections, plain-vs-quoted scalar handling, and the
 * notes block scalar.
 */
import { describe, expect, it } from "vitest";

import {
	buildGradingExport,
	buildGradingYaml,
	buildStudentYaml,
	gradingExportToYaml,
} from "$lib/server/export-service";
import type { SubmissionRecord } from "$lib/server/metadata";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function gradedRecord(): SubmissionRecord {
	return {
		id: "2026SS_03",
		studentId: "2026SS_03",
		assignmentId: "soil_contamination",
		semester: "2026SS",
		fileName: "2026SS_03.ipynb",
		notebookPath: "submissions/soil_contamination/2026SS_03.ipynb",
		status: "graded",
		cellSummary: "12 cells",
		teacherGrade: 12,
		grading: {
			rubric: { data_quality: "complete", plotting: "clear_labels" },
			dimensions: { code_quality_design: 1.5, creativity: 0 },
			notes: "Good structure.\nOne missing axis label in plot 2.",
			updatedAt: "2026-07-31T10:00:00.000Z",
		},
		createdAt: "2026-07-30T08:00:00.000Z",
		updatedAt: "2026-07-31T10:00:00.000Z",
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildGradingExport", () => {
	it("maps the submission record onto the export shape", () => {
		const data = buildGradingExport(gradedRecord(), {
			assignmentTitle: "Soil Contamination by Factories",
		});

		expect(data.studentId).toBe("2026SS_03");
		expect(data.assignmentId).toBe("soil_contamination");
		expect(data.assignmentTitle).toBe("Soil Contamination by Factories");
		expect(data.fileName).toBe("2026SS_03.ipynb");
		expect(data.status).toBe("graded");
		expect(data.teacherGrade).toBe(12);
		expect(data.rubric).toEqual({ data_quality: "complete", plotting: "clear_labels" });
		expect(data.scores).toEqual({ code_quality_design: 1.5, creativity: 0 });
		expect(data.notes).toContain("Good structure");
	});

	it("omits optional sections for records without grading state", () => {
		const record = gradedRecord();
		delete record.grading;
		delete record.teacherGrade;

		const data = buildGradingExport(record);

		expect(data.rubric).toBeUndefined();
		expect(data.scores).toBeUndefined();
		expect(data.notes).toBeUndefined();
		expect(data.teacherGrade).toBeUndefined();
	});
});

describe("gradingExportToYaml", () => {
	it("emits a full deterministic YAML document", () => {
		const yaml = gradingExportToYaml(buildGradingExport(gradedRecord()));

		expect(yaml).toBe(
			[
				"student_id: 2026SS_03",
				"assignment: soil_contamination",
				"semester: 2026SS",
				"file_name: 2026SS_03.ipynb",
				"status: graded",
				"teacher_grade: 12",
				'created_at: "2026-07-30T08:00:00.000Z"',
				'updated_at: "2026-07-31T10:00:00.000Z"',
				"rubric:",
				"  data_quality: complete",
				"  plotting: clear_labels",
				"scores:",
				"  code_quality_design: 1.5",
				"  creativity: 0",
				"notes: |-",
				"  Good structure.",
				"  One missing axis label in plot 2.",
				"",
			].join("\n"),
		);
	});

	it("round-trips through the yaml parser as the expected object", async () => {
		const yaml = buildGradingYaml(gradedRecord(), {
			assignmentTitle: "Soil Contamination by Factories",
		});
		const { load } = await import("js-yaml");
		const parsed = load(yaml) as Record<string, unknown>;

		expect(parsed.student_id).toBe("2026SS_03");
		expect(parsed.assignment).toBe("soil_contamination");
		expect(parsed.assignment_title).toBe("Soil Contamination by Factories");
		expect(parsed.teacher_grade).toBe(12);
		expect(parsed.scores).toEqual({ code_quality_design: 1.5, creativity: 0 });
		expect(parsed.rubric).toEqual({ data_quality: "complete", plotting: "clear_labels" });
		expect(parsed.notes).toBe("Good structure.\nOne missing axis label in plot 2.");
		expect(parsed.status).toBe("graded");
	});

	it("quotes scalars that are unsafe in plain style", async () => {
		const record = gradedRecord();
		record.studentId = "2026SS_03";
		record.grading = {
			...record.grading!,
			rubric: { "notes: with colon": "value # with hash" },
			notes: "leading dash line\n- bullet\n\n  indented block",
			updatedAt: "2026-07-31T10:00:00.000Z",
		};

		const yaml = gradingExportToYaml(buildGradingExport(record));

		expect(yaml).toContain('"notes: with colon": "value # with hash"');
		expect(yaml).toContain("notes: |-");
		expect(yaml).toContain("  leading dash line");
		expect(yaml).toContain("  - bullet");
		expect(yaml).toContain("    indented block");

		// The emitted document must still parse.
		const { load } = await import("js-yaml");
		const parsed = load(yaml) as Record<string, unknown>;
		expect(parsed.rubric).toEqual({ "notes: with colon": "value # with hash" });
		expect(parsed.notes).toBe("leading dash line\n- bullet\n\n  indented block");
	});
});

// ---------------------------------------------------------------------------
// Student-facing export (v2 evaluation schema)
// ---------------------------------------------------------------------------

describe("buildStudentYaml", () => {
	it("emits an importable v2 evaluation document (feedback key present)", async () => {
		const yaml = buildStudentYaml(gradedRecord());
		const { load } = await import("js-yaml");
		const parsed = load(yaml) as Record<string, unknown>;

		expect(parsed.student_id).toBe("2026SS_03");
		expect(parsed.assignment).toBe("soil_contamination");
		expect(parsed.scores).toEqual({ code_quality_design: 1.5, creativity: 0 });
		// parseYamlImport rejects YAML without the feedback key
		expect(parsed.feedback).toEqual({});
		// Teacher-only fields must NOT leak into the student copy
		expect(parsed).not.toHaveProperty("status");
		expect(parsed).not.toHaveProperty("file_name");
		expect(parsed).not.toHaveProperty("plagiarism");
		expect(parsed).not.toHaveProperty("created_at");
	});

	it("includes teacher notes as top-level notes (survives parseImport)", async () => {
		const yaml = buildStudentYaml(gradedRecord());
		const { load } = await import("js-yaml");
		const parsed = load(yaml) as Record<string, unknown>;
		expect(parsed.notes).toBe("Good structure.\nOne missing axis label in plot 2.");
	});

	it("omits notes when absent", async () => {
		const record = gradedRecord();
		record.grading = { ...record.grading!, notes: "" };
		const yaml = buildStudentYaml(record);
		expect(yaml).not.toContain("notes:");
	});

	it("emits per-category feedback (checked list, comments, deductions, notes)", () => {
		const record = gradedRecord();
		record.grading = {
			...record.grading!,
			feedback: {
				code_formatting: {
					checked: ["a", "b"],
					comments: { a: "c" },
					deductions: { b: 0.5 },
					notes: "<p>n</p>",
				},
			},
		};
		const yaml = buildStudentYaml(record);

		expect(yaml).toContain("feedback:");
		expect(yaml).toContain("code_formatting:");
		expect(yaml).toContain("checked:");
		expect(yaml).toContain("- a");
		expect(yaml).toContain("- b");
		expect(yaml).toContain("comments:");
		expect(yaml).toContain("a: c");
		expect(yaml).toContain("deductions:");
		expect(yaml).toContain("b: 0.5");
		expect(yaml).toContain("notes: |-");
	});

	it("round-trips feedback through the v2 parser shape", async () => {
		const record = gradedRecord();
		record.grading = {
			...record.grading!,
			feedback: {
				code_formatting: {
					checked: ["a", "b"],
					comments: { a: "c" },
					deductions: { b: 0.5 },
					notes: "<p>n</p>",
				},
			},
		};
		const yaml = buildStudentYaml(record);
		const { load } = await import("js-yaml");
		const parsed = load(yaml) as {
			feedback?: Record<
				string,
				{
					checked: string[];
					comments: Record<string, string>;
					deductions: Record<string, number>;
					notes: string;
				}
			>;
		};

		expect(parsed.feedback!.code_formatting.checked).toEqual(["a", "b"]);
		expect(parsed.feedback!.code_formatting.comments).toEqual({ a: "c" });
		expect(parsed.feedback!.code_formatting.deductions).toEqual({ b: 0.5 });
		expect(parsed.feedback!.code_formatting.notes).toBe("<p>n</p>");
	});

	it("omits categories without content and keeps feedback: {} for the student copy", () => {
		const record = gradedRecord();
		record.grading = {
			...record.grading!,
			feedback: {
				code_formatting: { checked: [], comments: {}, deductions: {}, notes: "" },
			},
		};
		const yaml = buildStudentYaml(record);
		expect(yaml).toContain("feedback: {}");
		expect(yaml).not.toContain("code_formatting:");
	});
});

// ---------------------------------------------------------------------------
// Teacher-only plagiarism audit block
// ---------------------------------------------------------------------------

describe("buildGradingYaml (plagiarism audit)", () => {
	it("appends the plagiarism block with per-pair review statuses", async () => {
		const yaml = buildGradingYaml(gradedRecord(), {
			plagiarism: {
				pairs: [
					{
						studentB: "2026SS_02",
						severity: "high",
						notebookOverlap: 0.75,
						reviewStatus: "accepted",
					},
				],
			},
		});
		const { load } = await import("js-yaml");
		const parsed = load(yaml) as Record<string, unknown>;

		expect(parsed.plagiarism).toEqual([
			{
				student_b: "2026SS_02",
				severity: "high",
				notebook_overlap: 0.75,
				review_status: "accepted",
			},
		]);
	});

	it("omits the plagiarism block when no pairs exist", () => {
		const yaml = buildGradingYaml(gradedRecord());
		expect(yaml).not.toContain("plagiarism:");
	});
});

describe("buildGradingYaml (feedback block)", () => {
	it("includes the feedback block after scores when the record has feedback", async () => {
		const record = gradedRecord();
		record.grading = {
			...record.grading!,
			feedback: {
				code_formatting: {
					checked: ["a"],
					comments: {},
					deductions: {},
					notes: "",
				},
			},
		};
		const yaml = buildGradingYaml(record);

		expect(yaml).toContain("scores:");
		expect(yaml.indexOf("feedback:")).toBeGreaterThan(yaml.indexOf("scores:"));
		expect(yaml).toContain("code_formatting:");
		expect(yaml).toContain("checked:");
		expect(yaml).toContain("- a");
		expect(yaml).toContain("comments: {}");
		expect(yaml).toContain("deductions: {}");
		expect(yaml).toContain('notes: ""');

		const { load } = await import("js-yaml");
		const parsed = load(yaml) as {
			feedback?: Record<string, { checked: string[] }>;
		};
		expect(parsed.feedback!.code_formatting.checked).toEqual(["a"]);
	});
});
