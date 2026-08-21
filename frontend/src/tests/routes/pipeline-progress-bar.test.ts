/**
 * @file L4 page test — pipeline progress bar renders from restored run state.
 *
 * The submissions dashboard restores in-flight run trackers after a page
 * reload from the unified GET /api/pipeline/status (one call instead of
 * two). This test stubs that endpoint plus the per-run status fetches and
 * asserts the PipelineProgressBar renders above the log panel with the
 * live run's done/total, current notebook, elapsed, and auto-fix tallies.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";

import type { SubmissionMeta } from "$lib/types/submissions.js";
import type { PreEvalProgress, ProcessProgress } from "$lib/services/submissions-api.js";
import { markRunFinished, markRunStarted, setRunSummary } from "$lib/services/run-state.svelte.js";

// Static import (not dynamic): the page pulls in the tooltip component
// graph, whose first-load transform exceeds the per-test timeout in a
// fresh worker.
import SubmissionsPage from "../../routes/submissions/+page.svelte";

// ---------------------------------------------------------------------------
// Mocks — API client only; the store itself is real.
// ---------------------------------------------------------------------------

const PROCESS_RUNNING: ProcessProgress = {
	running: true,
	assignmentId: "soil_contamination",
	startedAt: Date.now() - 5000,
	currentStudentId: "2026SS_04",
	currentStartedAt: Date.now() - 1500,
	done: 7,
	total: 18,
	autofixAttempts: 3,
	autofixSucceeded: 2,
};

const PROCESS_IDLE: ProcessProgress = {
	running: false,
	assignmentId: null,
	startedAt: null,
	currentStudentId: null,
	currentStartedAt: null,
	done: 0,
	total: 0,
	autofixAttempts: 0,
	autofixSucceeded: 0,
};

const PRE_EVAL_RUNNING: PreEvalProgress = {
	running: true,
	assignmentId: "soil_contamination",
	startedAt: Date.now() - 3000,
	currentStudentId: "2026SS_02",
	currentStartedAt: Date.now() - 1000,
	done: 3,
	total: 10,
	succeeded: 3,
	failed: 0,
};

const PRE_EVAL_IDLE: PreEvalProgress = {
	running: false,
	assignmentId: null,
	startedAt: null,
	currentStudentId: null,
	currentStartedAt: null,
	done: 0,
	total: 0,
	succeeded: 0,
	failed: 0,
};

const api = vi.hoisted(() => {
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
		fetchProcessStatus: vi.fn(async () => PROCESS_IDLE),
		fetchPreEvalStatus: vi.fn(async () => PRE_EVAL_IDLE),
		fetchExecutorLogs: vi.fn(async () => ({ entries: [], truncated: false })),
		fetchPreEvalLogs: vi.fn(async () => ({ entries: [], truncated: false })),
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

/** The unified pipeline status endpoint (page-level fetch, not the API client). */
function stubPipelineStatus(process: ProcessProgress, preEval: PreEvalProgress): void {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => ({
			ok: true,
			json: async () => ({
				process,
				preEval,
				anyRunning: process.running || preEval.running,
			}),
		})) as unknown as typeof fetch,
	);
}

