/**
 * @file L4 page test — dashboard table reflects store state after mutations.
 *
 * Regression: bulk actions (delete/archive/reset) update the submissions
 * store, and the table must re-render from that new state WITHOUT a manual
 * page reload. Uses the REAL store (reactivity) with the API client mocked,
 * then drives the delete flow end-to-end and asserts the row disappears.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";

import type { SubmissionMeta } from "$lib/types/submissions.js";

// Static import (not dynamic): the page pulls in the tooltip component
// graph, whose first-load transform exceeds the per-test timeout in a
// fresh worker.
import SubmissionsPage from "../../routes/submissions/+page.svelte";

// ---------------------------------------------------------------------------
// Mocks — API client only; the store itself is real.
// ---------------------------------------------------------------------------

const api = vi.hoisted(() => {
	// Server-side truth simulated as a mutable array; fetchSubmissions
	// returns it, deleteSubmission removes from it.
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
		deleteSubmission: vi.fn(async (id: string) => {
			api.server = api.server.filter((s) => s.id !== id);
			return { deleted: id, assignmentId: "soil_contamination" };
		}),
		archiveSubmission: vi.fn(),
		resetSubmission: vi.fn(),
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

Object.defineProperty(URL, "createObjectURL", { value: vi.fn(() => "blob:test"), writable: true });
Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), writable: true });

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function meta(id: string, status: SubmissionMeta["status"] = "executed"): SubmissionMeta {
	return {
		id,
		studentId: id,
		assignmentId: "soil_contamination",
		semester: "2026SS",
		status,
		createdAt: "2026-08-01T00:00:00.000Z",
		updatedAt: "2026-08-01T00:00:00.000Z",
	};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Click the confirm button inside the open ConfirmationDialog. */
function clickDialogConfirm(label: string) {
	const dialog = screen.getByRole("alertdialog");
	const btn = [...dialog.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
	if (!btn) throw new Error(`Dialog button "${label}" not found`);
	fireEvent.click(btn);
}

describe("submissions dashboard — table refresh after mutations", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		api.server = [meta("2026SS_01"), meta("2026SS_03"), meta("2026SS_75", "pending")];
	});

	it("removes a deleted row from the table without a page reload", async () => {
		render(SubmissionsPage);
		await screen.findByText("2026SS_01");

		// Delete one row through the confirm dialog.
		fireEvent.click(screen.getByLabelText("Select 2026SS_03"));
		fireEvent.click(screen.getByText("Delete"));
		expect(screen.getByText("Delete Submissions")).not.toBeNull();
		clickDialogConfirm("Delete");

		// The store refresh propagates: the deleted row leaves the table.
		await waitFor(() => {
			expect(screen.queryByText("2026SS_03")).toBeNull();
		});
		// Remaining rows stay.
		expect(screen.getByText("2026SS_01")).not.toBeNull();
		expect(screen.getByText("2026SS_75")).not.toBeNull();
	});

	it("keeps the selection bar consistent after the deleted row disappears", async () => {
		render(SubmissionsPage);
		await screen.findByText("2026SS_01");

		fireEvent.click(screen.getByLabelText("Select 2026SS_01"));
		expect(screen.getByText(/1 selected/)).not.toBeNull();

		fireEvent.click(screen.getByText("Delete"));
		clickDialogConfirm("Delete");

		// Row gone AND the bulk bar no longer counts it.
		await waitFor(() => {
			expect(screen.queryByText("2026SS_01")).toBeNull();
		});
		expect(screen.queryByText(/1 selected/)).toBeNull();
		expect(screen.getByText(/All 2 submissions/)).not.toBeNull();
	});
});
