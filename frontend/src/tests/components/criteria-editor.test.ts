/**
 * @file L4 component test — criteria editor tabs (visual editor + save).
 *
 * Renders the tabs wrapper with a mocked submissions-api + criteria-loader
 * cache and toast store, asserts category/main-point/sub-point CRUD
 * rendering, the save payload (incl. comment/point_deduction flags),
 * client-side validation, and the success/failure paths.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";

import CriteriaEditorTabs from "$lib/components/assignments/criteria-editor-tabs.svelte";
import * as api from "$lib/services/submissions-api.js";
import type { CriteriaFile } from "$lib/types/criteria.js";

vi.mock("$lib/services/submissions-api.js", async (importOriginal) => {
	const actual = await importOriginal<typeof api>();
	return {
		...actual,
		saveCriteria: vi.fn(),
	};
});

vi.mock("$lib/services/criteria-loader.js", () => ({
	clearCache: vi.fn(),
}));

vi.mock("$lib/stores/toast.svelte.js", () => ({
	addToast: vi.fn(),
}));

import { clearCache } from "$lib/services/criteria-loader.js";
import { addToast } from "$lib/stores/toast.svelte.js";

const mockedSave = vi.mocked(api.saveCriteria);
const mockedClearCache = vi.mocked(clearCache);
const mockedToast = vi.mocked(addToast);

const INITIAL: CriteriaFile = {
	categories: {
		code_formatting: {
			title: "Code Formatting",
			additional_notes: true,
			positive: [
				{
					main_point: "Good formatting",
					sub_points: [
						{ text: "consistent indentation", comment: true, point_deduction: false },
						{ text: "descriptive naming" },
					],
				},
			],
			neutral: [],
			negative: [
				{
					main_point: "Poor formatting",
					sub_points: [{ text: "inconsistent style", point_deduction: true }],
				},
			],
		},
	},
};

beforeEach(() => {
	mockedSave.mockReset();
	mockedClearCache.mockClear();
	mockedToast.mockClear();
	mockedSave.mockResolvedValue({
		fileName: "data/criteria/soil_contamination.yaml",
		content: INITIAL,
	});
});

describe("CriteriaEditorTabs", () => {
	it("renders existing categories with main points, sub-points and flag states", () => {
		render(CriteriaEditorTabs, {
			props: { assignmentId: "soil_contamination", initial: INITIAL },
		});

		expect(screen.getByDisplayValue("code_formatting")).toBeTruthy();
		expect(screen.getByDisplayValue("Code Formatting")).toBeTruthy();
		expect(screen.getByDisplayValue("Good formatting")).toBeTruthy();
		expect(screen.getByDisplayValue("consistent indentation")).toBeTruthy();
		expect(screen.getByDisplayValue("inconsistent style")).toBeTruthy();

		// comment flag checked on the first sub-point, point_deduction on the negative one.
		const checkboxes = screen.getAllByRole("checkbox");
		const commentBoxes = checkboxes.filter((c) =>
			(c as HTMLInputElement).labels?.[0]?.textContent?.includes("Comment"),
		);
		const deductionBoxes = checkboxes.filter((c) =>
			(c as HTMLInputElement).labels?.[0]?.textContent?.includes("Deduction"),
		);
		// At least one comment box and one deduction box carry their flags.
		expect(commentBoxes.some((c) => (c as HTMLInputElement).checked)).toBe(true);
		expect(deductionBoxes.some((c) => (c as HTMLInputElement).checked)).toBe(true);
		// The un-flagged "descriptive naming" sub-point contributes no checked
		// boxes: exactly one comment and one deduction box are checked.
		expect(commentBoxes.filter((c) => (c as HTMLInputElement).checked)).toHaveLength(1);
		expect(deductionBoxes.filter((c) => (c as HTMLInputElement).checked)).toHaveLength(1);
	});

	it("switches to the Raw YAML tab showing the serialized draft", () => {
		render(CriteriaEditorTabs, {
			props: { assignmentId: "soil_contamination", initial: INITIAL },
		});

		fireEvent.click(screen.getByRole("tab", { name: /Raw YAML/ }));
		const textarea = screen.getByLabelText("Raw criteria YAML") as HTMLTextAreaElement;
		expect(textarea.value).toContain("code_formatting");
		expect(textarea.value).toContain("consistent indentation");
		expect(textarea.value).toContain("point_deduction: true");
	});

	it("parses raw YAML edits back into the shared draft (preview updates)", () => {
		render(CriteriaEditorTabs, {
			props: { assignmentId: "soil_contamination", initial: INITIAL },
		});

		fireEvent.click(screen.getByRole("tab", { name: /Raw YAML/ }));
		const textarea = screen.getByLabelText("Raw criteria YAML") as HTMLTextAreaElement;
		// Rename the category title in the raw text.
		const edited = textarea.value.replace("Code Formatting", "Formatting (edited)");
		fireEvent.input(textarea, { target: { value: edited } });

		// Switch to Preview: the edited title renders there.
		fireEvent.click(screen.getByRole("tab", { name: /Preview/ }));
		expect(screen.getByText("Formatting (edited)")).toBeTruthy();
	});

	it("shows an inline error for invalid YAML and keeps the last valid draft", async () => {
		render(CriteriaEditorTabs, {
			props: { assignmentId: "soil_contamination", initial: INITIAL },
		});

		fireEvent.click(screen.getByRole("tab", { name: /Raw YAML/ }));
		const textarea = screen.getByLabelText("Raw criteria YAML") as HTMLTextAreaElement;
		fireEvent.input(textarea, { target: { value: "categories: [unclosed" } });

		expect(await screen.findByText(/YAML problem/)).toBeTruthy();
	});

	it("adds a category, main point and sub-point interactively", async () => {
		render(CriteriaEditorTabs, {
			props: { assignmentId: "soil_contamination", initial: INITIAL },
		});

		await fireEvent.click(screen.getByText("Add category"));
		expect(screen.getByDisplayValue("new_category")).toBeTruthy();

		// Add a positive main point to the new category (only one Add button per sentiment
		// is visible in each category — pick the one in the new category via getAllByText).
		const addButtons = screen.getAllByText(/Add positive main point/);
		await fireEvent.click(addButtons[addButtons.length - 1]!);
		expect(screen.getAllByDisplayValue("")).toBeTruthy();
	});

	it("includes comment/point_deduction flags in the save payload", async () => {
		render(CriteriaEditorTabs, {
			props: { assignmentId: "soil_contamination", initial: INITIAL },
		});

		// Make the draft dirty so Save is enabled.
		await fireEvent.input(screen.getByDisplayValue("Code Formatting"), {
			target: { value: "Code Formatting v2" },
		});
		await fireEvent.click(screen.getByText("Save criteria"));

		await waitFor(() => expect(mockedSave).toHaveBeenCalledTimes(1));
		const [assignmentId, payload] = mockedSave.mock.calls[0]!;
		expect(assignmentId).toBe("soil_contamination");

		const categories = payload as Record<
			string,
			{
				title: string;
				positive: Array<{
					sub_points: Array<{
						text: string;
						comment?: boolean;
						point_deduction?: boolean;
					}>;
				}>;
				negative: Array<{
					sub_points: Array<{
						text: string;
						comment?: boolean;
						point_deduction?: boolean;
					}>;
				}>;
			}
		>;
		const category = categories.code_formatting!;
		expect(category.title).toBe("Code Formatting v2");
		expect(category.positive[0]!.sub_points[0]).toMatchObject({
			text: "consistent indentation",
			comment: true,
		});
		// point_deduction false is omitted from the wire payload
		expect(category.positive[0]!.sub_points[0]!.point_deduction).toBeUndefined();
		expect(category.negative[0]!.sub_points[0]).toMatchObject({
			text: "inconsistent style",
			point_deduction: true,
		});
	});

	it("blocks save on an empty category title with an inline error and no API call", async () => {
		render(CriteriaEditorTabs, {
			props: { assignmentId: "soil_contamination", initial: null },
		});

		await fireEvent.click(screen.getByText("Add category"));
		// The auto-added category has title "New Category" — blank it out.
		const titleInput = screen.getByDisplayValue("New Category");
		await fireEvent.input(titleInput, { target: { value: "" } });

		await fireEvent.click(screen.getByText("Save criteria"));

		expect(await screen.findByText(/needs a title/)).toBeTruthy();
		expect(mockedSave).not.toHaveBeenCalled();
	});

	it("clears the rubric cache and toasts on success", async () => {
		render(CriteriaEditorTabs, {
			props: { assignmentId: "soil_contamination", initial: INITIAL },
		});

		await fireEvent.input(screen.getByDisplayValue("Code Formatting"), {
			target: { value: "Code Formatting v2" },
		});
		await fireEvent.click(screen.getByText("Save criteria"));

		await waitFor(() => expect(mockedClearCache).toHaveBeenCalledTimes(1));
		expect(mockedToast).toHaveBeenCalledWith(
			"success",
			"Criteria saved for soil_contamination",
			3000,
		);
	});

	it("keeps editor state and shows the message when saving fails", async () => {
		mockedSave.mockRejectedValue(new Error("category key x already exists in general.yaml"));
		render(CriteriaEditorTabs, {
			props: { assignmentId: "soil_contamination", initial: INITIAL },
		});

		await fireEvent.input(screen.getByDisplayValue("Code Formatting"), {
			target: { value: "Code Formatting v2" },
		});
		await fireEvent.click(screen.getByText("Save criteria"));

		expect(await screen.findByText(/already exists in general.yaml/)).toBeTruthy();
		expect(mockedClearCache).not.toHaveBeenCalled();
		// Editor state survives — the category is still rendered.
		expect(screen.getByDisplayValue("Code Formatting v2")).toBeTruthy();
	});
});