describe("submissions dashboard — pipeline progress bar", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		api.server = [meta("2026SS_01"), meta("2026SS_02"), meta("2026SS_04")];
		// Clear mock implementations left by earlier tests in the file (a
		// test that resolves a RUNNING status would otherwise leak that
		// running state into every later test and wrongly arm run guards).
		api.fetchProcessStatus.mockResolvedValue(PROCESS_IDLE);
		api.fetchPreEvalStatus.mockResolvedValue(PRE_EVAL_IDLE);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		// The run-state registry is a module singleton shared across every
		// test in this file — reset it so a run left armed by one test never
		// leaks as "active" into the next.
		markRunFinished("process");
		markRunFinished("preEval");
	});

	it("restores an in-flight process run from /api/pipeline/status and renders the bar", async () => {
		api.fetchProcessStatus.mockResolvedValue(PROCESS_RUNNING);
		stubPipelineStatus(PROCESS_RUNNING, PRE_EVAL_IDLE);
		render(SubmissionsPage);

		// The unified endpoint re-arms the run tracker → the bar appears with
		// the live run's data (server status wins for done/total).
		const bar = await screen.findByRole("progressbar", {
			name: "Pipeline progress: 7 of 18 notebooks",
		});
		expect(bar.getAttribute("aria-valuenow")).toBe("7");
		expect(bar.getAttribute("aria-valuemax")).toBe("18");
		expect(screen.getByText("7 of 18")).toBeTruthy();
		expect(screen.getByText("Current: 2026SS_04")).toBeTruthy();
		expect(screen.getByText("Auto-fix: 2 succeeded / 3 attempts")).toBeTruthy();
		expect(screen.getByText(/elapsed \d+:\d+/)).toBeTruthy();
	});

	it("renders the pre-evaluation bar when only the pre-eval run is in flight", async () => {
		api.fetchPreEvalStatus.mockResolvedValue(PRE_EVAL_RUNNING);
		stubPipelineStatus(PROCESS_IDLE, PRE_EVAL_RUNNING);
		render(SubmissionsPage);

		await screen.findByRole("progressbar", {
			name: "Pipeline progress: 3 of 10 notebooks",
		});
		expect(screen.getByText("Pre-evaluating batch")).toBeTruthy();
		expect(screen.getByText("3 of 10")).toBeTruthy();
		// No process bar, no auto-fix line for a pre-eval-only run.
		expect(screen.queryByText(/Auto-fix:/)).toBeNull();
	});

	it("stays hidden when no run is in flight", async () => {
		stubPipelineStatus(PROCESS_IDLE, PRE_EVAL_IDLE);
		render(SubmissionsPage);

		await screen.findByText("2026SS_01");
		expect(screen.queryByRole("progressbar")).toBeNull();
	});

	it("arming the shared registry (as a dashboard start does) lights the bar and disables Reset Pre-Evaluation (BUG-006/008)", async () => {
		// Include a pre-evaluated row so the Reset button is otherwise enabled
		// (canResetPreEvaluation), isolating the disable to BUG-008's guard.
		api.server = [meta("2026SS_01", "pre-evaluated"), meta("2026SS_02", "executed")];
		stubPipelineStatus(PROCESS_IDLE, PRE_EVAL_IDLE);
		render(SubmissionsPage);
		await screen.findByText("2026SS_01");

		const resetBtn = () => screen.getByRole("button", { name: /reset pre-evaluation/i });
		// Idle: Reset enabled (wait for the fresh list carrying the
		// pre-evaluated row), no pre-eval bar.
		await waitFor(() => expect(resetBtn().hasAttribute("disabled")).toBe(false));
		expect(screen.queryByText("Pre-evaluating batch")).toBeNull();

		// The dashboard's pre-evaluate POST handler arms the registry exactly
		// like this (markRunStarted) — the page must react through the single
		// source of truth, not page-local flags the dashboard never set.
		markRunStarted("preEval", 1);

		// BUG-006: the page's pre-eval progress bar (and log live mode) light up.
		await waitFor(() => expect(screen.getByText("Pre-evaluating batch")).toBeTruthy());
		// BUG-008: Reset Pre-Evaluation is now disabled while the run is active.
		await waitFor(() => expect(resetBtn().hasAttribute("disabled")).toBe(true));

		// The run ends (POST resolves -> markRunFinished): bar + disable clear.
		markRunFinished("preEval");
		await waitFor(() => expect(screen.queryByText("Pre-evaluating batch")).toBeNull());
		await waitFor(() => expect(resetBtn().hasAttribute("disabled")).toBe(false));
	});

	it("setRunSummary renders the completed pre-eval banner in the log panel (BUG-007)", async () => {
		api.server = [meta("2026SS_01", "executed")];
		stubPipelineStatus(PROCESS_IDLE, PRE_EVAL_IDLE);
		render(SubmissionsPage);
		await screen.findByText("2026SS_01");
		expect(screen.queryByText(/Pre-evaluation complete/)).toBeNull();

		// The dashboard's POST handler arms, records the returned tallies, and
		// finishes the run — the page's banner must read the registry summary.
		markRunStarted("preEval", 1);
		setRunSummary("preEval", { submitted: 1, succeeded: 1, failed: 0 });
		markRunFinished("preEval");

		// The panel auto-closes when the run's live flag clears; reopen it so
		// the run-complete banner (read from the shared registry) is visible.
		await fireEvent.click(screen.getByRole("button", { name: /pipeline log/i }));
		const banner = screen.getByRole("status");
		expect(banner.textContent).toContain("Pre-evaluation complete — 1/1 succeeded");
	});
});
