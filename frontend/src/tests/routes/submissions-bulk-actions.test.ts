/**
 * @file L4 page test — submissions dashboard bulk selection + actions.
 *
 * Renders the real dashboard page with the API client mocked and the REAL
 * submissions store (reactivity): bulk mutations go through store methods,
 * and the table re-renders from the refreshed server list. Keeps
 * SubmissionsDashboard + ConfirmationDialog real, and asserts the bulk bar
 * lifecycle: selection -> eligibility -> action calls.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";

import Page from "../../routes/submissions/+page.svelte";
import type { SubmissionMeta } from "$lib/types/submissions.js";

// ---------------------------------------------------------------------------
// Mocks — API client only; the store itself is real.
// ---------------------------------------------------------------------------

const api = vi.hoisted(() => {
	// Server-side truth simulated as a mutable array; fetchSubmissions
	// returns it, and the mutation endpoints update it so the store's
	// post-action refresh re-renders the table from the new state.
	const server: SubmissionMeta[] = [];
	return {
		server,
		fetchAssignments: vi.fn(async () => ({
			assignments: [{ id: "soil_contamination", title: "Soil Contamination", enabled: true }],
		})),
		fetchMaterials: vi.fn(async () => ({ hasPdf: true, hasKey: true, hasInputData: true })),
		fetchSubmissions: vi.fn(async () => ({
			assignmentId: "soil_contamination",
			submissions: [...api.server],
		})),
		archiveSubmission: vi.fn(async (id: string, _assignmentId: string) => {
			const record = api.server.find((s) => s.id === id) ?? api.server[0]!;
			api.server = api.server.map((s) =>
				s.id === id ? { ...s, status: "archived" as const } : s,
			);
			return { ...record, status: "archived" as const };
		}),
		deleteSubmission: vi.fn(async (id: string) => {
			api.server = api.server.filter((s) => s.id !== id);
			return { deleted: id, assignmentId: "soil_contamination" };
		}),
		resetSubmission: vi.fn(async (id: string) => {
			const record = api.server.find((s) => s.id === id) ?? api.server[0]!;
			api.server = api.server.map((s) =>
				s.id === id ? { ...s, status: "executed" as const } : s,
			);
			return { ...record, status: "executed" as const };
		}),
		exportSubmission: vi.fn(async (id: string) => ({
			fileName: `${id}.yaml`,
			content: `student_id: ${id}\n`,
		})),
		processSubmissions: vi.fn(async (ids: string[]) => ({
			assignmentId: "soil_contamination",
			submitted: ids.length,
			succeeded: ids.length,
			failed: 0,
			totalDurationSeconds: 1,
			results: ids.map((studentId) => ({ studentId, success: true, error: null })),
		})),
		downloadBackup: vi.fn(),
		restoreBackup: vi.fn(),
	};
});

vi.mock("$lib/services/submissions-api.js", () => api);

vi.mock("$lib/stores/toast.svelte.js", () => ({
	addToast: vi.fn(),
}));

vi.mock("$lib/stores/header.svelte.js", () => ({
	headerConfig: {
		headerState: "dashboard",
		showBack: false,
		showImport: false,
		showSave: false,
		showExport: false,
	},
}));

vi.mock("$app/paths", () => ({ base: "" }));

// Leaf children — not the subject under test.
vi.mock("$lib/components/submissions/assignment-selector.svelte", () => ({
	default: () => {},
}));
vi.mock("$lib/components/submissions/upload-panel.svelte", () => ({ default: () => {} }));
vi.mock("$lib/components/submissions/materials-indicator.svelte", () => ({ default: () => {} }));
vi.mock("$lib/components/submissions/materials-manager.svelte", () => ({ default: () => {} }));
vi.mock("$lib/components/submissions/config-error-banner.svelte", () => ({ default: () => {} }));
vi.mock("$lib/components/ui/skeleton-pulse.svelte", () => ({ default: () => {} }));

// jsdom has no URL.createObjectURL — the export download helper needs it.
Object.defineProperty(URL, "createObjectURL", { value: vi.fn(() => "blob:test"), writable: true });
Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), writable: true });

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXTURES: SubmissionMeta[] = [
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
		id: "2026SS_03",
		studentId: "2026SS_03",
		assignmentId: "soil_contamination",
		semester: "2026SS",
		status: "graded",
		teacherGrade: 85,
		createdAt: "2026-08-01T00:00:00.000Z",
		updatedAt: "2026-08-01T00:00:00.000Z",
	},
	{
		id: "2026SS_75",
		studentId: "2026SS_75",
		assignmentId: "soil_contamination",
		semester: "2026SS",
		status: "pending",
		createdAt: "2026-08-01T00:00:00.000Z",
		updatedAt: "2026-08-01T00:00:00.000Z",
	},
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function renderPage() {
	const utils = render(Page);
	await screen.findByText("2026SS_01"); // table rendered after load
	return utils;
}

function checkboxFor(studentId: string): HTMLInputElement {
	return screen.getByLabelText(`Select ${studentId}`) as HTMLInputElement;
}

/** Click the confirm button inside the open ConfirmationDialog. */
function clickDialogConfirm(label: string) {
	const dialog = screen.getByRole("dialog");
	const btn = [...dialog.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
	if (!btn) throw new Error(`Dialog button "${label}" not found`);
	fireEvent.click(btn);
}

describe("submissions dashboard bulk bar", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		api.server = [...FIXTURES];
	});

	it("shows the single bulk bar with an all-batch scope when nothing is selected", async () => {
		await renderPage();
		// One bar, one button set — scope defaults to the whole batch.
		expect(screen.getByText(/All 3 submissions/)).not.toBeNull();
		expect(screen.getByText("Archive")).not.toBeNull();
		expect(screen.getByText("Export")).not.toBeNull();
		expect(screen.getByText("Delete")).not.toBeNull();
		expect(screen.getByText("Process")).not.toBeNull();
		// The batch contains a pending row, so Process is enabled with no selection.
		expect((screen.getByText("Process") as HTMLButtonElement).disabled).toBe(false);
		// Toolbar still hosts the global actions.
		expect(screen.getByText("Manage Assignments")).not.toBeNull();
	});

	it("switches the scope label once a row is selected", async () => {
		await renderPage();
		fireEvent.click(checkboxFor("2026SS_01"));

		expect(screen.getByText(/1 selected/)).not.toBeNull();
		expect(screen.getByText("Archive")).not.toBeNull();
		expect(screen.getByText("Export")).not.toBeNull();
		expect(screen.getByText("Delete")).not.toBeNull();

		// Executed selection: Reset disabled, Process disabled, Archive enabled.
		const resetBtn = screen.getByText("Reset") as HTMLButtonElement;
		const processBtn = screen.getByText("Process") as HTMLButtonElement;
		const archiveBtn = screen.getByText("Archive") as HTMLButtonElement;
		expect(resetBtn.disabled).toBe(true);
		expect(processBtn.disabled).toBe(true);
		expect(archiveBtn.disabled).toBe(false);
	});

	it("archives the selected rows via the store", async () => {
		await renderPage();
		fireEvent.click(checkboxFor("2026SS_01"));
		fireEvent.click(screen.getByText("Archive"));
		await waitFor(() => {
			expect(api.archiveSubmission).toHaveBeenCalledWith(
				"2026SS_01",
				"soil_contamination",
				"archive",
			);
		});
		// The archived row leaves the visible table (status filter hides it).
		await waitFor(() => {
			expect(screen.queryByText("2026SS_01")).toBeNull();
		});
	});

	it("processes only pending selections via the store", async () => {
		await renderPage();
		fireEvent.click(checkboxFor("2026SS_75"));
		fireEvent.click(screen.getByText("Process"));
		await waitFor(() => {
			expect(api.processSubmissions).toHaveBeenCalledWith(
				["2026SS_75"],
				"soil_contamination",
			);
		});
	});

	it("enables Process for error rows and re-runs them (retry after a failed batch)", async () => {
		// Simulate the failed-batch state: one row stuck in error.
		api.server = [
			{ ...FIXTURES[0]!, status: "error", error: "Executor request timed out" },
			FIXTURES[1]!,
			FIXTURES[2]!,
		];
		await renderPage();

		fireEvent.click(checkboxFor("2026SS_01"));
		const processBtn = screen.getByText("Process") as HTMLButtonElement;
		expect(processBtn.disabled).toBe(false);

		fireEvent.click(processBtn);
		await waitFor(() => {
			expect(api.processSubmissions).toHaveBeenCalledWith(
				["2026SS_01"],
				"soil_contamination",
			);
		});
	});

	it("resets graded selections through the confirm dialog", async () => {
		await renderPage();
		fireEvent.click(checkboxFor("2026SS_03"));
		const resetBtn = screen.getByText("Reset") as HTMLButtonElement;
		expect(resetBtn.disabled).toBe(false);

		fireEvent.click(resetBtn);
		expect(screen.getByText("Reset Submissions")).not.toBeNull();
		clickDialogConfirm("Reset");
		await waitFor(() => {
			expect(api.resetSubmission).toHaveBeenCalledWith("2026SS_03", "soil_contamination");
		});
	});

	it("deletes the selection through the confirm dialog", async () => {
		await renderPage();
		fireEvent.click(checkboxFor("2026SS_01"));
		fireEvent.click(screen.getByText("Delete"));
		expect(screen.getByText("Delete Submissions")).not.toBeNull();
		clickDialogConfirm("Delete");
		await waitFor(() => {
			expect(api.deleteSubmission).toHaveBeenCalledWith("2026SS_01", "soil_contamination");
		});
		// The deleted row leaves the table reactively (store refresh).
		await waitFor(() => {
			expect(screen.queryByText("2026SS_01")).toBeNull();
		});
	});

	it("exports a single selected row as one YAML", async () => {
		await renderPage();
		fireEvent.click(checkboxFor("2026SS_01"));
		fireEvent.click(screen.getByText("Export"));
		await waitFor(() => {
			expect(api.exportSubmission).toHaveBeenCalledWith(
				"2026SS_01",
				"soil_contamination",
				"student",
			);
		});
	});

	it("exports multiple rows as a zip bundle", async () => {
		await renderPage();
		fireEvent.click(checkboxFor("2026SS_01"));
		fireEvent.click(checkboxFor("2026SS_03"));
		fireEvent.click(screen.getByText("Export"));
		await waitFor(() => {
			expect(api.exportSubmission).toHaveBeenCalledWith(
				"2026SS_01",
				"soil_contamination",
				"student",
			);
			expect(api.exportSubmission).toHaveBeenCalledWith(
				"2026SS_03",
				"soil_contamination",
				"student",
			);
		});
	});

	it("selects all visible rows from the header checkbox", async () => {
		await renderPage();
		fireEvent.click(screen.getByLabelText("Select all visible submissions"));
		expect(screen.getByText(/3 selected/)).not.toBeNull();
		expect(screen.getByText(/3 in view/)).not.toBeNull();
	});

	it("clears the selection with the X button", async () => {
		await renderPage();
		fireEvent.click(checkboxFor("2026SS_01"));
		expect(screen.getByText(/1 selected/)).not.toBeNull();
		fireEvent.click(screen.getByLabelText("Clear selection"));
		expect(screen.getByText(/All 3 submissions/)).not.toBeNull();
	});
});
