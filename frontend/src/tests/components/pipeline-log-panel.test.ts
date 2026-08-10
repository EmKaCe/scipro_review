/**
 * @file Component tests — pipeline log panel.
 *
 * Covers: collapsed default, compact collapsed strip (latest entry +
 * progress), expand/collapse toggle, auto-open while a run is live, live
 * badge, completed-run summary chip, collapsible per-row detail with the
 * full pre-evaluation data (dimensions breakdown, rubric selections list,
 * highlighted summary), source filter, refresh callback, empty/error states,
 * and the pre-evaluation run-complete banner.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/svelte";

import PipelineLogPanel from "$lib/components/submissions/pipeline-log-panel.svelte";
import type { ExecutorLogEntry } from "$lib/services/submissions-api.js";

vi.mock("$app/paths", () => ({ base: "" }));

const ENTRIES: ExecutorLogEntry[] = [
	{
		id: 1,
		ts: 1_752_000_000,
		level: "info",
		logger: "runner",
		message: "Executing: 2026SS_03.ipynb (24 cells)",
	},
	{
		id: 2,
		ts: 1_752_000_001,
		level: "warning",
		logger: "auto_fix",
		message: "auto-fix: cell 19 still failing after re-run",
	},
	{
		id: 3,
		ts: 1_752_000_002,
		level: "error",
		logger: "executor",
		message: "Execution failed",
	},
];

const PRE_EVAL_ENTRIES: ExecutorLogEntry[] = [
	{
		id: 1,
		ts: 1_752_000_003,
		level: "info",
		logger: "pre-eval",
		message: 'Pre-evaluated "2026SS_01" — 3 cell marker(s), 2 rubric selection(s)',
		source: "pre-eval",
		submissionId: "2026SS_01",
		grades: { code_quality_design: 4, documentation: 5 },
		markerCount: 3,
		selectionCount: 2,
		rubricSelections: [
			{ categoryKey: "code_quality_design", optionKey: "good" },
			{ categoryKey: "documentation", optionKey: "complete" },
		],
		ok: true,
	},
	{
		id: 2,
		ts: 1_752_000_004,
		level: "error",
		logger: "pre-eval",
		message: 'Pre-evaluation failed for "2026SS_02": upstream timeout',
		source: "pre-eval",
		submissionId: "2026SS_02",
		grades: {},
		markerCount: 0,
		selectionCount: 0,
		ok: false,
	},
];

function baseProps(overrides: Record<string, unknown> = {}) {
	return {
		entries: ENTRIES,
		live: false,
		loading: false,
		error: null,
		summary: null,
		preEvalSummary: null,
		progress: null,
		onRefresh: vi.fn(),
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("pipeline-log-panel", () => {
	it("renders the header and stays collapsed by default", () => {
		render(PipelineLogPanel, { props: baseProps() });

		expect(screen.getByText("Pipeline log")).toBeTruthy();
		expect(screen.queryByText(/Executing: 2026SS_03/)).toBeNull();
	});

	it("expands to show entries with logger + message", async () => {
		render(PipelineLogPanel, { props: baseProps() });
		await fireEvent.click(screen.getByRole("button", { name: /Pipeline log/ }));

		expect(screen.getByText(/Executing: 2026SS_03/)).toBeTruthy();
		expect(screen.getByText(/still failing after re-run/)).toBeTruthy();
	});

	it("shows the compact collapsed strip with the latest entry", () => {
		render(PipelineLogPanel, { props: baseProps() });

		// Collapsed: only the newest line is previewed, older lines stay hidden.
		expect(screen.getByText("Execution failed")).toBeTruthy();
		expect(screen.queryByText(/Executing: 2026SS_03/)).toBeNull();
	});

	it("shows run progress in the compact collapsed strip while live", async () => {
		render(PipelineLogPanel, {
			props: baseProps({ live: true, progress: { done: 2, total: 5 } }),
		});

		// Live runs auto-open; collapsing reveals the compact strip + progress.
		await fireEvent.click(screen.getByRole("button", { name: /Pipeline log/ }));
		expect(screen.getByText("2/5")).toBeTruthy();
	});

	it("opens by default while a run is live", () => {
		render(PipelineLogPanel, { props: baseProps({ live: true }) });

		// Auto-open: the log body renders without a toggle click.
		expect(screen.getByText(/Executing: 2026SS_03/)).toBeTruthy();
		expect(screen.getByText("Live")).toBeTruthy();
	});

	it("shows the completed-run summary chip when not live", () => {
		render(PipelineLogPanel, {
			props: baseProps({ live: false, summary: "3/3 notebooks · auto-fix 1/1" }),
		});

		expect(screen.getByText("3/3 notebooks · auto-fix 1/1")).toBeTruthy();
	});

	it("fires the refresh callback", async () => {
		const onRefresh = vi.fn();
		render(PipelineLogPanel, { props: baseProps({ onRefresh }) });
		await fireEvent.click(screen.getByRole("button", { name: /Pipeline log/ }));

		await fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));
		expect(onRefresh).toHaveBeenCalledTimes(1);
	});

	it("renders the empty state when there are no entries", async () => {
		render(PipelineLogPanel, { props: baseProps({ entries: [] }) });
		await fireEvent.click(screen.getByRole("button", { name: /Pipeline log/ }));

		expect(screen.getByText(/No pipeline activity captured yet/)).toBeTruthy();
	});

	it("renders the error state instead of the list", async () => {
		render(PipelineLogPanel, {
			props: baseProps({ entries: [], error: "executor unreachable" }),
		});
		await fireEvent.click(screen.getByRole("button", { name: /Pipeline log/ }));

		expect(screen.getByText(/Logs unavailable: executor unreachable/)).toBeTruthy();
	});

	it("shows pre-eval rows collapsed, then expands a row to reveal the full data", async () => {
		const { container } = render(PipelineLogPanel, {
			props: baseProps({ entries: PRE_EVAL_ENTRIES }),
		});
		await fireEvent.click(screen.getByRole("button", { name: /Pipeline log/ }));

		// Source tag distinguishes pre-eval from executor entries.
		expect(screen.getAllByText("PRE-EVAL")).toHaveLength(2);

		// Detail is hidden until the row is clicked.
		expect(screen.queryByText("markers: 3")).toBeNull();

		await fireEvent.click(screen.getByRole("button", { name: /2026SS_01/ }));

		// Expanded: submission id, status, counts.
		expect(screen.getByText("2026SS_01")).toBeTruthy();
		expect(screen.getByText("markers: 3")).toBeTruthy();
		expect(screen.getByText("selections: 2")).toBeTruthy();

		// Dimensions breakdown (dimension -> value pairs).
		const dimGrid = container.querySelector(".log-dim-grid");
		expect(dimGrid).toBeTruthy();
		expect(within(dimGrid as HTMLElement).getByText("code_quality_design")).toBeTruthy();
		expect(within(dimGrid as HTMLElement).getByText("documentation")).toBeTruthy();

		// Rubric selections list.
		expect(screen.getByText("good")).toBeTruthy();
		expect(screen.getByText("complete")).toBeTruthy();

		// Syntax-highlighted summary block renders the pre-eval envelope.
		const json = container.querySelector(".log-json");
		expect(json).toBeTruthy();
		expect(json?.textContent).toContain('"submission": "2026SS_01"');
		expect(json?.textContent).toContain('"ok": true');
		expect(json?.textContent).toContain('"code_quality_design": 4');
	});

	it("expands a failed pre-eval row with its error detail", async () => {
		render(PipelineLogPanel, { props: baseProps({ entries: PRE_EVAL_ENTRIES }) });
		await fireEvent.click(screen.getByRole("button", { name: /Pipeline log/ }));

		await fireEvent.click(screen.getByRole("button", { name: /2026SS_02/ }));

		expect(screen.getByText("failed")).toBeTruthy();
		expect(screen.getByText(/Pre-evaluation failed for "2026SS_02"/)).toBeTruthy();
	});

	it("collapses a row again on a second click", async () => {
		render(PipelineLogPanel, { props: baseProps({ entries: PRE_EVAL_ENTRIES }) });
		await fireEvent.click(screen.getByRole("button", { name: /Pipeline log/ }));
		const row = screen.getByRole("button", { name: /2026SS_01/ });

		await fireEvent.click(row);
		expect(screen.getByText("markers: 3")).toBeTruthy();

		await fireEvent.click(row);
		expect(screen.queryByText("markers: 3")).toBeNull();
	});

	it("hides pre-eval entries via the source filter toggle", async () => {
		render(PipelineLogPanel, {
			props: baseProps({ entries: [...ENTRIES, ...PRE_EVAL_ENTRIES] }),
		});
		await fireEvent.click(screen.getByRole("button", { name: /Pipeline log/ }));

		// Mixed timeline renders both sources.
		expect(screen.getAllByText("PRE-EVAL")).toHaveLength(2);
		expect(screen.getAllByText("EXEC")).toHaveLength(3);

		await fireEvent.click(screen.getByRole("button", { name: "Executor" }));
		expect(screen.queryByText("PRE-EVAL")).toBeNull();
		expect(screen.getAllByText("EXEC")).toHaveLength(3);
		expect(screen.queryByText(/Pre-evaluated "2026SS_01"/)).toBeNull();

		await fireEvent.click(screen.getByRole("button", { name: "Pre-eval" }));
		expect(screen.getAllByText("PRE-EVAL")).toHaveLength(2);
		expect(screen.queryByText("EXEC")).toBeNull();
		expect(screen.queryByText(/Executing: 2026SS_03/)).toBeNull();

		await fireEvent.click(screen.getByRole("button", { name: "All" }));
		expect(screen.getAllByText("PRE-EVAL")).toHaveLength(2);
		expect(screen.getAllByText("EXEC")).toHaveLength(3);
	});

	it("shows the pre-evaluation run-complete banner with tallies", async () => {
		render(PipelineLogPanel, {
			props: baseProps({
				entries: PRE_EVAL_ENTRIES,
				preEvalSummary: { submitted: 3, succeeded: 3, failed: 0 },
			}),
		});
		await fireEvent.click(screen.getByRole("button", { name: /Pipeline log/ }));

		const banner = screen.getByRole("status");
		expect(banner.textContent).toContain("Pre-evaluation complete — 3/3 succeeded");
	});

	it("shows the failed count in the run-complete banner", async () => {
		render(PipelineLogPanel, {
			props: baseProps({
				entries: PRE_EVAL_ENTRIES,
				live: false,
				preEvalSummary: { submitted: 3, succeeded: 2, failed: 1 },
			}),
		});
		await fireEvent.click(screen.getByRole("button", { name: /Pipeline log/ }));

		const banner = screen.getByRole("status");
		expect(banner.textContent).toContain("Pre-evaluation complete — 2/3 succeeded, 1 failed");
	});

	it("suppresses the run-complete banner while a run is live", () => {
		render(PipelineLogPanel, {
			props: baseProps({
				entries: PRE_EVAL_ENTRIES,
				live: true,
				preEvalSummary: { submitted: 3, succeeded: 2, failed: 1 },
			}),
		});

		// While a run is live the banner is suppressed (Live badge instead).
		expect(screen.queryByText(/Pre-evaluation complete/)).toBeNull();
		expect(screen.getByText("Live")).toBeTruthy();
	});

	it("scopes detail assertions to the expanded row only", async () => {
		const { container } = render(PipelineLogPanel, {
			props: baseProps({ entries: PRE_EVAL_ENTRIES }),
		});
		await fireEvent.click(screen.getByRole("button", { name: /Pipeline log/ }));
		await fireEvent.click(screen.getByRole("button", { name: /2026SS_01/ }));

		const detail = container.querySelector(".pipeline-log-detail");
		expect(detail).toBeTruthy();
		expect(within(detail as HTMLElement).getByText("2026SS_01")).toBeTruthy();
	});
});
