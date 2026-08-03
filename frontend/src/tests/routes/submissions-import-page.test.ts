/**
 * @file Light L4 page test — teacher YAML Import wiring (Phase 3f E5).
 *
 * Renders the per-submission page with the data stores and heavy child
 * components mocked, then asserts the header-config Import wiring:
 *   - showImport flips true once the submission loads, and onimportclick
 *     opens the hidden file picker;
 *   - choosing a *-teacher.yaml imports it via
 *     submissionsStore.importTeacherYaml, refreshes the plagiarism store,
 *     and toasts success (error path toasts the message);
 *   - unmounting resets showImport/onimportclick (mirror of export cleanup).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/svelte";

import Page from "../../routes/submissions/[id]/+page.svelte";
import type { SubmissionDetail } from "$lib/types/submissions.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("$lib/services/submissions-store.js", () => ({
	submissionsStore: {
		select: vi.fn(),
		saveGrading: vi.fn(),
		export: vi.fn(),
		importTeacherYaml: vi.fn(),
	},
}));

vi.mock("$lib/services/plagiarism-store.svelte.js", () => ({
	plagiarismStore: {
		load: vi.fn().mockResolvedValue(null),
		unreviewedCount: vi.fn(() => 0),
		countByStatus: vi.fn(() => 0),
		ignoreAllUnreviewed: vi.fn().mockResolvedValue(undefined),
	},
}));

vi.mock("$lib/services/autofix-store.svelte.js", () => ({
	autofixStore: { reset: vi.fn() },
}));

vi.mock("$lib/stores/toast.svelte.js", () => ({
	addToast: vi.fn(),
}));

vi.mock("$lib/services/criteria-loader.js", () => ({
	getCriteriaForAssignment: vi.fn().mockResolvedValue(null),
}));

vi.mock("$app/state", () => ({
	page: { params: { id: "2026SS_03" } },
}));

vi.mock("$app/paths", () => ({ base: "" }));

// Heavy/leaf children — not the subject under test.
vi.mock("$lib/components/submissions/execution-output.svelte", () => ({
	default: () => {},
}));
vi.mock("$lib/components/submissions/reference-comparison.svelte", () => ({
	default: () => {},
}));
vi.mock("$lib/components/submissions/right-panel-tabs.svelte", () => ({
	default: () => {},
}));
vi.mock("$lib/components/ui/menu-button.svelte", () => ({ default: () => {} }));
vi.mock("$lib/components/ui/skeleton-pulse.svelte", () => ({ default: () => {} }));

// Real singleton — the assertions read the actual header store the page writes.
import { headerConfig } from "$lib/stores/header.svelte.js";
import { submissionsStore } from "$lib/services/submissions-store.js";
import { plagiarismStore } from "$lib/services/plagiarism-store.svelte.js";
import { addToast } from "$lib/stores/toast.svelte.js";

// jsdom does not implement matchMedia; the page's mobile-breakpoint effect
// needs it to render (stub: desktop, matches=false).
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
	Object.defineProperty(window, "matchMedia", {
		writable: true,
		value: (query: string) => ({
			matches: false,
			media: query,
			onchange: null,
			addListener: () => {},
			removeListener: () => {},
			addEventListener: () => {},
			removeEventListener: () => {},
			dispatchEvent: () => false,
		}),
	});
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DETAIL: SubmissionDetail = {
	id: "2026SS_03",
	studentId: "2026SS_03",
	assignmentId: "soil_contamination",
	semester: "2026SS",
	status: "executed",
	createdAt: "2026-08-01T10:00:00.000Z",
	updatedAt: "2026-08-01T10:00:00.000Z",
	cells: [],
	referenceCells: [],
	grading: {},
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("submissions/[id] — teacher YAML Import wiring (E5)", () => {
	beforeEach(() => {
		vi.mocked(submissionsStore.select).mockReset();
		vi.mocked(submissionsStore.select).mockResolvedValue(DETAIL);
		vi.mocked(submissionsStore.importTeacherYaml).mockReset();
		vi.mocked(plagiarismStore.load).mockClear();
		vi.mocked(addToast).mockClear();
		// Reset the shared header singleton (the page's effect owns it).
		headerConfig.showImport = false;
		headerConfig.onimportclick = undefined;
		// The page fetches /data/grading_config.yaml — stub it away.
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("sets showImport + onimportclick once the submission loads", async () => {
		render(Page);
		await waitFor(() => expect(vi.mocked(submissionsStore.select)).toHaveBeenCalled());
		await waitFor(() => expect(headerConfig.showImport).toBe(true));
		expect(headerConfig.onimportclick).toBeTypeOf("function");
	});

	it("onimportclick opens the hidden picker; a chosen YAML imports, refreshes plagiarism, toasts", async () => {
		vi.mocked(submissionsStore.importTeacherYaml).mockResolvedValue({
			...DETAIL,
			status: "graded",
			teacherGrade: 12,
		});

		render(Page);
		await waitFor(() => expect(headerConfig.showImport).toBe(true));

		const input = document.querySelector('input[type="file"]') as HTMLInputElement;
		expect(input).not.toBeNull();

		// Header action opens the hidden file input.
		const clickSpy = vi.spyOn(input, "click");
		headerConfig.onimportclick?.();
		expect(clickSpy).toHaveBeenCalled();

		// Picking a teacher YAML imports it through the store wrapper.
		const file = new File(["student_id: 2026SS_03"], "2026SS_03-teacher.yaml", {
			type: "text/yaml",
		});
		await fireEvent.change(input, { target: { files: [file] } });

		await waitFor(() =>
			expect(vi.mocked(submissionsStore.importTeacherYaml)).toHaveBeenCalledWith(
				"2026SS_03",
				"student_id: 2026SS_03",
			),
		);
		// Badges/statuses may have changed — the page reloads the assignment's pairs.
		expect(vi.mocked(plagiarismStore.load)).toHaveBeenCalledWith("soil_contamination");
		expect(vi.mocked(addToast)).toHaveBeenCalledWith(
			"success",
			"Imported 2026SS_03-teacher.yaml",
			3500,
		);
	});

	it("toasts the error message when the import fails", async () => {
		vi.mocked(submissionsStore.importTeacherYaml).mockRejectedValue(
			new Error("Malformed teacher YAML"),
		);

		render(Page);
		await waitFor(() => expect(headerConfig.showImport).toBe(true));

		const input = document.querySelector('input[type="file"]') as HTMLInputElement;
		const file = new File(["scores: [1, 2]"], "2026SS_03-teacher.yaml", { type: "text/yaml" });
		await fireEvent.change(input, { target: { files: [file] } });

		await waitFor(() =>
			expect(vi.mocked(addToast)).toHaveBeenCalledWith(
				"error",
				"Malformed teacher YAML",
				5000,
			),
		);
	});

	it("resets showImport + onimportclick on unmount", async () => {
		const { unmount } = render(Page);
		await waitFor(() => expect(headerConfig.showImport).toBe(true));
		expect(headerConfig.onimportclick).toBeTypeOf("function");

		unmount();

		expect(headerConfig.showImport).toBe(false);
		expect(headerConfig.onimportclick).toBeUndefined();
	});
});
