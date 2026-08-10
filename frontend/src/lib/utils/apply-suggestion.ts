/**
 * @file Pure apply helper for copilot suggestions (Phase 4e).
 *
 * Converts a `CopilotSuggestion` payload into page state changes WITHOUT
 * touching any Svelte/store machinery — the page calls this and assigns the
 * result. Two kinds mutate page state:
 *
 *   - `grade`  → `data` is the full PreEvaluation envelope (see
 *     `PreEvalData` in `$lib/types/submissions.ts`): suggested dimension
 *     scores are merged into `gradingInputs` (clamped to sane bounds),
 *     `feedbackDraft` fills `notesDraft` ONLY when the teacher has not
 *     written anything yet (never clobber teacher-written notes), and
 *     `rubricSelections` (when the envelope carries them) are merged into
 *     `categorySelections` as checked sub-points.
 *   - `draft`  → `data.notes` fills `notesDraft`, again only when empty.
 *
 * Any other kind (`fix`, `export`, …) leaves the state untouched — the page
 * must not toast "applied" for a suggestion that changed nothing.
 *
 * Imports stay minimal (SvelteSet only, for fresh reactive category
 * selections) — the module remains importable from tests without any Svelte
 * component environment.
 */

import type { CopilotSuggestion } from "$lib/components/submissions/copilot-store.svelte.js";
import type { CategorySelections } from "$lib/types/session.js";
import { SvelteSet } from "svelte/reactivity";

/** Page state slice the helper mutates (mirrors the submission page). */
export interface ApplySuggestionState<T extends Record<string, number> = Record<string, number>> {
	/** Dimension id -> score (see `GradingInputs`). */
	gradingInputs: T;
	/** Top-level teacher notes draft. */
	notesDraft: string;
	/**
	 * Rubric category selections keyed by category key (page-owned).
	 * Merged when the suggestion carries `rubricSelections`; optional so
	 * callers that do not track rubric state keep working unchanged.
	 */
	categorySelections?: Record<string, CategorySelections>;
}

/** Sane bounds for suggested dimension scores (raw points, pre-weighting). */
const MIN_SCORE = 0;
const MAX_SCORE = 1000;

/** Clamp a suggested score into bounds; NaN/Infinity are rejected by the caller. */
function clampScore(value: number): number {
	return Math.min(MAX_SCORE, Math.max(MIN_SCORE, value));
}

/** One rubric item a suggestion wants checked: category key + sub-point text. */
interface RubricSelectionItem {
	categoryKey: string;
	optionKey: string;
}

/** Fresh empty per-category selection state (same shape as the page's reset). */
function emptyCategorySelections(): CategorySelections {
	return {
		checked_items: new SvelteSet<string>(),
		notes: "",
		comments: {},
		deductions: {},
	};
}

/**
 * Merge `rubricSelections` into a NEW selections record. Categories named by
 * the suggestion that do not exist yet are created; `optionKey` values (the
 * sub-point texts the rubric checkbox model keys on) are added to
 * `checked_items`. Immutable: the input record and its sets are never
 * mutated. Returns the ORIGINAL reference when nothing changed, and
 * `undefined` when there is nothing to merge and the caller had no record.
 */
function mergeRubricSelections(
	selections: Record<string, CategorySelections> | undefined,
	items: RubricSelectionItem[] | undefined,
): Record<string, CategorySelections> | undefined {
	if (!items || items.length === 0) return selections;

	let changed = false;
	const next: Record<string, CategorySelections> = {};
	for (const [key, sel] of Object.entries(selections ?? {})) {
		next[key] = { ...sel, checked_items: new SvelteSet(sel.checked_items) };
	}
	for (const item of items) {
		if (
			!item ||
			typeof item.categoryKey !== "string" ||
			typeof item.optionKey !== "string" ||
			item.categoryKey.length === 0 ||
			item.optionKey.length === 0
		) {
			continue;
		}
		const existing = next[item.categoryKey] ?? emptyCategorySelections();
		if (!existing.checked_items.has(item.optionKey)) {
			existing.checked_items.add(item.optionKey);
			changed = true;
		}
		next[item.categoryKey] = existing;
	}
	return changed ? next : selections;
}

/**
 * Merge `additionalNotes` into a NEW selections record, filling ONLY empty
 * per-category notes (the rubric-category editor renders these as the
 * category's teacher notes). Teacher-written notes are never overwritten
 * and blank entries are skipped. Immutable: the input record and its sets
 * are never mutated. Returns the ORIGINAL reference when nothing changed,
 * and `undefined` when there is nothing to merge and the caller had no
 * record.
 */
function mergeAdditionalNotes(
	selections: Record<string, CategorySelections> | undefined,
	notesData: Record<string, string> | undefined,
): Record<string, CategorySelections> | undefined {
	if (!notesData || Object.keys(notesData).length === 0) return selections;

	let changed = false;
	const next: Record<string, CategorySelections> = {};
	for (const [key, sel] of Object.entries(selections ?? {})) {
		next[key] = { ...sel, checked_items: new SvelteSet(sel.checked_items) };
	}
	for (const [catKey, note] of Object.entries(notesData)) {
		if (!note || note.trim().length === 0) continue;
		const existing = next[catKey] ?? emptyCategorySelections();
		if ((existing.notes ?? "").trim().length === 0) {
			next[catKey] = { ...existing, notes: note };
			changed = true;
		}
	}
	return changed ? next : selections;
}

/** `data` payload of a `grade` suggestion — subset of `PreEvalData`. */
interface GradeSuggestionData {
	gradeSuggestion?: {
		dimensions?: Record<string, number>;
		justification?: string;
	};
	feedbackDraft?: string;
	/** Optional rubric items to check alongside the score suggestions. */
	rubricSelections?: RubricSelectionItem[];
	/** Per-category notes to fill into empty category selections. */
	additionalNotes?: Record<string, string>;
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

		// Merge rubric selections (sub-points to check) and per-category
		// additional notes into the selections record, if the suggestion
		// carries any. Notes fill ONLY empty teacher notes — never clobber.
		// Callers without a record and suggestions without data leave the
		// state untouched.
		const categorySelections = mergeAdditionalNotes(
			mergeRubricSelections(state.categorySelections, data.rubricSelections),
			data.additionalNotes,
		);

		return {
			gradingInputs: gradingInputs as T,
			notesDraft,
			...(categorySelections !== undefined ? { categorySelections } : {}),
		};
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
