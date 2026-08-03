/**
 * @file Rune-based autofix store (Phase 3c.1 / P3-3).
 *
 * Per-submission, per-cell fix-suggestion state:
 *
 *   - suggest()     — POST /api/submissions/[id]/autofix (KI Connect via
 *                     the executor); stores the suggestion for the cell
 *   - saveNote()    — persists the teacher's EDITED note into the
 *                     submission notes (appended with a cell prefix);
 *                     the original suggestion stays in `suggestions` for
 *                     Reset (P3-3: the human writes the final review)
 *
 * State is client-side per session (the executor does not persist
 * suggestions); the saved note survives via the existing grading notes.
 */

import { SvelteMap, SvelteSet } from "svelte/reactivity";

import {
	suggestAutofix as suggestAutofixApi,
	saveGrading,
	type AutofixSuggestion,
} from "./submissions-api.js";

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class AutofixStore {
	/** Fix suggestions per cell index (null entry = suggestion requested). */
	suggestions = $state<SvelteMap<number, AutofixSuggestion | null>>(new SvelteMap());
	/** Teacher-edited note drafts per cell index. */
	notes = $state<SvelteMap<number, string>>(new SvelteMap());
	/** Cell indices whose note was saved to the submission notes. */
	saved = $state<SvelteSet<number>>(new SvelteSet());
	/** Cell indices with an in-flight suggestion request. */
	requesting = $state<SvelteSet<number>>(new SvelteSet());
	/** Request errors per cell index. */
	errors = $state<SvelteMap<number, string>>(new SvelteMap());

	/** Whether a suggestion request is in flight for a cell. */
	isRequesting(cellIndex: number): boolean {
		return this.requesting.has(cellIndex);
	}

	/** Suggestion for a cell (undefined = not requested yet). */
	suggestionFor(cellIndex: number): AutofixSuggestion | null | undefined {
		return this.suggestions.get(cellIndex);
	}

	/**
	 * Ask for a fix suggestion for one failed cell. Stores the result and
	 * any error; never throws.
	 */
	async suggest(
		submissionId: string,
		assignmentId: string,
		cell: { cellIndex: number; cellSource: string; cellError: string; traceback?: string[] },
	): Promise<AutofixSuggestion | null> {
		this.requesting.add(cell.cellIndex);
		this.errors.delete(cell.cellIndex);
		try {
			const suggestion = await suggestAutofixApi(submissionId, cell, assignmentId);
			this.suggestions.set(cell.cellIndex, suggestion);
			return suggestion;
		} catch (err) {
			this.errors.set(
				cell.cellIndex,
				err instanceof Error ? err.message : "Failed to request a fix",
			);
			return null;
		} finally {
			this.requesting.delete(cell.cellIndex);
		}
	}

	/** True when a suggestion exists for the cell (even if skipped). */
	hasSuggestion(cellIndex: number): boolean {
		return this.suggestions.has(cellIndex);
	}

	/**
	 * Persist the teacher's edited note into the submission notes.
	 * Appends a `[Cell N] …` block to the existing notes (merge happens
	 * server-side per field). Returns the updated notes string.
	 */
	async saveNote(
		submissionId: string,
		assignmentId: string,
		cellIndex: number,
		note: string,
		existingNotes?: string,
	): Promise<string> {
		const block = `[Cell ${cellIndex + 1}] ${note.trim()}`;
		const notes =
			existingNotes && existingNotes.trim() !== ""
				? `${existingNotes.trimEnd()}\n${block}`
				: block;
		await saveGrading(submissionId, { notes }, assignmentId);
		this.notes.set(cellIndex, note);
		this.saved.add(cellIndex);
		return notes;
	}

	/** Clear all state (submission switch). */
	reset(): void {
		this.suggestions = new SvelteMap();
		this.notes = new SvelteMap();
		this.saved = new SvelteSet();
		this.requesting = new SvelteSet();
		this.errors = new SvelteMap();
	}
}

/** Singleton store shared by all autofix cards on the page. */
export const autofixStore = new AutofixStore();
