/**
 * @file Component tests — dashboard Pre-Eval column chip + Pre-evaluate All
 * button (Phase 4c wiring).
 *
 * Renders the real dashboard with the API client partially mocked (plagiarism
 * only) and a stubbed global fetch simulating the pre-evaluate routes:
 *   GET  /api/submissions/pre-evaluate/status
 *   POST /api/submissions/pre-evaluate
 *   GET  /api/submissions (store refresh after a finished run)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";

import SubmissionsDashboard from "$lib/components/submissions/submissions-dashboard.svelte";
import type { SubmissionMeta } from "$lib/types/submissions.js";
import { ApiError } from "$lib/services/submissions-api.js";

vi.mock("$app/paths", () => ({ base: "" }));

// Mock the API client only (plagiarism lookup); the submissions store is real.
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

const addToast = vi.hoisted(() => vi.fn());
vi.mock("$lib/stores/toast.svelte.js", () => ({ addToast }));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SUBMISSIONS: SubmissionMeta[] = [
	{
		id: "2026SS_01",
		studentId: "2026SS_01",
		assignmentId: "soil_contamination",
		semester: "2026SS",
		status: "pre-evaluated",
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
		status: "error",
		createdAt: "2026-08-01T00:00:00.000Z",
		updatedAt: "2026-08-01T00:00:00.000Z",
	},
];

/** Simulated server state behind the stubbed fetch. */
let runState: { running: boolean; done: number; total: number };
let postCalled: boolean;
let listCalls: number;

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function stubFetch() {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
			const url = String(input);
			if (url.includes("/api/submissions/pre-evaluate/status")) {
				// Status is only meaningful once a run was started via the POST
				// (fast-run simulation: the run is already over by poll time).
				if (!postCalled) {
					return jsonResponse({ running: false, done: 0, total: 0 });
				}
				return jsonResponse(runState);
			}
			if (url.includes("/api/submissions/pre-evaluate")) {
				postCalled = true;
				runState = { running: false, done: 2, total: 2 };
				return jsonResponse({
					assignmentId: "soil_contamination",
					submitted: 2,
					succeeded: 2,
					failed: 0,
					results: [
						{ studentId: "2026SS_02", ok: true, error: null },
						{ studentId: "2026SS_03", ok: true, error: null },
					],
				});
			}
			if (url.includes("/api/submissions")) {
				listCalls += 1;
				// Server-side truth: the two targets are now pre-evaluated.
				return jsonResponse({
					assignmentId: "soil_contamination",
					submissions: SUBMISSIONS.map((s) =>
						s.status === "executed" || s.status === "error"
							? { ...s, status: "pre-evaluated" }
							: s,
					),
				});
			}
			return jsonResponse({ message: "not found" }, 404);
		}),
	);
}

function renderDashboard(submissions: SubmissionMeta[] = SUBMISSIONS) {
	const callbacks = {
		onToggleSelect: vi.fn(),
		onSelectRange: vi.fn(),
		onDeselectRange: vi.fn(),
		onSelectAllVisible: vi.fn(),
		onClearSelection: vi.fn(),
	};
	return render(SubmissionsDashboard, {
		props: {
			submissions,
			searchQuery: "",
			statusFilter: "all",
			assignmentId: "soil_contamination",
			selectedIds: new Set<string>(),
			onSearchChange: vi.fn(),
			onStatusFilterChange: vi.fn(),
			...callbacks,
		},
	});
}

function rowOf(studentId: string): HTMLElement {
	return screen.getByText(studentId).closest("tr")!;
}

beforeEach(() => {
	vi.clearAllMocks();
	runState = { running: false, done: 0, total: 0 };
	postCalled = false;
	listCalls = 0;
	stubFetch();
	api.fetchPlagiarismResults.mockRejectedValue(new ApiError(404, "No plagiarism check yet"));
});

afterEach(() => {
	vi.unstubAllGlobals();
	cleanup();
});

