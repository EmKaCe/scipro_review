/**
 * @file Component tests — pipeline log panel.
 *
 * Covers: collapsed default, expand/collapse toggle, live badge, completed
 * run summary chip, level-colored rendering, refresh callback, and the empty
 * state.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";

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

function baseProps(overrides: Record<string, unknown> = {}) {
	return {
		entries: ENTRIES,
		live: false,
		loading: false,
		error: null,
		summary: null,
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

	it("shows the live badge while a batch runs", () => {
		render(PipelineLogPanel, { props: baseProps({ live: true }) });

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
});
