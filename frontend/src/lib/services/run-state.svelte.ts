/**
 * @file Shared batch run-state registry (single source of truth).
 *
 * Unifies pre-evaluation and process batch-run tracking across the submissions
 * list page (routes/submissions/+page.svelte), the dashboard, and the
 * submissions store (BUG-006 / BUG-007 / BUG-008 / BUG-020).
 *
 * A module-level `$state` snapshot means a run started from EITHER the page or
 * the dashboard writes ONE place, and every consumer (page progress bar, log
 * panel live mode, the page's polling/stopwatch effects, Reset-disable, the
 * store's list-polling loop) reads the same reactive state — no prop drilling,
 * no duplicated page-local flags that a sibling can fail to arm.
 *
 * Semantics (these encode the hard-won invariants):
 *  - markRunStarted() arms startedAt/targetCount/running and clears any
 *    previous summary (a new run invalidates the old tallies).
 *  - markRunFinished() clears running/startedAt/targetCount but KEEPS the
 *    summary so the completed-run banner survives a run ending. Only the POST
 *    handler calls it, so an idle status observation (running:false, total:0
 *    before a run registers) never disarms the polling loops mid-run.
 *  - setRunSummary() records the POST's returned tallies for the banner.
 */

import type { PreEvalRunSummary } from "./submissions-api.js";

export type RunKind = "process" | "preEval";

export interface RunSnapshot {
	/** Epoch ms when the run started (null when idle). */
	startedAt: number | null;
	/** Number of submissions targeted by the run. */
	targetCount: number;
	/** True while the run is starting or in flight. */
	running: boolean;
	/** Completed-run tallies for pre-evaluation (null otherwise). */
	summary: PreEvalRunSummary | null;
}

/** Shared, globally-reactive run-state registry. */
export const runRegistry = $state<Record<RunKind, RunSnapshot>>({
	process: { startedAt: null, targetCount: 0, running: false, summary: null },
	preEval: { startedAt: null, targetCount: 0, running: false, summary: null },
});

/**
 * Arm a run. Only the run's own starter (the process bulk handler / the
 * pre-evaluate POST handler / the reload-mid-run restore) calls this — a mere
 * status observation must never arm a run.
 *
 * @param total     Number of submissions targeted by the run.
 * @param startedAt Optional server-reported start time (reload-mid-run
 *                  restore) so the elapsed stopwatch continues rather than
 *                  resetting to the page-load instant. Defaults to now.
 */
export function markRunStarted(
	kind: RunKind,
	total: number,
	startedAt: number = Date.now(),
): void {
	const snap = runRegistry[kind];
	snap.startedAt = startedAt;
	snap.targetCount = total;
	snap.running = true;
	// A new run invalidates any previous completed-run tallies.
	snap.summary = null;
}

/**
 * Clear the run flags when the POST resolves (success or error). Keeps the
 * completed-run summary so the log panel banner survives the run ending.
 */
export function markRunFinished(kind: RunKind): void {
	const snap = runRegistry[kind];
	snap.running = false;
	snap.startedAt = null;
	snap.targetCount = 0;
}

/** Record a completed pre-evaluation run's tallies (log panel banner). */
export function setRunSummary(kind: RunKind, summary: PreEvalRunSummary): void {
	runRegistry[kind].summary = summary;
}

/** True while the given kind of run is starting or in flight. */
export function isRunActive(kind: RunKind): boolean {
	return runRegistry[kind].running;
}
