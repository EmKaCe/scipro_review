/**
 * @file L5 API-contract tests for the submissions API client.
 *
 * Mocks global fetch and asserts request shapes (method, URL, JSON/FormData
 * bodies, query params), response parsing, and ApiError mapping for HTTP and
 * network failures.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SubmissionDetail, SubmissionMeta } from "$lib/types/submissions.js";

import {
	ApiError,
	checkPlagiarism,
	exportSubmission,
	fetchAssignments,
	fetchMaterials,
	fetchPlagiarismResults,
	fetchSubmission,
	fetchSubmissions,
	gradeSubmission,
	importTeacherYaml,
	processSubmission,
	processSubmissions,
	saveGrading,
	uploadCriteria,
	uploadSubmissions,
} from "$lib/services/submissions-api.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ASSIGNMENT = "soil_contamination";

function meta(id: string, status: SubmissionMeta["status"] = "pending"): SubmissionMeta {
	return {
		id,
		studentId: id,
		assignmentId: ASSIGNMENT,
		semester: "2026SS",
		status,
		createdAt: "2026-07-28T10:00:00Z",
		updatedAt: "2026-07-28T10:00:00Z",
	};
}

function detail(id: string): SubmissionDetail {
	return {
		...meta(id, "executed"),
		cells: [{ index: 0, type: "code", source: "x = 1", output: "1", marker: "different" }],
	};
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
	fetchMock = vi.fn();
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Submissions
// ---------------------------------------------------------------------------

describe("fetchSubmissions", () => {
	it("GETs /api/submissions with the assignment param and parses the list", async () => {
		const submissions = [meta("2026SS_01", "pending"), meta("2026SS_02", "executed")];
		fetchMock.mockResolvedValue(jsonResponse({ assignmentId: ASSIGNMENT, submissions }));

		const result = await fetchSubmissions(ASSIGNMENT);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit | undefined];
		expect(url).toBe(`/api/submissions?assignment=${ASSIGNMENT}`);
		expect(init?.method ?? "GET").toBe("GET");
		expect(result).toEqual({ assignmentId: ASSIGNMENT, submissions });
	});

	it("omits the query param when no assignment is given", async () => {
		fetchMock.mockResolvedValue(jsonResponse({ assignmentId: ASSIGNMENT, submissions: [] }));

		await fetchSubmissions();

		expect(fetchMock).toHaveBeenCalledWith("/api/submissions", undefined);
	});
});

describe("fetchSubmission", () => {
	it("GETs /api/submissions/[id] and returns the detail shape", async () => {
		const submission = detail("2026SS_03");
		fetchMock.mockResolvedValue(jsonResponse(submission));

		const result = await fetchSubmission("2026SS_03", ASSIGNMENT);

		expect(fetchMock).toHaveBeenCalledWith(
			`/api/submissions/2026SS_03?assignment=${ASSIGNMENT}`,
			undefined,
		);
		expect(result).toEqual(submission);
	});

	it("surfaces the persisted grading block (dimensions + feedback) on the parsed detail", async () => {
		const submission: SubmissionDetail = {
			...detail("2026SS_03"),
			grading: {
				dimensions: { code_quality_design: 4.5, creativity: 2 },
				feedback: {
					code_formatting: {
						checked: ["blank lines - consistent"],
						comments: { "blank lines - consistent": "explain" },
						deductions: { "blank lines - consistent": 0.5 },
						notes: "<p>n</p>",
					},
				},
				updatedAt: "2026-07-30T09:00:00Z",
			},
		};
		fetchMock.mockResolvedValue(jsonResponse(submission));

		const result = await fetchSubmission("2026SS_03", ASSIGNMENT);

		expect(result.grading?.dimensions).toEqual({ code_quality_design: 4.5, creativity: 2 });
		expect(result.grading?.feedback?.code_formatting).toEqual({
			checked: ["blank lines - consistent"],
			comments: { "blank lines - consistent": "explain" },
			deductions: { "blank lines - consistent": 0.5 },
			notes: "<p>n</p>",
		});
		expect(result.grading?.updatedAt).toBe("2026-07-30T09:00:00Z");
	});
});

describe("uploadSubmissions", () => {
	it("builds a multipart FormData with files, assignmentId and kinds overrides", async () => {
		const files = [new File(["{}"], "2026SS_03.ipynb", { type: "application/json" })];
		const kinds = { "notes.pdf": "material-data" as const };
		fetchMock.mockResolvedValue(
			jsonResponse({
				assignmentId: ASSIGNMENT,
				results: [
					{
						fileName: "2026SS_03.ipynb",
						kind: "submission",
						studentId: "2026SS_03",
						semester: "2026SS",
						replaced: false,
						bytes: 2,
						notebookPath: `submissions/${ASSIGNMENT}/2026SS_03.ipynb`,
					},
				],
			}),
		);

		const result = await uploadSubmissions(files, ASSIGNMENT, kinds);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("/api/submissions/upload");
		expect(init.method).toBe("POST");
		expect(init.body).toBeInstanceOf(FormData);
		const form = init.body as FormData;
		expect(form.get("assignmentId")).toBe(ASSIGNMENT);
		expect(form.getAll("files")).toHaveLength(1);
		expect(JSON.parse(String(form.get("kinds")))).toEqual(kinds);
		expect(result.results[0]).toMatchObject({ kind: "submission", studentId: "2026SS_03" });
	});

	it("omits the kinds field when no overrides are given", async () => {
		fetchMock.mockResolvedValue(jsonResponse({ assignmentId: ASSIGNMENT, results: [] }));

		await uploadSubmissions([new File(["{}"], "a.ipynb")], ASSIGNMENT);

		const form = (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as FormData;
		expect(form.get("kinds")).toBeNull();
	});
});

describe("processSubmissions", () => {
	it("POSTs ids + assignmentId as JSON and parses the batch result", async () => {
		const response = {
			assignmentId: ASSIGNMENT,
			submitted: 1,
			succeeded: 1,
			failed: 0,
			totalDurationSeconds: 3.2,
			results: [{ studentId: "2026SS_01", success: true, error: null }],
		};
		fetchMock.mockResolvedValue(jsonResponse(response));

		const result = await processSubmissions(["2026SS_01"], ASSIGNMENT);

		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("/api/submissions/process");
		expect(init.method).toBe("POST");
		expect(JSON.parse(String(init.body))).toEqual({
			assignmentId: ASSIGNMENT,
			ids: ["2026SS_01"],
		});
		expect(result).toEqual(response);
	});

	it("sends an empty object when ids and assignment are omitted", async () => {
		fetchMock.mockResolvedValue(
			jsonResponse({
				assignmentId: ASSIGNMENT,
				submitted: 0,
				succeeded: 0,
				failed: 0,
				totalDurationSeconds: 0,
				results: [],
			}),
		);

		await processSubmissions();

		const init = (fetchMock.mock.calls[0] as [string, RequestInit])[1];
		expect(JSON.parse(String(init.body))).toEqual({});
	});
});

describe("processSubmission", () => {
	it("POSTs /api/submissions/[id]/process with the assignment param", async () => {
		fetchMock.mockResolvedValue(
			jsonResponse({
				success: true,
				notebookPath: `submissions/${ASSIGNMENT}/2026SS_03.ipynb`,
				cells: [],
				totalCells: 2,
				executedCells: 2,
				errorCells: 0,
				durationSeconds: 0.5,
				preprocessing: {
					cellsModified: 0,
					totalEdits: 0,
					editTypes: {},
					llmPreprocessing: "skipped",
					llmAnalysis: false,
				},
				modifiedFiles: [],
				record: meta("2026SS_03", "executed"),
			}),
		);

		const result = await processSubmission("2026SS_03", ASSIGNMENT);

		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(`/api/submissions/2026SS_03/process?assignment=${ASSIGNMENT}`);
		expect(init.method).toBe("POST");
		expect(result.record.status).toBe("executed");
		expect(result.totalCells).toBe(2);
	});
});

describe("saveGrading", () => {
	it("POSTs the grading patch as JSON", async () => {
		const grading = { rubric: { clarity: "good" }, dimensions: { style: 1.5 }, notes: "nice" };
		fetchMock.mockResolvedValue(jsonResponse(meta("2026SS_03", "executed")));

		const result = await saveGrading("2026SS_03", grading, ASSIGNMENT);

		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(`/api/submissions/2026SS_03/save?assignment=${ASSIGNMENT}`);
		expect(JSON.parse(String(init.body))).toEqual(grading);
		expect(result.id).toBe("2026SS_03");
	});

	it("sends feedback and dimensions in the patch body", async () => {
		const feedback = {
			code_formatting: { checked: ["a"], comments: {}, deductions: {}, notes: "n" },
		};
		fetchMock.mockResolvedValue(jsonResponse(meta("2026SS_03", "executed")));

		await saveGrading("2026SS_03", { feedback, dimensions: { style: 1.5 } }, ASSIGNMENT);

		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(`/api/submissions/2026SS_03/save?assignment=${ASSIGNMENT}`);
		expect(JSON.parse(String(init.body))).toEqual({ feedback, dimensions: { style: 1.5 } });
	});
});

describe("gradeSubmission", () => {
	it("POSTs the teacherGrade and returns the updated record", async () => {
		fetchMock.mockResolvedValue(
			jsonResponse({ ...meta("2026SS_03", "graded"), teacherGrade: 2.0 }),
		);

		const result = await gradeSubmission("2026SS_03", 2.0, ASSIGNMENT);

		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(`/api/submissions/2026SS_03/grade?assignment=${ASSIGNMENT}`);
		expect(JSON.parse(String(init.body))).toEqual({ teacherGrade: 2.0 });
		expect(result).toMatchObject({ status: "graded", teacherGrade: 2.0 });
	});
});

describe("importTeacherYaml", () => {
	it("POSTs the yaml text as a JSON envelope with the assignment param", async () => {
		const yaml = "student_id: 2026SS_03\nassignment: soil_contamination";
		fetchMock.mockResolvedValue(
			jsonResponse({ ...meta("2026SS_03", "graded"), teacherGrade: 12 }),
		);

		const result = await importTeacherYaml("2026SS_03", yaml, ASSIGNMENT);

		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(`/api/submissions/2026SS_03/import?assignment=${ASSIGNMENT}`);
		expect(init.method).toBe("POST");
		expect(init.headers).toEqual({ "Content-Type": "application/json" });
		expect(JSON.parse(String(init.body))).toEqual({ yaml });
		expect(result).toMatchObject({ status: "graded", teacherGrade: 12 });
	});

	it("omits the assignment param when not given", async () => {
		fetchMock.mockResolvedValue(jsonResponse(meta("2026SS_03", "executed")));

		await importTeacherYaml("2026SS_03", "student_id: 2026SS_03");

		const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("/api/submissions/2026SS_03/import");
	});
});

describe("exportSubmission", () => {
	it("GETs the export endpoint and returns the YAML text with a file name", async () => {
		fetchMock.mockResolvedValue(
			new Response("studentId: 2026SS_03\n", {
				status: 200,
				headers: { "Content-Type": "application/yaml" },
			}),
		);

		const result = await exportSubmission("2026SS_03", ASSIGNMENT);

		expect(fetchMock).toHaveBeenCalledWith(
			`/api/submissions/2026SS_03/export?assignment=${ASSIGNMENT}&kind=student`,
			undefined,
		);
		expect(result).toEqual({ fileName: "2026SS_03.yaml", content: "studentId: 2026SS_03\n" });
	});
});

// ---------------------------------------------------------------------------
// Assignments
// ---------------------------------------------------------------------------

describe("fetchAssignments", () => {
	it("GETs /api/assignments and returns the enabled list", async () => {
		const assignments = [
			{
				id: ASSIGNMENT,
				title: "Soil Contamination",
				enabled: true,
				criteria_files: ["data/criteria/general.yaml"],
			},
		];
		fetchMock.mockResolvedValue(jsonResponse({ assignments }));

		const result = await fetchAssignments();

		expect(fetchMock).toHaveBeenCalledWith("/api/assignments", undefined);
		expect(result.assignments[0]).toMatchObject({ id: ASSIGNMENT, enabled: true });
	});
});

describe("uploadCriteria", () => {
	it("POSTs the file as multipart field 'file' and maps the 201 response", async () => {
		fetchMock.mockResolvedValue(
			jsonResponse({
				fileName: "data/criteria/soil_v2.yaml",
				criteria_files: ["data/criteria/general.yaml", "data/criteria/soil_v2.yaml"],
			}),
		);
		const file = new File(["categories: {}\n"], "soil_v2.yaml", { type: "text/yaml" });

		const result = await uploadCriteria(ASSIGNMENT, file);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(`/api/assignments/${ASSIGNMENT}/criteria`);
		expect(init.method).toBe("POST");
		expect(init.body).toBeInstanceOf(FormData);
		const form = init.body as FormData;
		expect(form.get("file")).toBe(file);
		expect(result).toEqual({
			fileName: "data/criteria/soil_v2.yaml",
			criteria_files: ["data/criteria/general.yaml", "data/criteria/soil_v2.yaml"],
		});
	});

	it("URL-encodes the assignment id", async () => {
		fetchMock.mockResolvedValue(jsonResponse({ fileName: "", criteria_files: [] }));

		await uploadCriteria("soil contamination", new File(["x"], "a.yaml"));

		const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("/api/assignments/soil%20contamination/criteria");
	});

	it("maps a 400 error body to ApiError with the server message", async () => {
		fetchMock.mockResolvedValue(
			jsonResponse(
				{ message: "category key code_formatting already exists in general.yaml" },
				400,
			),
		);

		await expect(
			uploadCriteria(ASSIGNMENT, new File(["x"], "dupe.yaml")),
		).rejects.toMatchObject({
			status: 400,
			message: "category key code_formatting already exists in general.yaml",
		});
	});
});

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

describe("fetchMaterials", () => {
	it("GETs /api/assignments/[id]/materials and maps the status flags + files", async () => {
		fetchMock.mockResolvedValue(
			jsonResponse({
				assignmentId: ASSIGNMENT,
				hasPdf: true,
				hasKey: false,
				hasInputData: true,
				files: [
					{
						name: "assignment.pdf",
						kind: "material-file",
						relativePath: "materials/assignment.pdf",
					},
					{
						name: "measurements.csv",
						kind: "material-data",
						relativePath: "input/measurements.csv",
					},
				],
			}),
		);

		const result = await fetchMaterials(ASSIGNMENT);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock).toHaveBeenCalledWith(
			`/api/assignments/${ASSIGNMENT}/materials`,
			undefined,
		);
		expect(result.hasPdf).toBe(true);
		expect(result.hasKey).toBe(false);
		expect(result.hasInputData).toBe(true);
		expect(result.files).toEqual([
			{
				name: "assignment.pdf",
				kind: "material-file",
				relativePath: "materials/assignment.pdf",
			},
			{
				name: "measurements.csv",
				kind: "material-data",
				relativePath: "input/measurements.csv",
			},
		]);
	});

	it("URL-encodes the assignment id", async () => {
		fetchMock.mockResolvedValue(
			jsonResponse({
				assignmentId: "soil contamination",
				hasPdf: false,
				hasKey: false,
				hasInputData: false,
				files: [],
			}),
		);

		await fetchMaterials("soil contamination");

		expect(fetchMock).toHaveBeenCalledWith(
			"/api/assignments/soil%20contamination/materials",
			undefined,
		);
	});
});

// ---------------------------------------------------------------------------
// Plagiarism
// ---------------------------------------------------------------------------

describe("plagiarism endpoints", () => {
	it("checkPlagiarism POSTs the assignment + options to /api/plagiarism/check", async () => {
		fetchMock.mockResolvedValue(
			jsonResponse({
				status: "done",
				assignmentId: ASSIGNMENT,
				generatedAt: "2026-07-31T12:00:00Z",
				pairs: [],
				totalPairs: 10,
				comparedSubmissions: ["2026SS_01", "2026SS_02"],
				semanticChecked: false,
			}),
		);

		const result = await checkPlagiarism(ASSIGNMENT, { semantic: true, ngramSize: 4 });

		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("/api/plagiarism/check");
		expect(JSON.parse(String(init.body))).toEqual({
			assignmentId: ASSIGNMENT,
			semantic: true,
			ngramSize: 4,
		});
		expect(result.status).toBe("done");
		expect(result.totalPairs).toBe(10);
	});

	it("checkPlagiarism sends only the assignmentId when no options are given", async () => {
		fetchMock.mockResolvedValue(
			jsonResponse({
				status: "done",
				assignmentId: ASSIGNMENT,
				generatedAt: "",
				pairs: [],
				totalPairs: 0,
				comparedSubmissions: [],
			}),
		);

		await checkPlagiarism(ASSIGNMENT);

		const init = (fetchMock.mock.calls[0] as [string, RequestInit])[1];
		expect(JSON.parse(String(init.body))).toEqual({ assignmentId: ASSIGNMENT });
	});

	it("fetchPlagiarismResults GETs /api/plagiarism/results with the assignmentId param", async () => {
		fetchMock.mockResolvedValue(
			jsonResponse({
				status: "done",
				assignmentId: ASSIGNMENT,
				generatedAt: "2026-07-31T12:00:00Z",
				pairs: [
					{
						studentA: "2026SS_01",
						studentB: "2026SS_02",
						cellOverlap: 0.87,
						notebookOverlap: 0.72,
						matchedCells: [{ cellIndexA: 1, cellIndexB: 2, similarity: 0.9 }],
						flags: ["shared_imports"],
						details: {
							cellCountDiff: 0,
							sharedVariableNames: ["x"],
							sharedComments: [],
							sharedImports: ["numpy"],
						},
					},
				],
				totalPairs: 1,
				comparedSubmissions: ["2026SS_01", "2026SS_02"],
			}),
		);

		const result = await fetchPlagiarismResults(ASSIGNMENT);

		expect(fetchMock).toHaveBeenCalledWith(
			`/api/plagiarism/results?assignmentId=${ASSIGNMENT}`,
			undefined,
		);
		expect(result.pairs[0]).toMatchObject({ cellOverlap: 0.87, flags: ["shared_imports"] });
	});
});

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

describe("error mapping", () => {
	it("maps a non-2xx JSON body to ApiError with status and message", async () => {
		fetchMock.mockResolvedValue(jsonResponse({ message: 'Assignment "nope" not found' }, 404));

		const promise = fetchSubmissions("nope");

		await expect(promise).rejects.toBeInstanceOf(ApiError);
		await expect(promise).rejects.toMatchObject({
			status: 404,
			message: 'Assignment "nope" not found',
		});
	});

	it("falls back to a generic message when the error body is not JSON", async () => {
		fetchMock.mockResolvedValue(new Response("Internal Server Error", { status: 500 }));

		await expect(fetchSubmissions()).rejects.toMatchObject({
			status: 500,
			message: "Request failed with status 500",
		});
	});

	it("maps network failures to ApiError with status 0", async () => {
		fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

		await expect(fetchSubmissions()).rejects.toMatchObject({
			status: 0,
			message: "Failed to fetch",
		});
	});
});
