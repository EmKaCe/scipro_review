/**
 * @file L4 component test — materials-manager (upload, delete per file, clear all).
 *
 * Renders the manager with a mocked submissions-api, asserts the file list
 * renders, and drives upload + per-file delete + clear-all through the mocked
 * uploadMaterials / deleteMaterial, confirming the onChange callback receives
 * the updated status.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";

import MaterialsManager from "$lib/components/submissions/materials-manager.svelte";
import * as api from "$lib/services/submissions-api.js";

vi.mock("$lib/services/submissions-api.js", async (importOriginal) => {
	const actual = await importOriginal<typeof api>();
	return {
		...actual,
		fetchMaterials: vi.fn().mockResolvedValue({
			assignmentId: "soil_contamination",
			hasPdf: false,
			hasKey: true,
			hasInputData: false,
			files: [
				{
					name: "key.ipynb",
					kind: "material-file",
					relativePath: "materials/soil/key.ipynb",
				},
			],
		}),
		deleteMaterial: vi.fn(),
		uploadMaterials: vi.fn(),
	};
});

const mockedDelete = vi.mocked(api.deleteMaterial);
const mockedUpload = vi.mocked(api.uploadMaterials);

const STATUS_AFTER_DELETE: api.MaterialsStatus = {
	assignmentId: "soil_contamination",
	hasPdf: false,
	hasKey: true,
	hasInputData: true,
	files: [
		{ name: "key.ipynb", kind: "material-file", relativePath: "materials/soil/key.ipynb" },
		{
			name: "soil.csv",
			kind: "material-data",
			relativePath: "materials/soil/input_data/soil.csv",
		},
	],
};

const STATUS_AFTER_UPLOAD: api.MaterialsStatus = {
	assignmentId: "soil_contamination",
	hasPdf: true,
	hasKey: true,
	hasInputData: true,
	files: [
		{
			name: "assignment.pdf",
			kind: "material-file",
			relativePath: "materials/soil/assignment.pdf",
		},
		{ name: "key.ipynb", kind: "material-file", relativePath: "materials/soil/key.ipynb" },
		{
			name: "soil.csv",
			kind: "material-data",
			relativePath: "materials/soil/input_data/soil.csv",
		},
	],
};

/** Lean status (only the key notebook) used as the initial list for upload tests. */
const LEAN_STATUS: api.MaterialsStatus = {
	assignmentId: "soil_contamination",
	hasPdf: false,
	hasKey: true,
	hasInputData: false,
	files: [{ name: "key.ipynb", kind: "material-file", relativePath: "materials/soil/key.ipynb" }],
};

/** Dispatch a change event carrying the given files on the hidden file input. */
async function pickFiles(files: File[]) {
	const input = document.querySelector<HTMLInputElement>('input[type="file"]');
	expect(input).toBeTruthy();
	Object.defineProperty(input!, "files", {
		value: files,
		configurable: true,
	});
	await fireEvent.change(input!);
}

