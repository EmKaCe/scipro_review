/**
 * @file Pure rendering helpers for pre-evaluation cell markers.
 *
 * The components keep their own icon/label/class configs; this module owns
 * the three decisions that must stay consistent everywhere:
 *
 *   1. marker lookup by cellIndex — pre-evaluation verdicts are
 *      index-addressed, never positional.
 *   2. the hasComparison guard — `markers: null` (pre-evaluation never ran)
 *      or `[]` means NO comparison data: the UI keeps its pending/neutral
 *      state and renders no approach badges.
 *   3. D2 tones — same → info/blue, different → neutral gray (the DEFAULT
 *      state, never a flag), questionable → amber/caution.
 *
 * Rule of thumb for consumers: a cell without a verdict entry must render
 * NOTHING (no badge), never a fabricated "different" marker.
 */

import type { PreEvalCellVerdict, PreEvalMarker } from "$lib/types/submissions.js";

/** D2 tone for a comparison marker. */
export type MarkerTone = "info" | "neutral" | "warning";

/** Map a pre-evaluation marker to its D2 tone. */
export function markerTone(marker: PreEvalMarker): MarkerTone {
	switch (marker) {
		case "same":
			return "info";
		case "different":
			return "neutral";
		case "questionable":
			return "warning";
	}
}

/**
 * True when the submission carries at least one real comparison marker.
 * `null` (pre-evaluation never ran) and `[]` (ran, nothing compared) both
 * mean "no comparison data" — callers keep the pending/neutral state.
 */
export function hasRealMarkers(markers: readonly PreEvalCellVerdict[] | null | undefined): boolean {
	return markers !== null && markers !== undefined && markers.length > 0;
}

/**
 * Look up the pre-evaluation verdict for a cell by its index. Returns
 * undefined when the cell has no entry (or no markers exist) — callers must
 * NOT fall back to a fabricated marker (never default to "different").
 */
export function verdictForCell(
	markers: readonly PreEvalCellVerdict[] | null | undefined,
	cellIndex: number,
): PreEvalCellVerdict | undefined {
	return markers?.find((m) => m.cellIndex === cellIndex);
}
