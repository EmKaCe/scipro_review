/** @file Session sub-store — manages IndexedDB persistence, auto-save, and saved reviews list. */
import { SvelteDate } from "svelte/reactivity";
import type { ReviewSession } from "../types/session.js";
import type { GradingConfig } from "../types/grading.js";
import type { ReviewMetaFull } from "../services/db.js";
import {
	saveCurrentSession,
	loadCurrentSession,
	clearCurrentSession,
	saveReview,
	loadReview,
	deleteReview as deleteReviewFromDB,
	listReviews,
	listSemesters,
	exportAll,
	clearAllReviews,
} from "../services/db.js";

/**
 * Manages IndexedDB persistence, auto-save, and saved reviews listing.
 *
 * This store is responsible for:
 * - Auto-saving current session to IndexedDB (debounced)
 * - Loading/saving completed reviews
 * - Managing the list of saved reviews and semesters
 * - Bulk operations (export all, clear all)
 *
 * Note: This store does NOT hold review content state (selections, grading).
 * It only persists and retrieves ReviewSession objects.
 */
export class SessionStore {
	// -----------------------------------------------------------------------
	// State
	// -----------------------------------------------------------------------

	/** ID of the current review in IndexedDB, or null if unsaved. */
	current_review_id = $state<string | null>(null);

	/** List of saved reviews for the landing page. */
	saved_reviews = $state<ReviewMetaFull[]>([]);

	/** Available semesters for filtering. */
	semesters = $state<string[]>([]);

	/** ISO timestamp of the last save, or null if never saved. */
	last_saved = $state<string | null>(null);

	/** Whether there are unsaved changes since the last save. */
	is_dirty = $state(false);

	// -----------------------------------------------------------------------
	// Auto-save
	// -----------------------------------------------------------------------

	/** Timer ID for debounced auto-save. */
	private autoSaveTimer: ReturnType<typeof setTimeout> | null = null;

	/** Debounce delay in milliseconds. */
	private autoSaveDelay = 500;

	/**
	 * Trigger a debounced auto-save of the given session.
	 *
	 * @param session - The review session to auto-save
	 */
	autoSave(session: ReviewSession): void {
		if (this.autoSaveTimer) {
			clearTimeout(this.autoSaveTimer);
		}

		this.autoSaveTimer = setTimeout(async () => {
			try {
				await saveCurrentSession(session);
			} catch (error) {
				console.error("[SessionStore] Auto-save failed:", error);
			}
		}, this.autoSaveDelay);
	}

	/**
	 * Force an immediate auto-save without debouncing.
	 *
	 * @param session - The review session to auto-save
	 */
	async forceAutoSave(session: ReviewSession): Promise<void> {
		if (this.autoSaveTimer) {
			clearTimeout(this.autoSaveTimer);
			this.autoSaveTimer = null;
		}
		try {
			await saveCurrentSession(session);
		} catch (error) {
			console.error("[SessionStore] Force auto-save failed:", error);
		}
	}

	/**
	 * Mark the store as having unsaved changes.
	 */
	markDirty(): void {
		this.is_dirty = true;
	}

	/**
	 * Mark the store as clean (saved).
	 */
	markClean(): void {
		this.is_dirty = false;
	}

	// -----------------------------------------------------------------------
	// Review CRUD
	// -----------------------------------------------------------------------

	/**
	 * Save a completed review.
	 *
	 * @param session - The review session to save
	 * @returns The ID of the saved review
	 */
	async save(session: ReviewSession): Promise<string> {
		const id = await saveReview(session, this.current_review_id ?? undefined);
		this.current_review_id = id;
		this.last_saved = new SvelteDate().toISOString();
		this.is_dirty = false;
		await clearCurrentSession();
		return id;
	}

	/**
	 * Load a saved review by ID.
	 *
	 * @param id - The review record ID
	 * @returns The loaded session, or null if not found
	 */
	async loadById(id: string): Promise<ReviewSession | null> {
		const session = await loadReview(id);
		if (session) {
			this.current_review_id = id;
			this.is_dirty = false;
		}
		return session;
	}

	/**
	 * Delete a saved review by ID.
	 *
	 * @param id - The review record ID
	 * @returns True if deleted, false if not found
	 */
	async deleteReview(id: string): Promise<boolean> {
		const success = await deleteReviewFromDB(id);
		if (success) {
			await this.refreshSavedReviews();
		}
		return success;
	}

	// -----------------------------------------------------------------------
	// Review listing
	// -----------------------------------------------------------------------

	/**
	 * Refresh the list of saved reviews from IndexedDB.
	 *
	 * @param gradingConfig - Optional grading config for grade computation
	 */
	async refreshSavedReviews(gradingConfig?: GradingConfig): Promise<void> {
		try {
			const [reviews, semesters] = await Promise.all([
				listReviews(undefined, gradingConfig),
				listSemesters(),
			]);
			this.saved_reviews = reviews;
			this.semesters = semesters;
		} catch (error) {
			console.error("[SessionStore] Failed to load saved reviews:", error);
			throw error;
		}
	}

	// -----------------------------------------------------------------------
	// Bulk operations
	// -----------------------------------------------------------------------

	/**
	 * Export all reviews as a bulk export object.
	 */
	async exportAll(): Promise<{ exported_at: string; reviews: unknown[] }> {
		return await exportAll();
	}

	/**
	 * Clear all reviews from IndexedDB.
	 */
	async clearAllData(): Promise<void> {
		await clearAllReviews();
		await this.refreshSavedReviews();
	}

	// -----------------------------------------------------------------------
	// Session restore
	// -----------------------------------------------------------------------

	/**
	 * Restore the auto-saved session from IndexedDB.
	 *
	 * @returns The restored session, or null if none exists
	 */
	async restoreSession(): Promise<ReviewSession | null> {
		try {
			const session = await loadCurrentSession();
			if (session) {
				this.is_dirty = true;
			}
			return session;
		} catch (error) {
			console.error("[SessionStore] Failed to restore session:", error);
			return null;
		}
	}

	// -----------------------------------------------------------------------
	// Reset
	// -----------------------------------------------------------------------

	/**
	 * Reset to initial state.
	 */
	reset(): void {
		this.current_review_id = null;
		this.last_saved = null;
		this.is_dirty = false;
		if (this.autoSaveTimer) {
			clearTimeout(this.autoSaveTimer);
			this.autoSaveTimer = null;
		}
	}
}
