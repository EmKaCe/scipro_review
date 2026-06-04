/** @file Selection sub-store — manages category selections, comments, deductions, notes, and undo/redo. */
import { SvelteSet } from "svelte/reactivity";
import type { CategoryKey, MergedRubric } from "../types/criteria.js";
import type { CategorySelections, ReviewSession } from "../types/session.js";

// ---------------------------------------------------------------------------
// Undo/Redo
// ---------------------------------------------------------------------------

/** Maximum number of undo snapshots to keep. */
const MAX_UNDO_STACK = 50;

/**
 * Snapshot of selection state for undo/redo.
 */
interface UndoSnapshot {
	category_selections_json: string;
}

/**
 * Manages per-category selections (checkboxes, comments, deductions, notes)
 * and undo/redo functionality.
 *
 * This store is responsible for:
 * - Tracking checked items per category
 * - Tracking inline comments and deductions per sub-point
 * - Tracking additional notes per category
 * - Undo/redo for selection changes
 * - Computing total deductions and category progress
 */
export class SelectionStore {
	// -----------------------------------------------------------------------
	// State
	// -----------------------------------------------------------------------

	/** Per-category selections keyed by category key. */
	category_selections = $state<Record<CategoryKey, CategorySelections>>(
		{} as Record<CategoryKey, CategorySelections>,
	);

	// -----------------------------------------------------------------------
	// Undo/Redo
	// -----------------------------------------------------------------------

	/** Stack of undo snapshots. */
	private undo_stack: UndoSnapshot[] = [];

	/** Stack of redo snapshots. */
	private redo_stack: UndoSnapshot[] = [];

	/** Whether undo is available. */
	can_undo = $derived(this.undo_stack.length > 0);

	/** Whether redo is available. */
	can_redo = $derived(this.redo_stack.length > 0);

	// -----------------------------------------------------------------------
	// Derived
	// -----------------------------------------------------------------------

	/** Total deduction points across all categories. */
	totalDeductions = $derived.by(() => {
		let total = 0;
		for (const sel of Object.values(this.category_selections)) {
			for (const value of Object.values(sel.deductions) as number[]) {
				total += value;
			}
		}
		return total;
	});

	/** Number of categories with at least one checked item or non-empty notes. */
	category_progress = $derived.by(() => {
		const entries = Object.entries(this.category_selections);
		if (entries.length === 0) return { filled: 0, total: 0 };

		let filled = 0;
		for (const [, sel] of entries) {
			const hasChecked = sel.checked_items.size > 0;
			const hasNotes = sel.notes.trim().length > 0;
			if (hasChecked || hasNotes) {
				filled++;
			}
		}
		return { filled, total: entries.length };
	});

	/** Progress percentage (0–100). */
	progress_percentage = $derived.by(() => {
		const { filled, total } = this.category_progress;
		if (total === 0) return 0;
		return Math.round((filled / total) * 100);
	});

	// -----------------------------------------------------------------------
	// Initialization
	// -----------------------------------------------------------------------

	/**
	 * Initialize category selections for all categories in the rubric.
	 * Preserves existing selections when restoring a session.
	 *
	 * @param rubric - The merged rubric
	 * @param preserveExisting - Whether to preserve existing selections
	 */
	initForRubric(rubric: MergedRubric, preserveExisting = false): void {
		const selections: Record<string, CategorySelections> = {};

		for (const entry of rubric.categories) {
			const existing = this.category_selections[entry.key];
			if (existing && preserveExisting) {
				selections[entry.key] = existing;
			} else {
				selections[entry.key] = {
					checked_items: new SvelteSet<string>(),
					notes: "",
					comments: {},
					deductions: {},
				};
			}
		}

		this.category_selections = selections as Record<CategoryKey, CategorySelections>;
	}

	// -----------------------------------------------------------------------
	// Category Selections
	// -----------------------------------------------------------------------

	/**
	 * Toggle a checkbox for a sub-point in a category.
	 *
	 * @param categoryKey - The category key
	 * @param subPointText - The sub-point text to toggle
	 */
	toggleCheckbox(categoryKey: CategoryKey, subPointText: string): void {
		const sel = this.category_selections[categoryKey];
		if (!sel) return;

		if (sel.checked_items.has(subPointText)) {
			sel.checked_items.delete(subPointText);
		} else {
			sel.checked_items.add(subPointText);
		}
	}

	/**
	 * Set a comment for a sub-point in a category.
	 *
	 * @param categoryKey - The category key
	 * @param subPointText - The sub-point text
	 * @param value - The comment text
	 */
	setComment(categoryKey: CategoryKey, subPointText: string, value: string): void {
		const sel = this.category_selections[categoryKey];
		if (!sel) return;

		if (value.trim()) {
			sel.comments[subPointText] = value;
		} else {
			delete sel.comments[subPointText];
		}
	}

