/**
 * @file L5 tests for the rune-based submissions store.
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
	saveGrading: vi.fn(),
	importTeacherYaml: vi.fn(),
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

		expect(api.fetchSubmissions).toHaveBeenCalledWith(undefined, false);
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

		expect(api.fetchSubmissions).toHaveBeenCalledWith("atom_interaction", false);
		expect(store.assignmentId).toBe(ASSIGNMENT); // response wins
	});

	it("records the error state and rethrows on failure", async () => {
		api.fetchSubmissions.mockRejectedValue(new Error("boom"));

		await expect(store.load()).rejects.toThrow("boom");
		expect(store.status).toBe("error");
		expect(store.error).toBe("boom");
	});

	it("forwards includeArchived when the archived view is requested", async () => {
		api.fetchSubmissions.mockResolvedValue(list(meta("2026SS_01", "archived")));

		store.includeArchived = true;
		await store.load();

		expect(api.fetchSubmissions).toHaveBeenCalledWith(undefined, true);
		expect(store.submissions).toHaveLength(1);
		expect(store.submissions[0]!.status).toBe("archived");
	});

	it("starts polling when the loaded list contains an executing row", async () => {
		api.fetchSubmissions.mockResolvedValue(list(meta("2026SS_01", "executing")));

		await store.load();

		expect(store.isPolling).toBe(true);
	});

	it("does not poll when the loaded list is fully settled", async () => {
		api.fetchSubmissions.mockResolvedValue(
			list(meta("2026SS_01", "executed"), meta("2026SS_02", "error")),
		);

		await store.load();

		expect(store.isPolling).toBe(false);
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

	it("uploadMany() batches all files into one request + one refresh", async () => {
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
				{
					fileName: "notes.pdf",
					kind: "material-file",
					replaced: false,
					bytes: 3,
					relativePath: `materials/${ASSIGNMENT}/notes.pdf`,
				},
			],
		});
		await store.load();

		const files = [new File(["{}"], "2026SS_01.ipynb"), new File(["pdf"], "notes.pdf")];
		const response = await store.uploadMany([
			{ file: files[0] },
			{ file: files[1], kind: "material-file" },
		]);

		// ONE upload request carrying every file; kinds map only holds overrides.
		expect(api.uploadSubmissions).toHaveBeenCalledTimes(1);
		expect(api.uploadSubmissions).toHaveBeenCalledWith(
			[files[0], files[1]],
			ASSIGNMENT,
			{ "notes.pdf": "material-file" },
		);
		// load + a single list refresh (not one refresh per file) + one poll.
		expect(api.fetchSubmissions).toHaveBeenCalledTimes(2);
		expect(store.isPolling).toBe(true);
		expect(response.results).toHaveLength(2);
	});

	it("uploadMany() omits the kinds field entirely when no overrides given", async () => {
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

		await store.uploadMany([{ file: new File(["{}"], "2026SS_01.ipynb") }]);

		expect(api.uploadSubmissions).toHaveBeenCalledWith(
			[expect.any(File)],
			ASSIGNMENT,
			undefined,
		);
	});

	it("uploadMany() refuses to run without a loaded assignment", async () => {
		await expect(
			store.uploadMany([{ file: new File(["{}"], "a.ipynb") }]),
		).rejects.toThrow("No assignment selected");
		expect(api.uploadSubmissions).not.toHaveBeenCalled();
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

	it("select() adopts the detail record's assignment for deep links", async () => {
		// A submission whose assignment is NOT the store's current one —
		// the deep-link path (bookmark/refresh/share) where the detail
		// response is the only source of the correct batch.
		api.fetchSubmission.mockResolvedValue({
			...detail("2026SS_01"),
			assignmentId: "molecular_dynamics",
		});

		await store.select("2026SS_01");

		expect(store.assignmentId).toBe("molecular_dynamics");
	});

	it("saveGrading() merges the updated record into the list", async () => {
		api.fetchSubmissions.mockResolvedValue(list(meta("2026SS_01", "executed")));
		api.saveGrading.mockResolvedValue({
			...meta("2026SS_01", "executed"),
			updatedAt: "2026-07-28T11:00:00Z",
		});
		await store.load();

		await store.saveGrading("2026SS_01", { rubric: { a: "b" } });
		expect(api.saveGrading).toHaveBeenCalledWith(
			"2026SS_01",
			{ rubric: { a: "b" } },
			ASSIGNMENT,
		);
		expect(store.submissions[0]?.updatedAt).toBe("2026-07-28T11:00:00Z");
	});

	it("importTeacherYaml() posts the yaml and merges the record into list + detail cache", async () => {
		api.fetchSubmissions.mockResolvedValue(list(meta("2026SS_01", "executed")));
		api.fetchSubmission.mockResolvedValue(detail("2026SS_01"));
		api.importTeacherYaml.mockResolvedValue({
			...meta("2026SS_01", "graded"),
			teacherGrade: 12,
		});
		await store.load();
		await store.select("2026SS_01");

		const record = await store.importTeacherYaml("2026SS_01", "student_id: 2026SS_01");

		expect(api.importTeacherYaml).toHaveBeenCalledWith(
			"2026SS_01",
			"student_id: 2026SS_01",
			ASSIGNMENT,
		);
		expect(record).toMatchObject({ status: "graded", teacherGrade: 12 });
		expect(store.submissions[0]).toMatchObject({ status: "graded", teacherGrade: 12 });
		expect(store.getDetail("2026SS_01")).toMatchObject({ status: "graded", teacherGrade: 12 });
		expect(store.selected).toMatchObject({ status: "graded", teacherGrade: 12 });
	});

	it("importTeacherYaml() forwards undefined when no assignment is loaded", async () => {
		api.importTeacherYaml.mockResolvedValue(meta("2026SS_01", "executed"));

		await store.importTeacherYaml("2026SS_01", "student_id: 2026SS_01");

		expect(api.importTeacherYaml).toHaveBeenCalledWith(
			"2026SS_01",
			"student_id: 2026SS_01",
			undefined,
		);
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
		api.fetchSubmission.mockResolvedValue(detail("2026SS_01"));

		const { listSubmissions, getSubmission } =
			await import("$lib/services/submissions-store.js");
		await store.load();

		const snapshot = listSubmissions();
		expect(snapshot).toEqual([meta("2026SS_01", "executed")]);
		expect(snapshot).not.toBe(store.submissions); // copy, not the live array

		// The snapshot stays a copy — a later list mutation (here via
		// applyRecord from saveGrading) never mutates the earlier snapshot.
		api.saveGrading.mockResolvedValue({
			...meta("2026SS_01", "graded"),
			teacherGrade: 2.0,
		});
		await store.saveGrading("2026SS_01", { rubric: { a: "b" } });
		expect(listSubmissions()[0]?.status).toBe("graded");
		expect(snapshot[0]?.status).toBe("executed"); // earlier snapshot unchanged

		expect(getSubmission("2026SS_01")).toBeNull(); // nothing cached yet
		await store.select("2026SS_01");
		expect(getSubmission("2026SS_01")).toEqual(detail("2026SS_01"));
	});
});
