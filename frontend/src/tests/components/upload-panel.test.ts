/**
 * @file L4 component tests for the real upload flow.
 *
 * Mocks the submissions-api module so the panel can be driven without a
 * network; the store itself is real, and its `upload` resolves a single
 * submission-kind result. The test fires the hidden file input's change
 * event with a real File.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";

import UploadPanel from "$lib/components/submissions/upload-panel.svelte";

// ---------------------------------------------------------------------------
// Mocks — API client only; the store itself is real.
// ---------------------------------------------------------------------------

const api = vi.hoisted(() => ({
	uploadSubmissions: vi.fn(),
	fetchSubmissions: vi.fn(),
}));

vi.mock("$lib/services/submissions-api.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("$lib/services/submissions-api.js")>();
	return { ...actual, ...api };
});

import { submissionsStore } from "$lib/services/submissions-store.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("upload-panel.svelte (real upload flow)", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		vi.clearAllMocks();
		api.uploadSubmissions.mockResolvedValue({
			assignmentId: "soil_contamination",
			results: [
				{
					fileName: "2026SS_05.ipynb",
					kind: "submission",
					studentId: "2026SS_05",
					replaced: false,
					bytes: 10,
				},
			],
		});
		api.fetchSubmissions.mockImplementation(async (assignmentId?: string) => ({
			assignmentId: assignmentId ?? "soil_contamination",
			submissions: [],
		}));
		// Real store state: the default assignment is already loaded, so the
		// panel skips its re-load check.
		submissionsStore.assignmentId = "soil_contamination";
		submissionsStore.submissions = [];
	});

	it("uploads a picked file and shows the server results table", async () => {
		const loadSpy = vi.spyOn(submissionsStore, "load");
		render(UploadPanel, { assignmentId: "soil_contamination" });

		const input = document.querySelector('input[type="file"]') as HTMLInputElement;
		expect(input).not.toBeNull();

		const file = new File(["{}"], "2026SS_05.ipynb", { type: "application/json" });
		await fireEvent.change(input, { target: { files: [file] } });

		// The store already targets this assignment, so no re-load is needed.
		expect(loadSpy).not.toHaveBeenCalled();
		expect(api.uploadSubmissions).toHaveBeenCalledTimes(1);
		expect(api.uploadSubmissions).toHaveBeenCalledWith([file], "soil_contamination", undefined);

		// Results table shows the server response: file name + kind label.
		expect(await screen.findByText("2026SS_05.ipynb")).toBeDefined();
		expect(screen.getByText("Submission")).toBeDefined();
	});

	it("uploads a dropped file through the same upload path", async () => {
		const loadSpy = vi.spyOn(submissionsStore, "load");
		render(UploadPanel, { assignmentId: "soil_contamination" });

		// The drop zone is the empty-state surface.
		const dropZone = screen.getByText("Drop files here or click to browse").parentElement;
		expect(dropZone).not.toBeNull();

		const file = new File(["{}"], "2026SS_05.ipynb", { type: "application/json" });
		// jsdom has no DataTransfer; the component only reads dataTransfer.files.
		const dataTransfer = { files: [file] } as unknown as DataTransfer;

		await fireEvent.drop(dropZone as HTMLElement, { dataTransfer });

		expect(loadSpy).not.toHaveBeenCalled();
		expect(api.uploadSubmissions).toHaveBeenCalledTimes(1);
		expect(api.uploadSubmissions).toHaveBeenCalledWith([file], "soil_contamination", undefined);

		// Same results table as the picker path.
		expect(await screen.findByText("2026SS_05.ipynb")).toBeDefined();
		expect(screen.getByText("Submission")).toBeDefined();
	});

	it("re-loads the store when the panel targets a different assignment", async () => {
		const loadSpy = vi.spyOn(submissionsStore, "load");
		render(UploadPanel, { assignmentId: "another_assignment" });

		const input = document.querySelector('input[type="file"]') as HTMLInputElement;
		const file = new File(["{}"], "2026SS_05.ipynb", { type: "application/json" });
		await fireEvent.change(input, { target: { files: [file] } });

		expect(loadSpy).toHaveBeenCalledWith("another_assignment");
		expect(api.uploadSubmissions).toHaveBeenCalledTimes(1);
		expect(api.uploadSubmissions).toHaveBeenCalledWith([file], "another_assignment", undefined);
		expect(await screen.findByText("2026SS_05.ipynb")).toBeDefined();
	});
});
