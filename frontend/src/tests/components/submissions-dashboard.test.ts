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
import { ApiError } from "$lib/services/submissions-api.js";

vi.mock("$app/paths", () => ({ base: "" }));

// Mock the API client only; the plagiarism store itself is real.
const api = vi.hoisted(() => ({
	fetchPlagiarismResults: vi.fn(),
}));

vi.mock("$lib/services/submissions-api.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("$lib/services/submissions-api.js")>();
	return { ...actual, ...api };
});

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
		onConfidenceFilterChange: vi.fn(),
	};
	const utils = render(SubmissionsDashboard, {
		props: {
			submissions: SUBMISSIONS,
			searchQuery: "",
			statusFilter: "all",
			confidenceFilter: "all",
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
		// No plagiarism check has been run for this assignment yet — the real
		// store turns the 404 into a null result, so the badge stays hidden.
		api.fetchPlagiarismResults.mockRejectedValue(new ApiError(404, "No plagiarism check yet"));
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

	it("renders the Auto-fix available badge only for rows with a verified fix", () => {
		const withFix = SUBMISSIONS.map((s) =>
			s.id === "2026SS_02" ? { ...s, autofixAvailable: true } : s,
		);
		render(SubmissionsDashboard, {
			props: {
				submissions: withFix,
				searchQuery: "",
				statusFilter: "all",
				confidenceFilter: "all",
				assignmentId: "soil_contamination",
				selectedIds: new Set<string>(),
				onSearchChange: vi.fn(),
				onStatusFilterChange: vi.fn(),
				onConfidenceFilterChange: vi.fn(),
				onToggleSelect: vi.fn(),
				onSelectRange: vi.fn(),
				onDeselectRange: vi.fn(),
				onSelectAllVisible: vi.fn(),
				onClearSelection: vi.fn(),
			},
		});

		// Exactly the flagged row carries the badge.
		expect(screen.getAllByText("Auto-fix available")).toHaveLength(1);
		const row = screen.getByText("Auto-fix available").closest("tr")!;
		expect(row.textContent).toContain("2026SS_02");
	});
});

describe("submissions-dashboard confidence filter (Step 8)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		api.fetchPlagiarismResults.mockRejectedValue(new ApiError(404, "No plagiarism check yet"));
	});

	/** SUBMISSIONS + a deterministic gradingConfidence per row. */
	const CONFIDENCE_SUBMISSIONS: SubmissionMeta[] = SUBMISSIONS.map((s, i) => ({
		...s,
		gradingConfidence: (["needs_review", "review_optional", "high_confidence"] as const)[i]!,
	}));

	it("renders the Confidence select next to the status filter", () => {
		renderDashboard();
		const select = screen.getByLabelText("Filter by confidence") as HTMLSelectElement;
		expect(select).not.toBeNull();
		expect([...select.options].map((o) => o.value)).toEqual([
			"all",
			"needs_review",
			"review_optional",
			"high_confidence",
		]);
	});

	it("emits onConfidenceFilterChange when a confidence option is picked", () => {
		const { callbacks } = renderDashboard();
		const select = screen.getByLabelText("Filter by confidence") as HTMLSelectElement;
		fireEvent.change(select, { target: { value: "needs_review" } });
		expect(callbacks.onConfidenceFilterChange).toHaveBeenCalledWith("needs_review");
	});

	it("shows only rows matching the active confidence filter", () => {
		render(SubmissionsDashboard, {
			props: {
				submissions: CONFIDENCE_SUBMISSIONS,
				searchQuery: "",
				statusFilter: "all",
				confidenceFilter: "needs_review",
				assignmentId: "soil_contamination",
				selectedIds: new Set<string>(),
				onSearchChange: vi.fn(),
				onStatusFilterChange: vi.fn(),
				onConfidenceFilterChange: vi.fn(),
				onToggleSelect: vi.fn(),
				onSelectRange: vi.fn(),
				onDeselectRange: vi.fn(),
				onSelectAllVisible: vi.fn(),
				onClearSelection: vi.fn(),
			},
		});
		// Only 2026SS_01 (needs_review) stays visible.
		expect(screen.getByLabelText("Select 2026SS_01")).not.toBeNull();
		expect(screen.queryByLabelText("Select 2026SS_02")).toBeNull();
		expect(screen.queryByLabelText("Select 2026SS_03")).toBeNull();
	});

	it("treats rows without a stored confidence as matching only the All filter", () => {
		// 2026SS_01 has no gradingConfidence (pre-eval never ran / legacy).
		const noConfidence = SUBMISSIONS.map((s, i) =>
			i === 0 ? s : { ...s, gradingConfidence: "high_confidence" as const },
		);
		render(SubmissionsDashboard, {
			props: {
				submissions: noConfidence,
				searchQuery: "",
				statusFilter: "all",
				confidenceFilter: "high_confidence",
				assignmentId: "soil_contamination",
				selectedIds: new Set<string>(),
				onSearchChange: vi.fn(),
				onStatusFilterChange: vi.fn(),
				onConfidenceFilterChange: vi.fn(),
				onToggleSelect: vi.fn(),
				onSelectRange: vi.fn(),
				onDeselectRange: vi.fn(),
				onSelectAllVisible: vi.fn(),
				onClearSelection: vi.fn(),
			},
		});
		expect(screen.queryByLabelText("Select 2026SS_01")).toBeNull();
		expect(screen.getByLabelText("Select 2026SS_02")).not.toBeNull();
		expect(screen.getByLabelText("Select 2026SS_03")).not.toBeNull();
	});
});