describe("submissions-dashboard pre-evaluation wiring", () => {
	it("renders the Pre-Eval chip: check for pre-evaluated rows, dash for the rest", async () => {
		renderDashboard();

		// The pre-evaluated row carries the check-style indicator.
		const doneRow = rowOf("2026SS_01");
		await waitFor(() => {
			expect(within(doneRow).getByTitle("Pre-evaluated")).not.toBeNull();
		});

		// Executed/error rows have no pre-evaluation yet — muted dash.
		for (const id of ["2026SS_02", "2026SS_03"]) {
			expect(within(rowOf(id)).getAllByText("—").length).toBeGreaterThan(0);
		}
		expect(within(doneRow).queryByTitle("Pre-evaluation in progress")).toBeNull();
	});

	it("enables Pre-evaluate All only when executed/error rows exist and nothing runs", async () => {
		renderDashboard();
		const button = await screen.findByRole("button", { name: /pre-evaluate all/i });
		expect(button.hasAttribute("disabled")).toBe(false);

		// No targets (all pre-evaluated/graded) -> disabled.
		cleanup();
		renderDashboard(SUBMISSIONS.map((s) => ({ ...s, status: "graded" as const })));
		const disabledButton = await screen.findByRole("button", { name: /pre-evaluate all/i });
		expect(disabledButton.hasAttribute("disabled")).toBe(true);
	});

	it("shows the running spinner per target row and progress while a run is in flight", async () => {
		// Simulate a reload mid-run: the status endpoint reports a live run.
		postCalled = true;
		runState = { running: true, done: 1, total: 2 };
		renderDashboard();

		// Executed/error rows are targets -> spinner.
		await waitFor(() => {
			expect(screen.getAllByTitle("Pre-evaluation in progress").length).toBe(2);
		});
		// The already pre-evaluated row keeps its check chip.
		expect(screen.getAllByTitle("Pre-evaluated").length).toBe(1);

		// Button disabled and shows the live progress.
		const button = await screen.findByRole("button", { name: /pre-evaluating/i });
		expect(button.hasAttribute("disabled")).toBe(true);
		expect(button.textContent).toContain("1/2");
	});

	it("POSTs to the pre-evaluate route and refreshes the list when the run finishes", async () => {
		renderDashboard();
		const button = await screen.findByRole("button", { name: /pre-evaluate all/i });
		fireEvent.click(button);

		// POST fired with the assignment query param.
		await waitFor(() => {
			const fetchMock = vi.mocked(fetch);
			const postCall = fetchMock.mock.calls.find(([input, init]) => {
				return (
					String(input).includes("/api/submissions/pre-evaluate") &&
					init?.method === "POST"
				);
			});
			expect(postCall).toBeDefined();
		});

		// Success toast with the run summary.
		await waitFor(() => {
			expect(addToast).toHaveBeenCalledWith(
				"success",
				"Pre-evaluated 2 of 2 submission(s)",
				5000,
			);
		});

		// The fast run already finished by poll time -> the list is refreshed
		// so the flipped "pre-evaluated" statuses show up in place.
		await waitFor(() => {
			expect(listCalls).toBeGreaterThan(0);
		});
		// Button is re-enabled after the run (no targets left server-side,
		// but the local prop still has executed/error rows — the disabled
		// flag comes from the run state, which cleared).
		await waitFor(() => {
			const reEnabled = screen.getByRole("button", { name: /pre-evaluate all/i });
			expect(reEnabled.hasAttribute("disabled")).toBe(false);
		});
	});

	it("surfaces a 409 already-running response as an error toast", async () => {
		// The button is disabled while running, but a second tab could race:
		// the route answers 409 and the dashboard must not crash.
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
				const url = String(input);
				if (url.includes("/api/submissions/pre-evaluate/status")) {
					return jsonResponse({ running: false, done: 0, total: 0 });
				}
				if (url.includes("/api/submissions/pre-evaluate")) {
					return jsonResponse(
						{ message: "A pre-evaluation run is already in progress" },
						409,
					);
				}
				return jsonResponse({ message: "not found" }, 404);
			}),
		);

		renderDashboard();
		const button = await screen.findByRole("button", { name: /pre-evaluate all/i });
		fireEvent.click(button);

		await waitFor(() => {
			expect(addToast).toHaveBeenCalledWith(
				"error",
				"A pre-evaluation run is already in progress",
				4000,
			);
		});
	});
});