	/**
	 * Set a deduction value for a sub-point in a category.
	 *
	 * @param categoryKey - The category key
	 * @param subPointText - The sub-point text
	 * @param value - The deduction amount
	 */
	setDeduction(categoryKey: CategoryKey, subPointText: string, value: number): void {
		const sel = this.category_selections[categoryKey];
		if (!sel) return;

		if (value > 0) {
			sel.deductions[subPointText] = value;
		} else {
			delete sel.deductions[subPointText];
		}
	}

	/**
	 * Set the additional notes for a category.
	 *
	 * @param categoryKey - The category key
	 * @param value - The notes text
	 */
	setNotes(categoryKey: CategoryKey, value: string): void {
		const sel = this.category_selections[categoryKey];
		if (!sel) return;

		sel.notes = value;
	}

	// -----------------------------------------------------------------------
	// Undo/Redo
	// -----------------------------------------------------------------------

	/**
	 * Undo the last change.
	 */
	undo(): void {
		if (this.undo_stack.length === 0) return;

		// Push current state to redo stack
		this.redo_stack.push(this.captureSnapshot());

		// Pop and restore from undo stack
		const snapshot = this.undo_stack.pop()!;
		this.restoreSnapshot(snapshot);
	}

	/**
	 * Redo the last undone change.
	 */
	redo(): void {
		if (this.redo_stack.length === 0) return;

		// Push current state to undo stack
		this.undo_stack.push(this.captureSnapshot());

		// Pop and restore from redo stack
		const snapshot = this.redo_stack.pop()!;
		this.restoreSnapshot(snapshot);
	}

	/**
	 * Push a snapshot onto the undo stack before a change.
	 */
	pushUndoSnapshot(): void {
		this.undo_stack.push(this.captureSnapshot());

		// Trim stack if it exceeds max size
		if (this.undo_stack.length > MAX_UNDO_STACK) {
			this.undo_stack.shift();
		}

		// Clear redo stack on new action
		this.redo_stack = [];
	}

	/**
	 * Capture a snapshot of the current selection state.
	 */
	private captureSnapshot(): UndoSnapshot {
		return {
			category_selections_json: JSON.stringify(this.category_selections, (_key, val) => {
				if (val instanceof Set) return [...val];
				return val;
			}),
		};
	}

	/**
	 * Restore selection state from a snapshot.
	 */
	private restoreSnapshot(snapshot: UndoSnapshot): void {
		const selectionsData = JSON.parse(snapshot.category_selections_json) as Record<
			string,
			Record<string, unknown>
		>;

		const selections: Record<string, CategorySelections> = {};
		for (const [key, sel] of Object.entries(selectionsData)) {
			selections[key] = {
				checked_items: new SvelteSet(
					Array.isArray(sel.checked_items) ? (sel.checked_items as string[]) : [],
				),
				notes: (sel.notes as string) ?? "",
				comments: (sel.comments as Record<string, string>) ?? {},
				deductions: (sel.deductions as Record<string, number>) ?? {},
			};
		}

		this.category_selections = selections as Record<CategoryKey, CategorySelections>;
	}

	// -----------------------------------------------------------------------
	// Session conversion
	// -----------------------------------------------------------------------

	/**
	 * Restore selection state from a ReviewSession.
	 */
	fromSession(session: ReviewSession): void {
		const selections: Record<string, CategorySelections> = {};
		for (const [key, sel] of Object.entries(session.category_selections)) {
			selections[key] = {
				checked_items: new SvelteSet(
					sel.checked_items instanceof Set ? [...sel.checked_items] : [],
				),
				notes: sel.notes ?? "",
				comments: { ...sel.comments },
				deductions: { ...sel.deductions },
			};
		}
		this.category_selections = selections as Record<CategoryKey, CategorySelections>;
	}

	/**
	 * Convert selection state for a ReviewSession.
	 * Deep-clones, converting SvelteSet to Set for serialization.
	 */
	toSession(): Record<CategoryKey, CategorySelections> {
		const selections: Record<string, CategorySelections> = {};
		for (const [key, sel] of Object.entries(this.category_selections)) {
			selections[key] = {
				// eslint-disable-next-line svelte/prefer-svelte-reactivity
				checked_items: new Set(sel.checked_items),
				notes: sel.notes,
				comments: { ...sel.comments },
				deductions: { ...sel.deductions },
			};
		}
		return selections as Record<CategoryKey, CategorySelections>;
	}

	// -----------------------------------------------------------------------
	// Reset
	// -----------------------------------------------------------------------

	/**
	 * Reset to empty state.
	 */
	reset(): void {
		this.category_selections = {} as Record<CategoryKey, CategorySelections>;
		this.undo_stack = [];
		this.redo_stack = [];
	}
}
