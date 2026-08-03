/**
 * @file L4 component tests for the real upload flow (Phase 3f B2).
 *
 * Mocks submissions-store so the panel can be driven without a network:
 * the stubbed `upload` resolves a single submission-kind result, and the
 * test fires the hidden file input's change event with a real File.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";

import UploadPanel from "$lib/components/submissions/upload-panel.svelte";

vi.mock("$lib/services/submissions-store.js", () => ({
	submissionsStore: {
		assignmentId: "soil_contamination",
		load: vi.fn().mockResolvedValue([]),
		upload: vi.fn(),
	},
}));

import { submissionsStore } from "$lib/services/submissions-store.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("upload-panel.svelte (real upload flow)", () => {
	beforeEach(() => {
		vi.mocked(submissionsStore.upload).mockReset();
		vi.mocked(submissionsStore.upload).mockResolvedValue({
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
		vi.mocked(submissionsStore.load).mockClear();
	});

	it("uploads a picked file and shows the server results table", async () => {
		render(UploadPanel, { assignmentId: "soil_contamination" });

		const input = document.querySelector('input[type="file"]') as HTMLInputElement;
		expect(input).not.toBeNull();

		const file = new File(["{}"], "2026SS_05.ipynb", { type: "application/json" });
		await fireEvent.change(input, { target: { files: [file] } });

		// The store already targets this assignment, so no re-load is needed.
		expect(submissionsStore.load).not.toHaveBeenCalled();
		expect(submissionsStore.upload).toHaveBeenCalledTimes(1);
		expect(submissionsStore.upload).toHaveBeenCalledWith([file]);

		// Results table shows the server response: file name + kind label.
		expect(await screen.findByText("2026SS_05.ipynb")).toBeDefined();
		expect(screen.getByText("Submission")).toBeDefined();
	});

	it("re-loads the store when the panel targets a different assignment", async () => {
		render(UploadPanel, { assignmentId: "another_assignment" });

		const input = document.querySelector('input[type="file"]') as HTMLInputElement;
		const file = new File(["{}"], "2026SS_05.ipynb", { type: "application/json" });
		await fireEvent.change(input, { target: { files: [file] } });

		expect(submissionsStore.load).toHaveBeenCalledWith("another_assignment");
		expect(submissionsStore.upload).toHaveBeenCalledTimes(1);
		expect(await screen.findByText("2026SS_05.ipynb")).toBeDefined();
	});
});
