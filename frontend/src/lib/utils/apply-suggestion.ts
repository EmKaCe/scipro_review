/**
 * @file Pure apply helper for copilot suggestions (Phase 4e).
 *
 * Converts a `CopilotSuggestion` payload into page state changes WITHOUT
 * touching any Svelte/store machinery — the page calls this and assigns the
 * result. Two kinds mutate page state:
 *
 *   - `grade`  → `data` is the full PreEvaluation envelope (see
 *     `PreEvalData` in `$lib/types/submissions.ts`): suggested dimension
 *     scores are merged into `gradingInputs` (clamped to sane bounds), and
 *     `feedbackDraft` fills `notesDraft` ONLY when the teacher has not
 *     written anything yet (never clobber teacher-written notes).
 *   - `draft`  → `data.notes` fills `notesDraft`, again only when empty.
 *
 * Any other kind (`fix`, `export`, …) leaves the state untouched — the page
 * must not toast "applied" for a suggestion that changed nothing.
 *
 * Type-only imports only — this module is fully pure and importable from
 * tests without any Svelte environment.
 */

import type { CopilotSuggestion } from "$lib/components/submissions/copilot-store.svelte.js";

/** Page state slice the helper mutates (mirrors the submission page). */
export interface ApplySuggestionState<T extends Record<string, number> = Record<string, number>> {
	/** Dimension id -> score (see `GradingInputs`). */
	gradingInputs: T;
	/** Top-level teacher notes draft. */
	notesDraft: string;
}

/** Sane bounds for suggested dimension scores (raw points, pre-weighting). */
const MIN_SCORE = 0;
const MAX_SCORE = 1000;

/** Clamp a suggested score into bounds; NaN/Infinity are rejected by the caller. */
function clampScore(value: number): number {
	return Math.min(MAX_SCORE, Math.max(MIN_SCORE, value));
}

/** `data` payload of a `grade` suggestion — subset of `PreEvalData`. */
interface GradeSuggestionData {
	gradeSuggestion?: {
		dimensions?: Record<string, number>;
		justification?: string;
	};
	feedbackDraft?: string;
}

/** `data` payload of a `draft` suggestion. */
interface DraftSuggestionData {
	notes?: string;
}

/**
 * Apply a copilot suggestion to page state, returning a NEW state object.
 *
 * @param suggestion The suggestion the teacher clicked "Apply" on.
 * @param state      Current page state (grading inputs + notes draft).
 * @returns A fresh state object for `grade`/`draft` kinds; the ORIGINAL
 *          state reference for unknown kinds (nothing changed).
 */
export function applySuggestionToState<T extends Record<string, number>>(
	suggestion: CopilotSuggestion,
	state: ApplySuggestionState<T>,
): ApplySuggestionState<T> {
	if (suggestion.kind === "grade") {
		const data = (suggestion.data ?? {}) as GradeSuggestionData;
		const dimensions = data.gradeSuggestion?.dimensions ?? {};

		// Merge suggested scores over the existing inputs. Dimensions the
		// suggestion does not mention keep their current value; out-of-range
		// suggestions are clamped; non-finite values are skipped entirely.
		const gradingInputs: Record<string, number> = { ...state.gradingInputs };
		for (const [dimension, value] of Object.entries(dimensions)) {
			if (typeof value !== "number" || !Number.isFinite(value)) continue;
			gradingInputs[dimension] = clampScore(value);
		}

		const notesDraft =
			state.notesDraft.trim() === "" && typeof data.feedbackDraft === "string"
				? data.feedbackDraft
				: state.notesDraft;

		return { gradingInputs: gradingInputs as T, notesDraft };
	}

	if (suggestion.kind === "draft") {
		const data = (suggestion.data ?? {}) as DraftSuggestionData;
		const notesDraft =
			state.notesDraft.trim() === "" && typeof data.notes === "string"
				? data.notes
				: state.notesDraft;

		return { gradingInputs: { ...state.gradingInputs }, notesDraft };
	}

	// fix / export / unknown kinds have no page-state apply path.
	return state;
}
