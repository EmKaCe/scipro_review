/**
 * @file L4 component tests — grading-dimension controls in the criteria
 * editor (D3).
 *
 * Renders the tabs wrapper (visual editor + preview) with mocked
 * submissions-api / criteria-loader / toast stores and asserts:
 *   - the muted "· no dimension" indicator on sub-points with no resolved
 *     dimension, and that selecting a dimension clears it
 *   - group-default chips flowing to children (override editor opens with
 *     the group's selection)
 *   - a sub-point override REPLACING the group (no merge)
 *   - clear-override restoring the group default
 *   - the save round-trip preserving selections while emitting dimensions
 *     ONLY when non-empty (legacy YAML stays byte-stable)
 *   - the tabs wrapper passing the dimension list through to editor/preview,
 *     and the criteria page loading grading dimensions (with graceful
 *     degradation when the config cannot be loaded)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";

import CriteriaEditorTabs from "$lib/components/assignments/criteria-editor-tabs.svelte";
import CriteriaPage from "../../routes/settings/assignments/[id]/criteria/+page.svelte";
import * as api from "$lib/services/submissions-api.js";
import type { CriteriaFile } from "$lib/types/criteria.js";

vi.mock("$lib/services/submissions-api.js", async (importOriginal) => {
	const actual = await importOriginal<typeof api>();
	return {
		...actual,
		getCriteria: vi.fn(),
		saveCriteria: vi.fn(),
		draftCriteria: vi.fn(),
	};
});

vi.mock("$lib/services/grading-config.js", () => ({
	getGradingConfig: vi.fn(),
}));

vi.mock("$lib/services/criteria-loader.js", () => ({
	clearCache: vi.fn(),
}));

vi.mock("$lib/stores/toast.svelte.js", () => ({
	addToast: vi.fn(),
}));

vi.mock("$app/state", () => ({
	page: { params: { id: "soil_contamination" } },
}));

vi.mock("$app/paths", () => ({ base: "" }));

import { getCriteria, saveCriteria } from "$lib/services/submissions-api.js";
import { getGradingConfig } from "$lib/services/grading-config.js";
import { dimensionKeyOf } from "$lib/types/grading.js";

const mockedGetCriteria = vi.mocked(getCriteria);
const mockedSave = vi.mocked(saveCriteria);
const mockedGetGradingConfig = vi.mocked(getGradingConfig);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The fixed five grading dimensions (mirrors data/grading_config.yaml). */
const DIMENSIONS = [
	{ key: "code_quality_design", title: "Code Quality & Design" },
	{ key: "code_execution_results", title: "Code Execution & Results" },
	{ key: "assignment_requirements", title: "Assignment Requirements" },
	{ key: "scientific_programming", title: "Scientific Programming" },
	{ key: "creativity", title: "Creativity" },
];

