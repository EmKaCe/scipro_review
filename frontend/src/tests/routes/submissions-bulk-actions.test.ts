/**
 * @file L4 page test — submissions dashboard bulk selection + actions.
 *
 * Renders the real dashboard page with the submissions store + API client
 * mocked, keeps SubmissionsDashboard + ConfirmationDialog real, and asserts
 * the bulk bar lifecycle: selection -> eligibility -> action calls.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";

import Page from "../../routes/submissions/+page.svelte";
import type { SubmissionMeta } from "$lib/types/submissions.js";

// ---------------------------------------------------------------------------
// Mocks
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

const mockStore = vi.hoisted(() => ({
	assignmentId: "soil_contamination",
	submissions: [] as SubmissionMeta[],
	includeArchived: false,
	load: vi.fn(async () => mockStore.submissions),
	refresh: vi.fn(),
	archiveMany: vi.fn(async () => {}),
	deleteMany: vi.fn(async () => {}),
	resetMany: vi.fn(async () => {}),
	process: vi.fn(async () => ({ submitted: 1, succeeded: 1, failed: 0 })),
	export: vi.fn(async (id: string, kind: string) => ({
		fileName: `${id}${kind === "teacher" ? "-teacher" : ""}.yaml`,
		content: `student_id: ${id}\n`,
	})),
	startPolling: vi.fn(),
	delete: vi.fn(),
	archive: vi.fn(),
}));

vi.mock("$lib/services/submissions-store.js", () => ({
	submissionsStore: mockStore,
}));

vi.mock("$lib/services/submissions-api.js", () => ({
	fetchAssignments: vi.fn(async () => ({
		assignments: [{ id: "soil_contamination", title: "Soil Contamination", enabled: true }],
	})),
	fetchMaterials: vi.fn(async () => ({ hasPdf: true, hasKey: true, hasInputData: true })),
	downloadBackup: vi.fn(),
	restoreBackup: vi.fn(),
}));

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
		mockStore.submissions = [...FIXTURES];
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
			expect(mockStore.archiveMany).toHaveBeenCalledWith(["2026SS_01"], "archive");
		});
	});

	it("processes only pending selections via the store", async () => {
		await renderPage();
		fireEvent.click(checkboxFor("2026SS_75"));
		fireEvent.click(screen.getByText("Process"));
		await waitFor(() => {
			expect(mockStore.process).toHaveBeenCalledWith(["2026SS_75"]);
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
			expect(mockStore.resetMany).toHaveBeenCalledWith(["2026SS_03"]);
		});
	});

	it("deletes the selection through the confirm dialog", async () => {
		await renderPage();
		fireEvent.click(checkboxFor("2026SS_01"));
		fireEvent.click(screen.getByText("Delete"));
		expect(screen.getByText("Delete Submissions")).not.toBeNull();
		clickDialogConfirm("Delete");
		await waitFor(() => {
			expect(mockStore.deleteMany).toHaveBeenCalledWith(["2026SS_01"]);
		});
	});

	it("exports a single selected row as one YAML", async () => {
		await renderPage();
		fireEvent.click(checkboxFor("2026SS_01"));
		fireEvent.click(screen.getByText("Export"));
		await waitFor(() => {
			expect(mockStore.export).toHaveBeenCalledWith("2026SS_01", "student");
		});
	});

	it("exports multiple rows as a zip bundle", async () => {
		await renderPage();
		fireEvent.click(checkboxFor("2026SS_01"));
		fireEvent.click(checkboxFor("2026SS_03"));
		fireEvent.click(screen.getByText("Export"));
		await waitFor(() => {
			expect(mockStore.export).toHaveBeenCalledWith("2026SS_01", "student");
			expect(mockStore.export).toHaveBeenCalledWith("2026SS_03", "student");
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
