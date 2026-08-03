/**
 * @file L5 tests for the rune-based submissions store (3f.1).
 *
 * Mocks the submissions-api module and exercises the store with fake timers:
 * load/error state, the D5 2-second polling loop (start/stop/idempotence,
 * auto-stop when nothing is pending/executing), mutation actions, and the
 * legacy sync wrappers. Each test gets a fresh store instance via
 * vi.resetModules() + dynamic import.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SubmissionDetail, SubmissionMeta } from "$lib/types/submissions.js";
import type { SubmissionsStore } from "$lib/services/submissions-store.svelte.js";

// ---------------------------------------------------------------------------
// Mock the API client
// ---------------------------------------------------------------------------

const api = vi.hoisted(() => ({
	fetchSubmissions: vi.fn(),
	fetchSubmission: vi.fn(),
	uploadSubmissions: vi.fn(),
	processSubmissions: vi.fn(),
	processSubmission: vi.fn(),
	saveGrading: vi.fn(),
	gradeSubmission: vi.fn(),
	exportSubmission: vi.fn(),
}));

vi.mock("$lib/services/submissions-api.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("$lib/services/submissions-api.js")>();
	return { ...actual, ...api };
});

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

function list(...submissions: SubmissionMeta[]) {
	return { assignmentId: ASSIGNMENT, submissions };
}

function batchResponse(
	overrides: Partial<{ submitted: number; succeeded: number; failed: number }> = {},
) {
	return {
		assignmentId: ASSIGNMENT,
		submitted: 1,
		succeeded: 1,
		failed: 0,
		totalDurationSeconds: 1.5,
		results: [{ studentId: "2026SS_01", success: true, error: null }],
		...overrides,
	};
}

function executionResponse(record: SubmissionMeta) {
	return {
		success: true,
		notebookPath: `submissions/${ASSIGNMENT}/2026SS_01.ipynb`,
		cells: [],
		totalCells: 1,
		executedCells: 1,
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
		record,
	};
}

// ---------------------------------------------------------------------------
// Setup: fresh store per test
// ---------------------------------------------------------------------------

let store: SubmissionsStore;

beforeEach(async () => {
	vi.useFakeTimers();
	vi.resetAllMocks();
	vi.resetModules();
	const mod = await import("$lib/services/submissions-store.svelte.js");
	store = mod.submissionsStore;
});

afterEach(() => {
	vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

describe("load", () => {
	it("populates submissions, assignmentId and settles into idle", async () => {
		api.fetchSubmissions.mockResolvedValue(
			list(meta("2026SS_01", "pending"), meta("2026SS_02", "executed")),
		);

		const result = await store.load();

		expect(api.fetchSubmissions).toHaveBeenCalledWith(undefined);
		expect(result).toHaveLength(2);
		expect(store.submissions).toEqual([
			meta("2026SS_01", "pending"),
			meta("2026SS_02", "executed"),
		]);
		expect(store.assignmentId).toBe(ASSIGNMENT);
		expect(store.status).toBe("idle");
		expect(store.error).toBeNull();
	});

	it("passes an explicit assignment id through to the API", async () => {
		api.fetchSubmissions.mockResolvedValue(list(meta("2026SS_01", "pending")));

		await store.load("atom_interaction");

		expect(api.fetchSubmissions).toHaveBeenCalledWith("atom_interaction");
		expect(store.assignmentId).toBe(ASSIGNMENT); // response wins
	});

	it("records the error state and rethrows on failure", async () => {
		api.fetchSubmissions.mockRejectedValue(new Error("boom"));

		await expect(store.load()).rejects.toThrow("boom");

		expect(store.status).toBe("error");
		expect(store.error).toBe("boom");
	});
});

// ---------------------------------------------------------------------------
// Polling (D5)
// ---------------------------------------------------------------------------

describe("polling", () => {
	it("polls every 2 seconds and refreshes the list", async () => {
		api.fetchSubmissions
			.mockResolvedValueOnce(list(meta("2026SS_01", "pending")))
			.mockResolvedValueOnce(list(meta("2026SS_01", "executing")));
		await store.load();
		expect(api.fetchSubmissions).toHaveBeenCalledTimes(1);

		store.startPolling();
		expect(store.isPolling).toBe(true);

		await vi.advanceTimersByTimeAsync(2000);
		expect(api.fetchSubmissions).toHaveBeenCalledTimes(2);
		expect(store.submissions[0]?.status).toBe("executing");
		expect(store.isPolling).toBe(true);
	});

	it("keeps polling while submissions are pending or executing", async () => {
		api.fetchSubmissions.mockResolvedValue(list(meta("2026SS_01", "executing")));
		await store.load();

		store.startPolling();
		await vi.advanceTimersByTimeAsync(4000);

		expect(api.fetchSubmissions).toHaveBeenCalledTimes(1 + 2);
		expect(store.isPolling).toBe(true);
	});

	it("auto-stops after a tick that finds no pending or executing submissions", async () => {
		api.fetchSubmissions
			.mockResolvedValueOnce(list(meta("2026SS_01", "pending")))
			.mockResolvedValueOnce(list(meta("2026SS_01", "executed"), meta("2026SS_02", "error")));
		await store.load();

		store.startPolling();
		await vi.advanceTimersByTimeAsync(2000);

		expect(store.isPolling).toBe(false);
		await vi.advanceTimersByTimeAsync(6000);
		expect(api.fetchSubmissions).toHaveBeenCalledTimes(2);
	});

	it("stopPolling halts the loop", async () => {
		api.fetchSubmissions.mockResolvedValue(list(meta("2026SS_01", "pending")));
		await store.load();

		store.startPolling();
		await vi.advanceTimersByTimeAsync(2000);
		store.stopPolling();

		expect(store.isPolling).toBe(false);
		await vi.advanceTimersByTimeAsync(6000);
		expect(api.fetchSubmissions).toHaveBeenCalledTimes(2);
	});

	it("startPolling is idempotent — no stacked intervals", async () => {
		api.fetchSubmissions.mockResolvedValue(list(meta("2026SS_01", "pending")));
		await store.load();

		store.startPolling();
		store.startPolling();
		await vi.advanceTimersByTimeAsync(4000);

		// 1 load + 2 ticks — a doubled interval would produce 5 calls.
		expect(api.fetchSubmissions).toHaveBeenCalledTimes(3);
	});
});

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

describe("mutations", () => {
	it("process() refreshes the list and polls until the batch settles", async () => {
		api.fetchSubmissions
			.mockResolvedValueOnce(list(meta("2026SS_01", "pending")))
			.mockResolvedValueOnce(list(meta("2026SS_01", "executing")))
			.mockResolvedValueOnce(list(meta("2026SS_01", "executed")));
		api.processSubmissions.mockResolvedValue(batchResponse());
		await store.load();

		const response = await store.process();

		expect(api.processSubmissions).toHaveBeenCalledWith(undefined, ASSIGNMENT);
		expect(response.submitted).toBe(1);
		expect(api.fetchSubmissions).toHaveBeenCalledTimes(2);
		expect(store.isPolling).toBe(true);

		await vi.advanceTimersByTimeAsync(2000);
		expect(store.isPolling).toBe(false);
		expect(store.submissions[0]?.status).toBe("executed");
	});

	it("process(ids) forwards the subset", async () => {
		api.fetchSubmissions.mockResolvedValue(list(meta("2026SS_01", "executed")));
		api.processSubmissions.mockResolvedValue(batchResponse());
		await store.load();

		await store.process(["2026SS_01"]);

		expect(api.processSubmissions).toHaveBeenCalledWith(["2026SS_01"], ASSIGNMENT);
	});

	it("upload() posts files with kind overrides, refreshes and starts polling", async () => {
		api.fetchSubmissions.mockResolvedValue(list(meta("2026SS_01", "pending")));
		api.uploadSubmissions.mockResolvedValue({
			assignmentId: ASSIGNMENT,
			results: [
				{
					fileName: "2026SS_01.ipynb",
					kind: "submission",
					studentId: "2026SS_01",
					semester: "2026SS",
					replaced: false,
					bytes: 2,
					notebookPath: `submissions/${ASSIGNMENT}/2026SS_01.ipynb`,
				},
			],
		});
		await store.load();

		const files = [new File(["{}"], "2026SS_01.ipynb")];
		await store.upload(files, { "notes.pdf": "material-data" });

		expect(api.uploadSubmissions).toHaveBeenCalledWith(files, ASSIGNMENT, {
			"notes.pdf": "material-data",
		});
		expect(api.fetchSubmissions).toHaveBeenCalledTimes(2); // load + refresh
		expect(store.isPolling).toBe(true);
	});

	it("upload() refuses to run without a loaded assignment", async () => {
		await expect(store.upload([new File(["{}"], "a.ipynb")])).rejects.toThrow(
			"No assignment selected",
		);
		expect(api.uploadSubmissions).not.toHaveBeenCalled();
	});

	it("processOne() applies the updated record, refreshes and starts polling", async () => {
		api.fetchSubmissions
			.mockResolvedValueOnce(list(meta("2026SS_01", "pending")))
			.mockResolvedValueOnce(list(meta("2026SS_01", "executing")));
		api.processSubmission.mockResolvedValue(executionResponse(meta("2026SS_01", "executing")));
		await store.load();

		await store.processOne("2026SS_01");

		expect(api.processSubmission).toHaveBeenCalledWith("2026SS_01", ASSIGNMENT);
		expect(store.submissions[0]?.status).toBe("executing");
		expect(store.isPolling).toBe(true);
	});

	it("select() loads and caches the detail", async () => {
		api.fetchSubmission.mockResolvedValue(detail("2026SS_01"));

		const selected = await store.select("2026SS_01");

		expect(api.fetchSubmission).toHaveBeenCalledWith("2026SS_01", undefined);
		expect(selected).toEqual(detail("2026SS_01"));
		expect(store.selected).toEqual(detail("2026SS_01"));
		expect(store.getDetail("2026SS_01")).toEqual(detail("2026SS_01"));
		expect(store.getDetail("missing")).toBeNull();
	});

	it("grade() and saveGrading() merge the updated record into the list", async () => {
		api.fetchSubmissions.mockResolvedValue(list(meta("2026SS_01", "executed")));
		api.gradeSubmission.mockResolvedValue({
			...meta("2026SS_01", "graded"),
			teacherGrade: 2.0,
		});
		api.saveGrading.mockResolvedValue({
			...meta("2026SS_01", "executed"),
			updatedAt: "2026-07-28T11:00:00Z",
		});
		await store.load();

		await store.grade("2026SS_01", 2.0);
		expect(api.gradeSubmission).toHaveBeenCalledWith("2026SS_01", 2.0, ASSIGNMENT);
		expect(store.submissions[0]).toMatchObject({ status: "graded", teacherGrade: 2.0 });

		await store.saveGrading("2026SS_01", { rubric: { a: "b" } });
		expect(api.saveGrading).toHaveBeenCalledWith(
			"2026SS_01",
			{ rubric: { a: "b" } },
			ASSIGNMENT,
		);
		expect(store.submissions[0]?.updatedAt).toBe("2026-07-28T11:00:00Z");
	});

	it("export() forwards the assignment and returns the yaml document", async () => {
		api.fetchSubmissions.mockResolvedValue(list(meta("2026SS_01", "executed")));
		api.exportSubmission.mockResolvedValue({
			fileName: "2026SS_01.yaml",
			content: "studentId: 2026SS_01",
		});
		await store.load();

		const result = await store.export("2026SS_01");

		expect(api.exportSubmission).toHaveBeenCalledWith("2026SS_01", ASSIGNMENT, "student");
		expect(result).toEqual({ fileName: "2026SS_01.yaml", content: "studentId: 2026SS_01" });
	});
});

// ---------------------------------------------------------------------------
// Legacy wrappers
// ---------------------------------------------------------------------------

describe("legacy wrappers", () => {
	it("listSubmissions and getSubmission expose live snapshots without stub data", async () => {
		api.fetchSubmissions.mockResolvedValue(list(meta("2026SS_01", "executed")));
		api.gradeSubmission.mockResolvedValue({
			...meta("2026SS_01", "graded"),
			teacherGrade: 2.0,
		});
		api.fetchSubmission.mockResolvedValue(detail("2026SS_01"));

		const { listSubmissions, getSubmission } =
			await import("$lib/services/submissions-store.js");
		await store.load();

		const snapshot = listSubmissions();
		expect(snapshot).toEqual([meta("2026SS_01", "executed")]);
		expect(snapshot).not.toBe(store.submissions); // copy, not the live array

		await store.grade("2026SS_01", 2.0);
		expect(listSubmissions()[0]?.status).toBe("graded");
		expect(snapshot[0]?.status).toBe("executed"); // earlier snapshot unchanged

		expect(getSubmission("2026SS_01")).toBeNull(); // nothing cached yet
		await store.select("2026SS_01");
		expect(getSubmission("2026SS_01")).toEqual(detail("2026SS_01"));
	});
});
