/**
 * @file Component tests — submissions dashboard selection UI.
 *
 * Covers the checkbox column, header select-all (visible set), shift-click
 * range extension, and the removal of per-row Archive/Delete (bulk bar owns
 * those now). Selection state lives in the parent — this component emits
 * callbacks.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";

import SubmissionsDashboard from "$lib/components/submissions/submissions-dashboard.svelte";
import type { SubmissionMeta } from "$lib/types/submissions.js";

vi.mock("$app/paths", () => ({ base: "" }));

vi.mock("$lib/services/plagiarism-store.svelte.js", () => ({
	plagiarismStore: {
		load: vi.fn().mockResolvedValue(null),
		unreviewedCount: vi.fn(() => 0),
	},
}));

vi.mock("$lib/components/submissions/plagiarism-modal.svelte", () => ({
	default: () => {},
}));

const SUBMISSIONS: SubmissionMeta[] = [
	{
		id: "2026SS_01",
		studentId: "2026SS_01",
		assignmentId: "soil_contamination",
		semester: "2026SS",
		status: "executed",
		createdAt: "2026-08-01T00:00:00.000Z",
		updatedAt: "2026-08-01T00:00:00.000Z",
	},
	{
		id: "2026SS_02",
		studentId: "2026SS_02",
		assignmentId: "soil_contamination",
		semester: "2026SS",
		status: "executed",
		createdAt: "2026-08-01T00:00:00.000Z",
		updatedAt: "2026-08-01T00:00:00.000Z",
	},
	{
		id: "2026SS_03",
		studentId: "2026SS_03",
		assignmentId: "soil_contamination",
		semester: "2026SS",
		status: "graded",
		createdAt: "2026-08-01T00:00:00.000Z",
		updatedAt: "2026-08-01T00:00:00.000Z",
	},
];

function renderDashboard(selected: ReadonlySet<string> = new Set()) {
	const callbacks = {
		onToggleSelect: vi.fn(),
		onSelectRange: vi.fn(),
		onDeselectRange: vi.fn(),
		onSelectAllVisible: vi.fn(),
		onClearSelection: vi.fn(),
	};
	const utils = render(SubmissionsDashboard, {
		props: {
			submissions: SUBMISSIONS,
			searchQuery: "",
			statusFilter: "all",
			assignmentId: "soil_contamination",
			selectedIds: selected,
			onSearchChange: vi.fn(),
			onStatusFilterChange: vi.fn(),
			...callbacks,
		},
	});
	return { ...utils, callbacks };
}

describe("submissions-dashboard selection", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("renders a checkbox per row with an accessible label", () => {
		renderDashboard();
		for (const sub of SUBMISSIONS) {
			expect(screen.getByLabelText(`Select ${sub.studentId}`)).not.toBeNull();
		}
	});

	it("renders only the Open row action (no Archive/Delete per row)", () => {
		renderDashboard();
		expect(screen.getAllByText("Open").length).toBe(SUBMISSIONS.length);
		expect(screen.queryByRole("button", { name: /archive/i })).toBeNull();
		expect(screen.queryByRole("button", { name: /delete/i })).toBeNull();
	});

	it("marks rows as checked from the selectedIds prop", () => {
		renderDashboard(new Set(["2026SS_02"]));
		const checked = screen.getByLabelText("Select 2026SS_02");
		const unchecked = screen.getByLabelText("Select 2026SS_01");
		expect(checked.getAttribute("data-state")).toBe("checked");
		expect(unchecked.getAttribute("data-state")).toBe("unchecked");
	});

	it("emits onToggleSelect for a plain checkbox click", () => {
		const { callbacks } = renderDashboard();
		fireEvent.click(screen.getByLabelText("Select 2026SS_01"));
		expect(callbacks.onToggleSelect).toHaveBeenCalledWith("2026SS_01");
	});

	it("emits the contiguous range ids on shift-click", () => {
		const { callbacks } = renderDashboard();
		// Anchor on row 1 (index 0), then shift-click row 3 (index 2).
		fireEvent.click(screen.getByLabelText("Select 2026SS_01"));
		fireEvent.click(screen.getByLabelText("Select 2026SS_03"), { shiftKey: true });
		expect(callbacks.onToggleSelect).toHaveBeenCalledWith("2026SS_01");
		expect(callbacks.onSelectRange).toHaveBeenCalledWith([
			"2026SS_01",
			"2026SS_02",
			"2026SS_03",
		]);
	});

	it("de-selects the range when shift-clicking a selected row", () => {
		const { callbacks } = renderDashboard(new Set(["2026SS_01", "2026SS_02", "2026SS_03"]));
		// Anchor on row 1 (index 0, selected), then shift-click row 3 (index 2, selected).
		fireEvent.click(screen.getByLabelText("Select 2026SS_01"));
		fireEvent.click(screen.getByLabelText("Select 2026SS_03"), { shiftKey: true });
		expect(callbacks.onDeselectRange).toHaveBeenCalledWith([
			"2026SS_01",
			"2026SS_02",
			"2026SS_03",
		]);
		expect(callbacks.onSelectRange).not.toHaveBeenCalled();
	});

	it("selects all visible rows from the header checkbox", () => {
		const { callbacks } = renderDashboard();
		fireEvent.click(screen.getByLabelText("Select all visible submissions"));
		expect(callbacks.onSelectAllVisible).toHaveBeenCalledWith([
			"2026SS_01",
			"2026SS_02",
			"2026SS_03",
		]);
	});

	it("clears the selection when the header checkbox unchecks", () => {
		const { callbacks } = renderDashboard(new Set(SUBMISSIONS.map((s) => s.id)));
		fireEvent.click(screen.getByLabelText("Select all visible submissions"));
		expect(callbacks.onClearSelection).toHaveBeenCalled();
	});
});
