/**
 * @file Rune-based autofix store.
 *
 * Per-submission, per-cell fix-suggestion state:
 *
 *   - suggest()     — POST /api/submissions/[id]/autofix (KI Connect via
 *                     the executor); stores the suggestion for the cell
 *   - verify()      — POST /api/submissions/[id]/autofix/verify; verifies a
 *                     suggested patch against the WHOLE notebook (never a
 *                     single-cell re-run — that loses kernel state built
 *                     by earlier cells); stores the verified result
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
	verifyAutofix as verifyAutofixApi,
	saveGrading,
	type AutofixSuggestion,
	type AutofixVerifyResult,
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
	/** Verified manual-fix results per cell index. */
	verifyResults = $state<SvelteMap<number, AutofixVerifyResult | null>>(new SvelteMap());
	/** Cell indices with an in-flight verify request. */
	verifying = $state<SvelteSet<number>>(new SvelteSet());
	/** Verify request errors per cell index. */
	verifyErrors = $state<SvelteMap<number, string>>(new SvelteMap());

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

	/** Verified manual-fix result for a cell (undefined = not verified yet). */
	verifyResultFor(cellIndex: number): AutofixVerifyResult | null | undefined {
		return this.verifyResults.get(cellIndex);
	}

	/** Whether a verify request is in flight for a cell. */
	isVerifying(cellIndex: number): boolean {
		return this.verifying.has(cellIndex);
	}

	/**
	 * Verify a suggested patch against the WHOLE notebook (the route builds
	 * the context from the stored execution result). Never a single-cell
	 * re-run — that loses kernel state built by earlier cells. Stores the
	 * result and any error; never throws.
	 */
	async verify(
		submissionId: string,
		assignmentId: string,
		cellIndex: number,
		patchedSource: string,
	): Promise<AutofixVerifyResult | null> {
		this.verifying.add(cellIndex);
		this.verifyErrors.delete(cellIndex);
		try {
			const result = await verifyAutofixApi(
				submissionId,
				{ cellIndex, patchedSource },
				assignmentId,
			);
			this.verifyResults.set(cellIndex, result);
			return result;
		} catch (err) {
			this.verifyErrors.set(
				cellIndex,
				err instanceof Error ? err.message : "Failed to verify the fix",
			);
			return null;
		} finally {
			this.verifying.delete(cellIndex);
		}
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
		this.verifyResults = new SvelteMap();
		this.verifying = new SvelteSet();
		this.verifyErrors = new SvelteMap();
	}
}

/** Singleton store shared by all autofix cards on the page. */
export const autofixStore = new AutofixStore();