/** Plain rubric — no dimensions anywhere. */
const PLAIN: CriteriaFile = {
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

/** Group default on the positive main point; one child overrides it. */
const WITH_DIMENSIONS: CriteriaFile = {
	categories: {
		code_formatting: {
			title: "Code Formatting",
			additional_notes: true,
			positive: [
				{
					main_point: "Good formatting",
					dimensions: ["scientific_programming"],
					sub_points: [
						{ text: "consistent indentation", comment: true, point_deduction: false },
						{ text: "descriptive naming", dimensions: ["creativity"] },
					],
				},
			],
			neutral: [],
			negative: [],
		},
	},
};

/** The shape saveCriteria receives (server categories map). */
type ServerCategories = Record<
	string,
	{
		title: string;
		additional_notes: boolean;
		positive: Record<string, unknown>[];
		neutral: Record<string, unknown>[];
		negative: Record<string, unknown>[];
	}
>;

function positiveOf(payload: unknown): Record<string, unknown>[] {
	return (payload as ServerCategories).code_formatting!.positive;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The DOM node of a main-point row holding the input with the given value. */
function mainPointRow(value: string): HTMLElement {
	const input = screen.getByDisplayValue(value) as HTMLInputElement;
	const row = input.closest(".main-point");
	if (!row) throw new Error(`main point row for "${value}" not found`);
	return row as HTMLElement;
}

/** The group chip row inside a main-point row (excludes sub-point chips). */
function groupDimensionRow(value: string): HTMLElement {
	const row = mainPointRow(value);
	const group = row.querySelector<HTMLElement>(".dimension-row");
	if (!group) throw new Error(`group dimension row for "${value}" not found`);
	return group;
}

/** The DOM node of a sub-point row holding the input with the given value. */
function subPointRow(value: string): HTMLElement {
	const input = screen.getByDisplayValue(value) as HTMLInputElement;
	const row = input.closest(".sub-point");
	if (!row) throw new Error(`sub-point row for "${value}" not found`);
	return row as HTMLElement;
}

/** Selected dimension-chip keys inside a container (group or sub-point row). */
function selectedChips(container: HTMLElement): string[] {
	return Array.from(
		container.querySelectorAll<HTMLButtonElement>(".dimension-chip.selected"),
	).map((c) => c.textContent ?? "");
}

/** ALL dimension-chip keys inside a container (selected + unselected). */
function allChips(container: HTMLElement): string[] {
	return Array.from(container.querySelectorAll<HTMLButtonElement>(".dimension-chip")).map(
		(c) => c.textContent ?? "",
	);
}

function noDimensionIndicators(): HTMLElement[] {
	return Array.from(document.querySelectorAll<HTMLElement>(".no-dimension-chip"));
}

beforeEach(() => {
	mockedGetCriteria.mockReset();
	mockedSave.mockReset();
	mockedSave.mockResolvedValue({
		fileName: "data/criteria/soil_contamination.yaml",
		content: PLAIN,
	});
});

// ---------------------------------------------------------------------------
// Visual editor — dimension controls
// ---------------------------------------------------------------------------

describe("criteria editor — dimension controls", () => {
	it("shows the muted '· no dimension' indicator on sub-points with no resolved dimension", () => {
		render(CriteriaEditorTabs, {
			props: { assignmentId: "soil_contamination", initial: PLAIN, dimensions: DIMENSIONS },
		});

		// Three sub-points, none with any dimension resolved.
		const indicators = noDimensionIndicators();
		expect(indicators).toHaveLength(3);
		for (const indicator of indicators) {
			expect(indicator.textContent).toContain("no dimension");
			expect(indicator.className).toContain("no-dimension-chip"); // muted styling
			expect(indicator.title).toContain("teacher judgment");
		}
	});

	it("selecting a dimension clears the indicator (and deselecting restores it)", async () => {
		render(CriteriaEditorTabs, {
			props: { assignmentId: "soil_contamination", initial: PLAIN, dimensions: DIMENSIONS },
		});

		const row = subPointRow("consistent indentation");
		expect(within(row).getByText(/no dimension/)).toBeTruthy();

		// Open the override editor and pick a dimension.
		await fireEvent.click(within(row).getByRole("button", { name: "Override dimensions" }));
		await fireEvent.click(within(row).getByRole("button", { name: "creativity" }));

		expect(within(row).queryByText(/no dimension/)).toBeNull();
		expect(selectedChips(row)).toEqual(["creativity"]);

		// Deselecting closes the empty override editor and the indicator returns.
		await fireEvent.click(within(row).getByRole("button", { name: "creativity" }));
		expect(within(row).getByRole("button", { name: "Override dimensions" })).toBeTruthy();
		expect(within(row).getByText(/no dimension/)).toBeTruthy();
	});

	it("group default flows to children — opening the override editor shows the group's chips", async () => {
		render(CriteriaEditorTabs, {
			props: {
				assignmentId: "soil_contamination",
				initial: WITH_DIMENSIONS,
				dimensions: DIMENSIONS,
			},
		});

		// The group row shows its own chips with scientific_programming selected.
		const groupRow = groupDimensionRow("Good formatting");
		expect(within(groupRow).getByText("Group dimensions")).toBeTruthy();
		expect(selectedChips(groupRow)).toEqual(["scientific_programming"]);

		// A child WITHOUT an override starts with only the affordance…
		const childRow = subPointRow("consistent indentation");
		expect(
			within(childRow).queryByRole("button", { name: "Override dimensions" }),
		).toBeTruthy();
		expect(allChips(childRow)).toEqual([]);

		// …opening it reveals the group default pre-selected.
		await fireEvent.click(
			within(childRow).getByRole("button", { name: "Override dimensions" }),
		);
		expect(selectedChips(childRow)).toEqual(["scientific_programming"]);
	});

	it("sub-point override REPLACES the group — chips show the override only", () => {
		render(CriteriaEditorTabs, {
			props: {
				assignmentId: "soil_contamination",
				initial: WITH_DIMENSIONS,
				dimensions: DIMENSIONS,
			},
		});

		const childRow = subPointRow("descriptive naming");
		// Stored override renders its editor directly.
		expect(within(childRow).getByText("Override")).toBeTruthy();
		expect(selectedChips(childRow)).toEqual(["creativity"]);
		// Override REPLACES the group — the group's key is NOT selected (no merge).
		expect(selectedChips(childRow)).not.toContain("scientific_programming");
		expect(within(childRow).getByRole("button", { name: "Clear override" })).toBeTruthy();
	});

	it("clear override restores the group default", async () => {
		render(CriteriaEditorTabs, {
			props: {
				assignmentId: "soil_contamination",
				initial: WITH_DIMENSIONS,
				dimensions: DIMENSIONS,
			},
		});

		const childRow = subPointRow("descriptive naming");
		await fireEvent.click(within(childRow).getByRole("button", { name: "Clear override" }));

		// Editor closes; the affordance is back.
		expect(within(childRow).getByRole("button", { name: "Override dimensions" })).toBeTruthy();
		expect(allChips(childRow)).toEqual([]);

		// Re-opening shows the group default again.
		await fireEvent.click(
			within(childRow).getByRole("button", { name: "Override dimensions" }),
		);
		expect(selectedChips(childRow)).toEqual(["scientific_programming"]);
	});

	it("round-trips selections through the editable model — dimensions emitted only when non-empty", async () => {
		render(CriteriaEditorTabs, {
			props: {
				assignmentId: "soil_contamination",
				initial: PLAIN,
				dimensions: DIMENSIONS,
			},
		});

		// Set a group default on the positive main point.
		const groupRow = groupDimensionRow("Good formatting");
		await fireEvent.click(within(groupRow).getByRole("button", { name: "creativity" }));
		expect(selectedChips(groupRow)).toEqual(["creativity"]);

		// Override the first child: the override editor opens pre-selected with
		// the inherited group chip (creativity). Add the new dimension first,
		// then drop the inherited one — the override now REPLACES the group
		// (deselecting the last chip would mean "no override" and close).
		const childRow = subPointRow("consistent indentation");
		await fireEvent.click(
			within(childRow).getByRole("button", { name: "Override dimensions" }),
		);
		await fireEvent.click(
			within(childRow).getByRole("button", { name: "code_quality_design" }),
		);
		await fireEvent.click(within(childRow).getByRole("button", { name: "creativity" }));

		// Make the draft dirty and save.
		await fireEvent.input(screen.getByDisplayValue("Code Formatting"), {
			target: { value: "Code Formatting v2" },
		});
		await fireEvent.click(screen.getByText("Save criteria"));
		await waitFor(() => expect(mockedSave).toHaveBeenCalledTimes(1));

		const payload = mockedSave.mock.calls[0]![1];
		const positive = positiveOf(payload);
		const mainPoint = positive[0] as Record<string, unknown>;
		expect(mainPoint.dimensions).toEqual(["creativity"]);

		const subPoints = mainPoint.sub_points as Record<string, unknown>[];
		expect(subPoints[0]).toMatchObject({ text: "consistent indentation" });
		expect(subPoints[0]!.dimensions).toEqual(["code_quality_design"]);
		// No override + empty group would be nothing: the untouched child and
		// the negative group emit NO dimensions key at all (legacy byte-stability).
		expect(subPoints[1]).toEqual({ text: "descriptive naming" });
		const negative = (payload as ServerCategories).code_formatting!.negative[0] as Record<
			string,
			unknown
		>;
		expect(negative.dimensions).toBeUndefined();
		expect(JSON.stringify(payload)).not.toContain('"dimensions":[]');
	});

	it("renders no dimension pickers when the dimensions prop is absent", () => {
		render(CriteriaEditorTabs, {
			props: { assignmentId: "soil_contamination", initial: PLAIN },
		});

		expect(screen.queryByText("Group dimensions")).toBeNull();
		expect(document.querySelectorAll(".dimension-chip")).toHaveLength(0);
		expect(screen.queryByText(/no dimension/)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Preview tab — resolved dimension chips
// ---------------------------------------------------------------------------

describe("criteria editor — preview dimension chips", () => {
	it("renders resolved dimension chips per sub-point in the Preview tab", async () => {
		render(CriteriaEditorTabs, {
			props: {
				assignmentId: "soil_contamination",
				initial: WITH_DIMENSIONS,
				dimensions: DIMENSIONS,
			},
		});

		await fireEvent.click(screen.getByRole("tab", { name: /Preview/ }));

		const items = document.querySelectorAll(".preview-item");
		expect(items).toHaveLength(2);

		const chipLabels = Array.from(document.querySelectorAll(".preview-dimension-chip")).map(
			(c) => c.textContent,
		);
		// Child 1 inherits the group default; child 2 overrides it.
		expect(chipLabels).toEqual(["scientific_programming", "creativity"]);
	});
});

// ---------------------------------------------------------------------------
// Criteria page — loads grading dimensions and passes them through
// ---------------------------------------------------------------------------

describe("criteria page — grading dimensions", () => {
	const CONFIG = {
		dimensions: DIMENSIONS.map((d) => ({
			key: dimensionKeyOf(d.key),
			title: d.title,
			max_points: 6,
			weight: 4,
		})),
		grade_boundaries: [],
	};

	beforeEach(() => {
		mockedGetCriteria.mockResolvedValue({ fileName: null, content: PLAIN });
		mockedGetGradingConfig.mockReset();
	});

	it("loads grading dimensions and passes them to the editor", async () => {
		mockedGetGradingConfig.mockResolvedValue(CONFIG);

		render(CriteriaPage);
		// Criteria load first…
		await screen.findByDisplayValue("code_formatting");
		// …then the dimension chip rows appear once the config resolves.
		await waitFor(() =>
			expect(document.querySelectorAll(".dimension-row").length).toBeGreaterThan(0),
		);
		expect(screen.getAllByText("creativity").length).toBeGreaterThan(0);
		expect(mockedGetGradingConfig).toHaveBeenCalledTimes(1);
	});

	it("degrades gracefully when the grading config cannot be loaded", async () => {
		mockedGetGradingConfig.mockRejectedValue(new Error("boom"));

		render(CriteriaPage);
		await screen.findByDisplayValue("code_formatting");
		// The editor still renders (categories + sub-points) without pickers.
		expect(screen.getByDisplayValue("Good formatting")).toBeTruthy();
		expect(screen.queryByText("Group dimensions")).toBeNull();
	});
});
