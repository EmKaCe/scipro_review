/**
 * Phase 4c — pure mapping logic for pre-evaluation cell markers.
 *
 * Covers the three decisions that must stay consistent across
 * execution-output.svelte and reference-comparison.svelte:
 *   1. marker lookup by cellIndex (verdicts are index-addressed)
 *   2. the hasComparison guard (markers: null/[] → pending UI, no badges)
 *   3. D2 tone mapping (same → info, different → neutral, questionable → warning)
 *
 * Rule under test: a cell without a verdict entry NEVER falls back to a
 * fabricated marker (the Phase 3 "different everywhere" regression).
 */
import { describe, expect, it } from "vitest";

import { hasRealMarkers, markerTone, verdictForCell } from "$lib/utils/marker-rendering.js";
import type { PreEvalCellVerdict } from "$lib/types/submissions.js";

const VERDICTS: PreEvalCellVerdict[] = [
	{ cellIndex: 0, marker: "same", reason: "identical approach" },
	{ cellIndex: 2, marker: "different", reason: "uses numpy" },
	{ cellIndex: 5, marker: "questionable", reason: "hardcodes the answer" },
];

describe("markerTone (D2 tones)", () => {
	it("maps same → info (blue), different → neutral (gray), questionable → warning (amber)", () => {
		expect(markerTone("same")).toBe("info");
		expect(markerTone("different")).toBe("neutral");
		expect(markerTone("questionable")).toBe("warning");
	});
});

describe("hasRealMarkers (hasComparison guard)", () => {
	it("is false when markers is null — pre-evaluation never ran", () => {
		expect(hasRealMarkers(null)).toBe(false);
	});

	it("is false when markers is undefined or an empty array", () => {
		expect(hasRealMarkers(undefined)).toBe(false);
		expect(hasRealMarkers([])).toBe(false);
	});

	it("is true when at least one real comparison marker exists", () => {
		expect(hasRealMarkers(VERDICTS)).toBe(true);
	});
});

describe("verdictForCell (lookup by cellIndex)", () => {
	it("finds the verdict for a compared cell by its index", () => {
		const verdict = verdictForCell(VERDICTS, 2);
		expect(verdict?.marker).toBe("different");
		expect(verdict?.reason).toBe("uses numpy");
		expect(verdictForCell(VERDICTS, 0)?.marker).toBe("same");
	});

	it("returns undefined for a cell without a verdict entry", () => {
		expect(verdictForCell(VERDICTS, 1)).toBeUndefined();
		expect(verdictForCell(VERDICTS, 99)).toBeUndefined();
	});

	it("returns undefined when no markers exist — never fabricates a marker", () => {
		expect(verdictForCell(null, 0)).toBeUndefined();
		expect(verdictForCell(undefined, 0)).toBeUndefined();
		expect(verdictForCell([], 0)).toBeUndefined();
	});
});