describe("MaterialsManager", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubGlobal(
			"confirm",
			vi.fn(() => true),
		);
	});

	it("renders the file list with kind chips", async () => {
		render(MaterialsManager, {
			props: {
				assignmentId: "soil_contamination",
				materials: {
					assignmentId: "soil_contamination",
					hasPdf: true,
					hasKey: true,
					hasInputData: true,
					files: [
						{
							name: "assignment.pdf",
							kind: "material-file",
							relativePath: "materials/soil/assignment.pdf",
						},
					],
				},
				onChange: vi.fn(),
			},
		});

		await waitFor(() => {
			expect(screen.getByText("assignment.pdf")).toBeTruthy();
		});
		expect(screen.getByText("PDF")).toBeTruthy();
		expect(screen.getByRole("button", { name: /Delete/ })).toBeTruthy();
	});

	it("deletes one file and forwards the updated status", async () => {
		mockedDelete.mockResolvedValue({
			status: STATUS_AFTER_DELETE,
			removed: ["assignment.pdf"],
		});
		const onChange = vi.fn();

		render(MaterialsManager, {
			props: {
				assignmentId: "soil_contamination",
				materials: STATUS_AFTER_DELETE,
				onChange,
			},
		});

		await waitFor(() => {
			expect(screen.getByText("key.ipynb")).toBeTruthy();
		});

		// Click the Delete button in the row that contains key.ipynb.
		const deleteButtons = screen.getAllByRole("button", { name: /Delete/ });
		const keyRow = deleteButtons.find((btn) =>
			btn.closest("li")?.textContent?.includes("key.ipynb"),
		);
		expect(keyRow).toBeTruthy();
		await fireEvent.click(keyRow!);

		await waitFor(() => {
			expect(mockedDelete).toHaveBeenCalledWith("soil_contamination", "key.ipynb");
			expect(onChange).toHaveBeenCalledWith(STATUS_AFTER_DELETE);
		});
	});

	it("clears all materials after confirmation", async () => {
		mockedDelete.mockResolvedValue({
			status: {
				assignmentId: "soil_contamination",
				hasPdf: false,
				hasKey: false,
				hasInputData: false,
				files: [],
			},
			removed: [],
		});
		const onChange = vi.fn();

		render(MaterialsManager, {
			props: {
				assignmentId: "soil_contamination",
				materials: STATUS_AFTER_DELETE,
				onChange,
			},
		});

		await waitFor(() => {
			expect(screen.getByText("key.ipynb")).toBeTruthy();
		});

		await fireEvent.click(screen.getByRole("button", { name: /Clear all/ }));

		await waitFor(() => {
			expect(mockedDelete).toHaveBeenCalledWith("soil_contamination");
			expect(onChange).toHaveBeenCalled();
		});
	});

	it("uploads pdf + csv and renders kind labels for both result rows", async () => {
		mockedUpload.mockResolvedValue({
			status: STATUS_AFTER_UPLOAD,
			results: [
				{ name: "assignment.pdf", kind: "material-file", replaced: false, bytes: 512 },
				{ name: "soil.csv", kind: "material-data", replaced: false, bytes: 128 },
			],
		});
		const onChange = vi.fn();

		render(MaterialsManager, {
			props: {
				assignmentId: "soil_contamination",
				materials: LEAN_STATUS,
				onChange,
			},
		});

		await waitFor(() => {
			expect(screen.getByRole("button", { name: /Upload materials/ })).toBeTruthy();
		});

		await pickFiles([
			new File(["pdf"], "assignment.pdf", { type: "application/pdf" }),
			new File(["a,b"], "soil.csv", { type: "text/csv" }),
		]);

		await waitFor(() => {
			expect(mockedUpload).toHaveBeenCalledWith("soil_contamination", [
				expect.objectContaining({ name: "assignment.pdf" }),
				expect.objectContaining({ name: "soil.csv" }),
			]);
		});
		await waitFor(() => {
			expect(screen.getByText("assignment.pdf")).toBeTruthy();
			expect(screen.getByText("soil.csv")).toBeTruthy();
			// List row (key.ipynb) → "Key"; result rows (assignment.pdf,
			// soil.csv) → "PDF" + "Input data".
			expect(screen.getAllByText("PDF")).toHaveLength(1);
			expect(screen.getAllByText("Key")).toHaveLength(1);
			expect(screen.getAllByText("Input data")).toHaveLength(1);
		});
	});

	it("renders destructive error text for a failed file result", async () => {
		mockedUpload.mockResolvedValue({
			status: STATUS_AFTER_DELETE,
			results: [
				{
					name: "broken.pdf",
					kind: "material-file",
					replaced: false,
					bytes: 0,
					error: "Disk write failed",
				},
			],
		});
		const onChange = vi.fn();

		render(MaterialsManager, {
			props: {
				assignmentId: "soil_contamination",
				materials: LEAN_STATUS,
				onChange,
			},
		});

		await waitFor(() => {
			expect(screen.getByRole("button", { name: /Upload materials/ })).toBeTruthy();
		});

		await pickFiles([new File(["pdf"], "broken.pdf", { type: "application/pdf" })]);

		await waitFor(() => {
			expect(screen.getByText("broken.pdf")).toBeTruthy();
			expect(screen.getByText("Disk write failed")).toBeTruthy();
		});
		// The failed row must carry destructive styling (error text color).
		const errorText = screen.getByText("Disk write failed");
		expect(errorText.className).toContain("mm-error-text");
	});

	it("forwards the returned status to onChange after upload", async () => {
		mockedUpload.mockResolvedValue({
			status: STATUS_AFTER_UPLOAD,
			results: [
				{ name: "assignment.pdf", kind: "material-file", replaced: true, bytes: 512 },
			],
		});
		const onChange = vi.fn();

		render(MaterialsManager, {
			props: {
				assignmentId: "soil_contamination",
				materials: LEAN_STATUS,
				onChange,
			},
		});

		await waitFor(() => {
			expect(screen.getByRole("button", { name: /Upload materials/ })).toBeTruthy();
		});

		await pickFiles([new File(["pdf"], "assignment.pdf", { type: "application/pdf" })]);

		await waitFor(() => {
			expect(onChange).toHaveBeenCalledWith(STATUS_AFTER_UPLOAD);
		});
	});
});
