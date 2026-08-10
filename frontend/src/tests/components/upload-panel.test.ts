/**
 * @file L4 component tests for the real upload flow.
 *
 * Mocks the submissions-api module so the panel can be driven without a
 * network; the store itself is real, and its `upload` resolves a single
 * submission-kind result. The new UX flow: files are picked/dropped into a
 * preview list (client-side validation), then the "Upload N files" button
 * sends them one request per file.
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

// A minimal valid notebook: client-side validation requires JSON with a
// `cells` array, and the server-side validation mirrors that.
const NOTEBOOK_JSON = JSON.stringify({ cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 });

const notebookFile = (name: string) => new File([NOTEBOOK_JSON], name, { type: "application/json" });

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

	it("picks a file, previews it, uploads on demand and shows the result", async () => {
		const loadSpy = vi.spyOn(submissionsStore, "load");
		render(UploadPanel, { assignmentId: "soil_contamination" });

		const input = document.querySelector('input[type="file"]') as HTMLInputElement;
		expect(input).not.toBeNull();

		// Pick → the file lands in the preview list (no upload yet).
		await fireEvent.change(input, { target: { files: [notebookFile("2026SS_05.ipynb")] } });
		expect(api.uploadSubmissions).not.toHaveBeenCalled();
		expect(await screen.findByText("2026SS_05.ipynb")).toBeDefined();
		expect(screen.getByText("Submission")).toBeDefined();

		// Upload → one request for the single file.
		await fireEvent.click(screen.getByText("Upload 1 file"));

		// The store already targets this assignment, so no re-load is needed.
		expect(loadSpy).not.toHaveBeenCalled();
		expect(api.uploadSubmissions).toHaveBeenCalledTimes(1);
		expect(api.uploadSubmissions).toHaveBeenCalledWith(
			[notebookFile("2026SS_05.ipynb")],
			"soil_contamination",
			undefined,
		);

		// Result row: file name + kind label + Uploaded state.
		expect(await screen.findByText("Uploaded")).toBeDefined();
		expect(screen.getByText("2026SS_05.ipynb")).toBeDefined();
		expect(screen.getByText("Submission")).toBeDefined();
	});

	it("drops a file, previews it and uploads through the same upload path", async () => {
		const loadSpy = vi.spyOn(submissionsStore, "load");
		render(UploadPanel, { assignmentId: "soil_contamination" });

		// The drop zone is the empty-state surface.
		const dropZone = screen.getByText("Drop files here or click to browse").parentElement;
		expect(dropZone).not.toBeNull();

		const file = notebookFile("2026SS_05.ipynb");
		// jsdom has no DataTransfer; the component only reads dataTransfer.files.
		const dataTransfer = { files: [file] } as unknown as DataTransfer;

		await fireEvent.drop(dropZone as HTMLElement, { dataTransfer });
		expect(await screen.findByText("2026SS_05.ipynb")).toBeDefined();

		await fireEvent.click(screen.getByText("Upload 1 file"));

		expect(loadSpy).not.toHaveBeenCalled();
		expect(api.uploadSubmissions).toHaveBeenCalledTimes(1);
		expect(api.uploadSubmissions).toHaveBeenCalledWith([file], "soil_contamination", undefined);

		// Same result row as the picker path.
		expect(await screen.findByText("Uploaded")).toBeDefined();
		expect(screen.getByText("Submission")).toBeDefined();
	});

	it("re-loads the store when the panel targets a different assignment", async () => {
		const loadSpy = vi.spyOn(submissionsStore, "load");
		render(UploadPanel, { assignmentId: "another_assignment" });

		const input = document.querySelector('input[type="file"]') as HTMLInputElement;
		await fireEvent.change(input, { target: { files: [notebookFile("2026SS_05.ipynb")] } });
		await fireEvent.click(screen.getByText("Upload 1 file"));

		expect(loadSpy).toHaveBeenCalledWith("another_assignment");
		expect(api.uploadSubmissions).toHaveBeenCalledTimes(1);
		expect(api.uploadSubmissions).toHaveBeenCalledWith(
			[notebookFile("2026SS_05.ipynb")],
			"another_assignment",
			undefined,
		);
		expect(await screen.findByText("2026SS_05.ipynb")).toBeDefined();
	});
});
