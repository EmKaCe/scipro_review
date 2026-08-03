// @vitest-environment node
/**
 * @file L5 tests for import-service.ts — teacher-YAML parsing + application.
 *
 * Real temp DATA_DIR (metadata.json + plagiarism cache on disk), the real
 * export service as the YAML producer (round-trip), and the real plagiarism
 * cache for review-status application.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildGradingYaml } from "$lib/server/export-service";
import { ImportError, applyTeacherYaml, parseTeacherYaml } from "$lib/server/import-service";
import { upsertSubmission, type SubmissionRecord } from "$lib/server/metadata";
import { readPlagiarismResult, writePlagiarismResult } from "$lib/server/plagiarism/cache";
import type { PlagiarismPair } from "$lib/server/plagiarism/structural";

const ASSIGNMENT = "soil_contamination";

// ---------------------------------------------------------------------------
// Fixtures & helpers
// ---------------------------------------------------------------------------

function gradedRecord(): SubmissionRecord {
	return {
		id: "2026SS_03",
		studentId: "2026SS_03",
		assignmentId: ASSIGNMENT,
		semester: "2026SS",
		fileName: "2026SS_03.ipynb",
		notebookPath: `submissions/${ASSIGNMENT}/2026SS_03.ipynb`,
		status: "graded",
		teacherGrade: 12,
		grading: {
			rubric: { data_quality: "complete" },
			dimensions: { code_quality_design: 1.5 },
			feedback: {
				code_formatting: {
					checked: ["a", "b"],
					comments: { a: "c" },
					deductions: { b: 0.5 },
					notes: "<p>n</p>",
				},
			},
			notes: "Good structure.",
			updatedAt: "2026-07-31T10:00:00.000Z",
		},
		createdAt: "2026-07-30T08:00:00.000Z",
		updatedAt: "2026-07-31T10:00:00.000Z",
	};
}

function pair(studentA: string, studentB: string): PlagiarismPair {
	return {
		studentA,
		studentB,
		cellOverlap: 0.8,
		notebookOverlap: 0.7,
		matchedCells: [{ cellIndexA: 0, cellIndexB: 0, similarity: 0.9 }],
		flags: ["shared_imports"],
		details: { cellCountDiff: 0, sharedVariableNames: [], sharedComments: [], sharedImports: ["numpy"] },
	};
}

let dataDir: string;

beforeEach(async () => {
	dataDir = await mkdtemp(path.join(os.tmpdir(), "scipro-import-"));
	vi.stubEnv("DATA_DIR", dataDir);
});

afterEach(async () => {
	vi.unstubAllEnvs();
	await rm(dataDir, { recursive: true, force: true });
});

async function seedSubmission(
	studentId: string,
	status: "pending" | "executing" | "executed" | "error" | "graded" = "pending",
	extra: Record<string, unknown> = {},
) {
	return upsertSubmission(ASSIGNMENT, studentId, {
		semester: "2026SS",
		fileName: `${studentId}.ipynb`,
		notebookPath: `submissions/${ASSIGNMENT}/${studentId}.ipynb`,
		status,
		...extra,
	});
}

// ---------------------------------------------------------------------------
// parseTeacherYaml
// ---------------------------------------------------------------------------

describe("parseTeacherYaml", () => {
	it("round-trips buildGradingYaml output (grade, scores, rubric, feedback, notes, plagiarism)", () => {
		const yaml = buildGradingYaml(gradedRecord(), {
			plagiarism: {
				pairs: [
					{ studentB: "2026SS_02", severity: "high", notebookOverlap: 0.8, reviewStatus: "accepted" },
				],
			},
		});

		const parsed = parseTeacherYaml(yaml);

		expect(parsed.studentId).toBe("2026SS_03");
		expect(parsed.assignmentId).toBe(ASSIGNMENT);
		expect(parsed.teacherGrade).toBe(12);
		expect(parsed.scores).toEqual({ code_quality_design: 1.5 });
		expect(parsed.rubric).toEqual({ data_quality: "complete" });
		expect(parsed.feedback?.code_formatting.checked).toEqual(["a", "b"]);
		expect(parsed.feedback?.code_formatting.comments).toEqual({ a: "c" });
		expect(parsed.feedback?.code_formatting.deductions).toEqual({ b: 0.5 });
		expect(parsed.feedback?.code_formatting.notes).toBe("<p>n</p>");
		expect(parsed.notes).toBe("Good structure.");
		expect(parsed.plagiarism).toEqual([{ studentB: "2026SS_02", reviewStatus: "accepted" }]);
	});

	it("accepts a minimal document with only the required keys", () => {
		const parsed = parseTeacherYaml(`student_id: 2026SS_03\nassignment: ${ASSIGNMENT}`);

		expect(parsed.studentId).toBe("2026SS_03");
		expect(parsed.assignmentId).toBe(ASSIGNMENT);
		expect(parsed.teacherGrade).toBeUndefined();
		expect(parsed.scores).toBeUndefined();
		expect(parsed.plagiarism).toBeUndefined();
	});

	it("rejects malformed documents with ImportError", () => {
		expect(() => parseTeacherYaml("assignment: soil_contamination")).toThrow(/student_id/);
		expect(() => parseTeacherYaml("student_id: 2026SS_03\nassignment: soil\nscores: [1,2]")).toThrow(/scores/);
		expect(() => parseTeacherYaml("student_id: 2026SS_03\nassignment: soil\nrubric: [a]")).toThrow(/rubric/);
		expect(() => parseTeacherYaml("student_id: 2026SS_03\nassignment: soil\nteacher_grade: many")).toThrow(/teacher_grade/);
		expect(() => parseTeacherYaml("student_id: 2026SS_03\nassignment: soil\nnotes: [1]")).toThrow(/notes/);
		expect(() =>
			parseTeacherYaml("student_id: 2026SS_03\nassignment: soil\nfeedback:\n  x:\n    checked: nope"),
		).toThrow(/feedback/);
		expect(() =>
			parseTeacherYaml(
				"student_id: 2026SS_03\nassignment: soil\nplagiarism:\n  - student_b: 2026SS_02\n    review_status: maybe",
			),
		).toThrow(/review_status/);
		expect(() => parseTeacherYaml("not: [valid")).toThrow(ImportError);
	});

	it("sets the ImportError name", () => {
		try {
			parseTeacherYaml("student_id: 2026SS_03\nassignment: soil\nscores: [1]");
			expect.unreachable("expected parseTeacherYaml to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(ImportError);
			expect((err as Error).name).toBe("ImportError");
		}
	});
});

// ---------------------------------------------------------------------------
// applyTeacherYaml
// ---------------------------------------------------------------------------

describe("applyTeacherYaml", () => {
	it("applies teacherGrade + status graded, writes grading (notes replaced), and updates pair review statuses", async () => {
		await seedSubmission("2026SS_03", "executed", {
			grading: { rubric: {}, dimensions: {}, notes: "old notes", updatedAt: new Date().toISOString() },
		});
		await writePlagiarismResult(ASSIGNMENT, {
			status: "done",
			assignmentId: ASSIGNMENT,
			generatedAt: new Date().toISOString(),
			pairs: [pair("2026SS_02", "2026SS_03"), pair("2026SS_03", "2026SS_05")],
			totalPairs: 2,
			comparedSubmissions: ["2026SS_02", "2026SS_03", "2026SS_05"],
		});

		const record = await applyTeacherYaml(ASSIGNMENT, "2026SS_03", {
			studentId: "2026SS_03",
			assignmentId: ASSIGNMENT,
			teacherGrade: 12,
			scores: { code_quality_design: 1.5 },
			rubric: { data_quality: "complete" },
			feedback: {
				code_formatting: { checked: ["a"], comments: {}, deductions: {}, notes: "n" },
			},
			notes: "replaced notes",
			plagiarism: [
				{ studentB: "2026SS_02", reviewStatus: "accepted" },
				{ studentB: "2026SS_99", reviewStatus: "dismissed" }, // pair absent -> skipped
			],
		});

		expect(record.teacherGrade).toBe(12);
		expect(record.status).toBe("graded");
		expect(record.grading?.dimensions).toEqual({ code_quality_design: 1.5 });
		expect(record.grading?.rubric).toEqual({ data_quality: "complete" });
		expect(record.grading?.feedback).toEqual({
			code_formatting: { checked: ["a"], comments: {}, deductions: {}, notes: "n" },
		});
		expect(record.grading?.notes).toBe("replaced notes"); // replaced, not merged with "old notes"

		const cache = await readPlagiarismResult(ASSIGNMENT);
		expect(
			cache?.pairs.find((p) => p.studentA === "2026SS_02" && p.studentB === "2026SS_03")?.reviewStatus,
		).toBe("accepted");
		expect(
			cache?.pairs.find((p) => p.studentA === "2026SS_03" && p.studentB === "2026SS_05")?.reviewStatus,
		).toBeUndefined();
	});

	it("keeps the existing status when no teacher_grade is present", async () => {
		await seedSubmission("2026SS_03", "executed");

		const record = await applyTeacherYaml(ASSIGNMENT, "2026SS_03", {
			studentId: "2026SS_03",
			assignmentId: ASSIGNMENT,
			scores: { code_quality_design: 1 },
		});

		expect(record.status).toBe("executed");
		expect(record.teacherGrade).toBeUndefined();
		expect(record.grading?.dimensions).toEqual({ code_quality_design: 1 });
	});

	it("ignores plagiarism entries when the cache (or the pair) is absent", async () => {
		await seedSubmission("2026SS_03", "executed");

		const record = await applyTeacherYaml(ASSIGNMENT, "2026SS_03", {
			studentId: "2026SS_03",
			assignmentId: ASSIGNMENT,
			plagiarism: [{ studentB: "2026SS_02", reviewStatus: "accepted" }],
		});

		expect(record.studentId).toBe("2026SS_03");
		expect(await readPlagiarismResult(ASSIGNMENT)).toBeNull();
	});

	it("creates a missing submission record (upsert) with teacher grade", async () => {
		const record = await applyTeacherYaml(ASSIGNMENT, "2026SS_03", {
			studentId: "2026SS_03",
			assignmentId: ASSIGNMENT,
			teacherGrade: 10,
			notes: "fresh",
		});

		expect(record.teacherGrade).toBe(10);
		expect(record.status).toBe("graded");
		expect(record.grading?.notes).toBe("fresh");
	});
});
