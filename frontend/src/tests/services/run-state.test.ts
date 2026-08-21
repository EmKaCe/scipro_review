/**
 * @file Unit tests for the shared run-state registry (B4).
 *
 * The registry is the single source of truth for batch-run progress shared
 * across the submissions page, the dashboard, and the submissions store. These
 * tests pin the helper semantics behind BUG-006 / BUG-007 / BUG-008 / BUG-020:
 *   - markRunStarted arms startedAt/targetCount/running and invalidates any
 *     previous summary.
 *   - markRunFinished clears the flags but KEEPS the summary (the completed-run
 *     banner survives a run ending — BUG-007).
 *   - only markRunFinished disarms (an idle status observation never does).
 *   - setRunSummary records the POST's returned tallies.
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
	isRunActive,
	markRunFinished,
	markRunStarted,
	runRegistry,
	setRunSummary,
} from "$lib/services/run-state.svelte.js";

/** Returns the registry to a clean, idle state before every test. */
function reset() {
	markRunFinished("process");
	markRunFinished("preEval");
}

describe("run-state registry", () => {
	beforeEach(reset);

	it("markRunStarted arms startedAt/targetCount/running and clears a prior summary", () => {
		setRunSummary("preEval", { submitted: 2, succeeded: 2, failed: 0 });
		const before = Date.now();
		markRunStarted("preEval", 3);

		const snap = runRegistry.preEval;
		expect(snap.running).toBe(true);
		expect(snap.targetCount).toBe(3);
		expect(snap.startedAt).not.toBeNull();
		expect(snap.startedAt!).toBeGreaterThanOrEqual(before);
		// A new run invalidates the old completed-run tallies.
		expect(snap.summary).toBeNull();
		expect(isRunActive("preEval")).toBe(true);
	});

	it("markRunStarted accepts an explicit server start time (reload-mid-run restore)", () => {
		markRunStarted("process", 5, 12345);
		expect(runRegistry.process.startedAt).toBe(12345);
		expect(runRegistry.process.targetCount).toBe(5);
		expect(runRegistry.process.running).toBe(true);
	});

	it("markRunFinished keeps the summary but clears the run flags (BUG-007 banner survives)", () => {
		markRunStarted("preEval", 3);
		setRunSummary("preEval", { submitted: 3, succeeded: 2, failed: 1 });
		markRunFinished("preEval");

		const snap = runRegistry.preEval;
		expect(snap.running).toBe(false);
		expect(snap.startedAt).toBeNull();
		expect(snap.targetCount).toBe(0);
		// The completed-run tallies remain so the log panel banner shows them.
		expect(snap.summary).toEqual({ submitted: 3, succeeded: 2, failed: 1 });
		expect(isRunActive("preEval")).toBe(false);
	});

	it("an idle observation never disarms — only markRunFinished toggles running", () => {
		markRunStarted("preEval", 2);
		// A status poll observing running:false/total:0 does not touch the
		// registry, so the run stays armed until the POST handler finishes it.
		expect(isRunActive("preEval")).toBe(true);
		expect(runRegistry.preEval.startedAt).not.toBeNull();

		markRunFinished("preEval");
		expect(isRunActive("preEval")).toBe(false);
	});

	it("setRunSummary records the tallies for a given kind", () => {
		setRunSummary("preEval", { submitted: 4, succeeded: 4, failed: 0 });
		expect(runRegistry.preEval.summary).toEqual({ submitted: 4, succeeded: 4, failed: 0 });
		// Process summary stays untouched (null).
		expect(runRegistry.process.summary).toBeNull();
	});
});
