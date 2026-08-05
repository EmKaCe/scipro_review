/**
 * @file L4 component test — materials-manager (delete per file, clear all).
 *
 * Renders the manager with a mocked submissions-api, asserts the file list
 * renders, and drives per-file delete + clear-all through the mocked
 * deleteMaterial, confirming the onChange callback receives the updated
 * status.
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
			hasPdf: true,
			hasKey: true,
			hasInputData: true,
			files: [
				{
					name: "assignment.pdf",
					kind: "material-file",
					relativePath: "materials/soil/assignment.pdf",
				},
				{
					name: "key.ipynb",
					kind: "material-file",
					relativePath: "materials/soil/key.ipynb",
				},
				{
					name: "soil.csv",
					kind: "material-data",
					relativePath: "materials/soil/input_data/soil.csv",
				},
			],
		}),
		deleteMaterial: vi.fn(),
	};
});

const mockedDelete = vi.mocked(api.deleteMaterial);

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
		expect(screen.getByText("Material")).toBeTruthy();
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
});
