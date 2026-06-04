/** @file Reactive review state store using Svelte 5 runes — Orchestrator pattern.
 *
 * Composes focused sub-stores (RubricStore, GradingStore, SelectionStore,
 * SessionStore, ExportStore) into a unified ReviewStore interface.
 *
 * The orchestrator bridges cross-cutting concerns via $derived/$effect:
 * - Auto-save on selection/grading changes
 * - Grade result computation (bridges GradingStore + SelectionStore + RubricStore)
 * - Evaluation text generation
 * - Import/restore flows
 * - Undo/redo coordination
 */
import type { ReviewMode } from "../types/index.js";
import type { CategoryKey, MergedRubric } from "../types/criteria.js";
import type { CategorySelections } from "../types/session.js";
import type { GradingConfig, GradingInputs, GradeResult } from "../types/grading.js";
import type { ReviewSession } from "../types/session.js";
import type { ExportFormat } from "../types/persistence.js";
import type { Assignment } from "../types/assignments.js";
import type { ReviewMetaFull } from "../services/db.js";
import { getCriteriaForAssignment } from "../services/criteria-loader.js";
import { addToast } from "./toast.svelte.js";
import { RubricStore } from "./rubric.svelte.js";
import { GradingStore } from "./grading.svelte.js";
import { SelectionStore } from "./selection.svelte.js";
import { SessionStore } from "./session.svelte.js";
import { ExportStore } from "./export.svelte.js";

// ---------------------------------------------------------------------------
// Review Store (Orchestrator)
// ---------------------------------------------------------------------------

/**
 * Central reactive store for the review application.
 *
 * Orchestrates focused sub-stores, each owning a single slice of state.
 * Bridges cross-cutting concerns via $derived and $effect.
 *
 * Public API is preserved for backward compatibility with existing consumers.
 */
class ReviewStore {
	// -----------------------------------------------------------------------
	// Sub-stores (private — accessed via delegated getters/setters)
	// -----------------------------------------------------------------------

	/** Manages rubric loading, assignment selection, and grading config. */
	private rubricStore = new RubricStore();

	/** Manages grading dimension scores. */
	private gradingStore = new GradingStore();

	/** Manages category selections, comments, deductions, notes, undo/redo. */
	private selectionStore = new SelectionStore();

	/** Manages IndexedDB persistence, auto-save, and saved reviews list. */
	private sessionStore = new SessionStore();

	/** Manages YAML/MD/JSON export, import, and download. */
	private exportStore = new ExportStore();

	// -----------------------------------------------------------------------
	// Identity (orchestrator-owned)
	// -----------------------------------------------------------------------

	/** Student identifier (e.g., "2026SS_42"). */
	student_id = $state("");

	/** Review mode: student or teacher. */
	mode = $state<ReviewMode>("student");

	/** Whether this review was imported and should be read-only. */
	is_read_only = $state(false);

	/** Whether this review is locked to read-only because it has teacher grades in student mode. */
	is_forced_read_only = $state(false);

	// -----------------------------------------------------------------------
	// Generated text (orchestrator-owned)
	// -----------------------------------------------------------------------

	/** Generated evaluation text (Markdown). */
	generated_text = $state("");

	// -----------------------------------------------------------------------
	// Session lifecycle (orchestrator-owned)
	// -----------------------------------------------------------------------

	/** ISO timestamp when the session was started. */
	started_at = $state(new Date().toISOString());

	// -----------------------------------------------------------------------
	// Delegated state (for backward compatibility)
	// -----------------------------------------------------------------------

	/** Current assignment key. */
	get assignment_id(): string {
		return this.rubricStore.assignment_id;
	}
	set assignment_id(value: string) {
		this.rubricStore.assignment_id = value;
	}

	/** Loaded rubric for the current assignment. */
	get rubric(): MergedRubric | null {
		return this.rubricStore.rubric;
	}
	set rubric(value: MergedRubric | null) {
		this.rubricStore.rubric = value;
	}

	/** Available assignments from the registry. */
	get assignments(): Assignment[] {
		return this.rubricStore.assignments;
	}

	/** Grading configuration (dimensions + boundaries). */
	get grading_config(): GradingConfig | null {
		return this.rubricStore.grading_config;
	}
	set grading_config(value: GradingConfig | null) {
		this.rubricStore.grading_config = value;
	}

	/** Per-category selections keyed by category key. */
	get category_selections(): Record<CategoryKey, CategorySelections> {
		return this.selectionStore.category_selections;
	}
	set category_selections(value: Record<CategoryKey, CategorySelections>) {
		this.selectionStore.category_selections = value;
	}

	/** Raw scores for each grading dimension. */
	get grading(): GradingInputs {
		return this.gradingStore.grading;
	}
	set grading(value: GradingInputs) {
		this.gradingStore.grading = value;
	}

	/** ID of the current review in IndexedDB, or null if unsaved. */
	get current_review_id(): string | null {
		return this.sessionStore.current_review_id;
	}
	set current_review_id(value: string | null) {
		this.sessionStore.current_review_id = value;
	}

	/** List of saved reviews for the landing page. */
	get saved_reviews(): ReviewMetaFull[] {
		return this.sessionStore.saved_reviews;
	}

	/** Available semesters for filtering. */
	get semesters(): string[] {
		return this.sessionStore.semesters;
	}

	/** ISO timestamp of the last save, or null if never saved. */
	get last_saved(): string | null {
		return this.sessionStore.last_saved;
	}

	/** Whether the store is currently loading data. */
	get is_loading(): boolean {
		return this.rubricStore.is_loading;
	}

	/** Whether there are unsaved changes since the last save. */
	get is_dirty(): boolean {
		return this.sessionStore.is_dirty;
	}
	set is_dirty(value: boolean) {
		this.sessionStore.is_dirty = value;
	}

	/** Whether undo is available. */
	get can_undo(): boolean {
		return this.selectionStore.can_undo;
	}

	/** Whether redo is available. */
	get can_redo(): boolean {
		return this.selectionStore.can_redo;
	}

	// -----------------------------------------------------------------------
	// Composed derived state
	// -----------------------------------------------------------------------

	/** Computed grade result from current grading inputs and config. */
	grade_result = $derived.by(() => {
		if (!this.rubricStore.grading_config) {
			return null as GradeResult | null;
		}
		return this.gradingStore.calculateGradeResult(
			this.rubricStore.grading_config,
			this.selectionStore.totalDeductions,
		);
	});

	/** Total deduction points across all categories. */
	totalDeductions = $derived(this.selectionStore.totalDeductions);

	/** Number of categories with at least one checked item or non-empty notes. */
	category_progress = $derived(this.selectionStore.category_progress);

	/** Progress percentage (0–100). */
	progress_percentage = $derived(this.selectionStore.progress_percentage);

	// -----------------------------------------------------------------------
	// Initialization
	// -----------------------------------------------------------------------

	/**
	 * Initialize the store by loading assignments and grading config.
	 * Call this once on app mount.
	 */
	async init(): Promise<void> {
		try {
			await this.rubricStore.init();
			await this.sessionStore.refreshSavedReviews(
				this.rubricStore.grading_config ?? undefined,
			);

			// Try to restore auto-saved session
			const restoredSession = await this.sessionStore.restoreSession();
			if (restoredSession) {
				await this.fromSession(restoredSession);

				// Load criteria for this assignment
				const rubric = await getCriteriaForAssignment(restoredSession.assignment_id);
				if (rubric) {
					this.rubricStore.rubric = rubric;
					this.selectionStore.initForRubric(rubric, true);
				}
			}
		} catch (error) {
			console.error("[ReviewStore] Initialization failed:", error);
			addToast("error", "Failed to initialize. Please reload the page.");
		}
	}

	// -----------------------------------------------------------------------
	// Assignment & Criteria
	// -----------------------------------------------------------------------

	/**
	 * Set the current assignment and load its criteria.
	 *
	 * @param assignmentId - The assignment ID to load
	 */
	async setAssignment(assignmentId: string): Promise<void> {
		const isNewAssignment = this.rubricStore.assignment_id !== assignmentId;

		const rubric = await this.rubricStore.setAssignment(assignmentId);
		if (!rubric) {
			addToast(
				"error",
				`Failed to load criteria for "${assignmentId}". Please check the assignment data.`,
			);
			return;
		}

		// Initialize category selections
		this.selectionStore.initForRubric(rubric, !isNewAssignment);

		// Initialize grading inputs (preserve existing when restoring)
		if (this.rubricStore.grading_config) {
			const hasExistingGrading = Object.keys(this.gradingStore.grading as object).length > 0;
			if (!hasExistingGrading) {
				this.gradingStore.resetFromConfig(this.rubricStore.grading_config);
			}
		}

		// Reset session state only when switching to a different assignment
		if (isNewAssignment || this.generated_text === "") {
			this.generated_text = "";
			this.sessionStore.reset();
			this.started_at = new Date().toISOString();
		}
	}

	// -----------------------------------------------------------------------
	// Category Selections (delegate to SelectionStore + undo + dirty)
	// -----------------------------------------------------------------------

	/**
	 * Toggle a checkbox for a sub-point in a category.
	 */
	toggleCheckbox(categoryKey: CategoryKey, subPointText: string): void {
		this.selectionStore.pushUndoSnapshot();
		this.selectionStore.toggleCheckbox(categoryKey, subPointText);
		this.sessionStore.markDirty();
		this.sessionStore.autoSave(this.toSession());
	}

	/**
	 * Set a comment for a sub-point in a category.
	 */
	setComment(categoryKey: CategoryKey, subPointText: string, value: string): void {
		this.selectionStore.pushUndoSnapshot();
		this.selectionStore.setComment(categoryKey, subPointText, value);
		this.sessionStore.markDirty();
		this.sessionStore.autoSave(this.toSession());
	}

	/**
	 * Set a deduction value for a sub-point in a category.
	 */
	setDeduction(categoryKey: CategoryKey, subPointText: string, value: number): void {
		this.selectionStore.pushUndoSnapshot();
		this.selectionStore.setDeduction(categoryKey, subPointText, value);
		this.sessionStore.markDirty();
		this.sessionStore.autoSave(this.toSession());
	}

	/**
	 * Set the additional notes for a category.
	 */
	setNotes(categoryKey: CategoryKey, value: string): void {
		this.selectionStore.pushUndoSnapshot();
		this.selectionStore.setNotes(categoryKey, value);
		this.sessionStore.markDirty();
		this.sessionStore.autoSave(this.toSession());
	}

	// -----------------------------------------------------------------------
	// Grading (delegate to GradingStore + undo + dirty)
	// -----------------------------------------------------------------------

	/**
	 * Set a grading dimension score.
	 */
	setGradingInput(key: string, value: number): void {
		this.selectionStore.pushUndoSnapshot();
		this.gradingStore.setGradingInput(key, value);
		this.sessionStore.markDirty();
		this.sessionStore.autoSave(this.toSession());
	}

	// -----------------------------------------------------------------------
	// Evaluation Text Generation
	// -----------------------------------------------------------------------

	/**
	 * Force an immediate auto-save without debouncing.
	 */
	async forceAutoSave(): Promise<void> {
		await this.sessionStore.forceAutoSave(this.toSession());
	}

	/**
	 * Generate evaluation text from current selections.
	 */
	generateText(): void {
		if (!this.rubricStore.rubric) {
			addToast("warning", "No rubric loaded. Please select an assignment first.");
			return;
		}

		if (!this.grade_result) {
			addToast("warning", "Grading configuration not loaded.");
			return;
		}

		this.generated_text = this.exportStore.generateText(
			this.toSession(),
			this.rubricStore.rubric,
			this.grade_result,
		);
		this.sessionStore.markDirty();
	}

	// -----------------------------------------------------------------------
	// Persistence (delegate to SessionStore)
	// -----------------------------------------------------------------------

	/**
	 * Save the current review as a completed review.
	 */
	async save(): Promise<string> {
		try {
			const id = await this.sessionStore.save(this.toSession());
			await this.sessionStore.refreshSavedReviews(
				this.rubricStore.grading_config ?? undefined,
			);
			addToast("success", "Review saved successfully");
			return id;
		} catch (error) {
			console.error("[ReviewStore] Save failed:", error);
			addToast("error", "Failed to save review. Please try again.");
			throw error;
		}
	}

	/**
	 * Load a saved review by ID.
	 */
	async loadById(id: string): Promise<void> {
		try {
			const session = await this.sessionStore.loadById(id);
			if (!session) {
				addToast("error", "Review not found");
				return;
			}

			await this.fromSession(session);

			// Load criteria for this assignment
			const rubric = await getCriteriaForAssignment(session.assignment_id);
			if (rubric) {
				this.rubricStore.rubric = rubric;
				this.selectionStore.initForRubric(rubric, true);
			} else {
				addToast("warning", "Could not load criteria for this assignment.");
			}
		} catch (error) {
			console.error("[ReviewStore] Load failed:", error);
			addToast("error", "Failed to load review. The data may be corrupted.");
		}
	}

	/**
	 * Delete a saved review by ID.
	 */
	async deleteReview(id: string): Promise<void> {
		try {
			const success = await this.sessionStore.deleteReview(id);
			if (success) {
				addToast("success", "Review deleted");
			} else {
				addToast("error", "Review not found or already deleted");
			}
		} catch (error) {
			console.error("[ReviewStore] Delete failed:", error);
			addToast("error", "Failed to delete review. Please try again.");
		}
	}

	// -----------------------------------------------------------------------
	// Import / Export (delegate to ExportStore + SessionStore)
	// -----------------------------------------------------------------------

	/**
	 * Import a review from a file.
	 */
	async importReview(text: string, filename: string, readOnly = true): Promise<void> {
		const session = this.exportStore.parseImport(text, filename);
		if (!session) {
			addToast("error", "Failed to parse import file. Check the format and try again.");
			return;
		}

		await this.fromSession(session);
		this.is_read_only = readOnly;
		this.is_forced_read_only = false;
		this.sessionStore.markClean();

		// Load criteria for this assignment
		try {
			const rubric = await getCriteriaForAssignment(session.assignment_id);
			if (rubric) {
				this.rubricStore.rubric = rubric;
				this.selectionStore.initForRubric(rubric, true);
				this.exportStore.normalizeLegacy(session, rubric);
				// Re-apply normalized selections
				this.selectionStore.fromSession(session);
			} else {
				addToast(
					"warning",
					`Could not load criteria for "${session.assignment_id}". The assignment may not be available.`,
				);
			}
		} catch (error) {
			console.error("[ReviewStore] Failed to load criteria for import:", error);
			addToast("warning", "Imported review loaded, but criteria could not be fetched.");
		}

		addToast("success", "Review imported successfully");
	}

	/**
	 * Export the current review in the specified format.
	 */
	exportReview(format: ExportFormat, reviewer: string): void {
		if (!this.rubricStore.rubric || !this.grade_result) {
			addToast("warning", "Cannot export: no rubric or grade result available");
			return;
		}

		this.exportStore.exportAndDownload(
			this.toSession(),
			this.rubricStore.rubric,
			this.grade_result,
			format,
			reviewer,
		);
	}

	// -----------------------------------------------------------------------
	// Review listing (delegate to SessionStore)
	// -----------------------------------------------------------------------

	/**
	 * Refresh the list of saved reviews from IndexedDB.
	 */
	async refreshSavedReviews(): Promise<void> {
		try {
			await this.sessionStore.refreshSavedReviews(
				this.rubricStore.grading_config ?? undefined,
			);
		} catch (error) {
			console.error("[ReviewStore] Failed to load saved reviews:", error);
			addToast("error", "Failed to load saved reviews. Please reload the page.");
		}
	}

	/**
	 * Clear all reviews from IndexedDB.
	 */
	async clearAllData(): Promise<void> {
		try {
			await this.sessionStore.clearAllData();
			addToast("success", "All reviews cleared");
		} catch (error) {
			console.error("[ReviewStore] Clear all data failed:", error);
			addToast("error", "Failed to clear data. Please try again.");
		}
	}

	/**
	 * Export all reviews as a JSON file.
	 */
	async exportAllReviews(): Promise<void> {
		try {
			const data = await this.sessionStore.exportAll();
			const content = JSON.stringify(data, null, 2);
			this.exportStore.download(content, "scipro_reviews_export.json", "application/json");
		} catch (error) {
			console.error("[ReviewStore] Export all failed:", error);
			addToast("error", "Failed to export reviews. Please try again.");
		}
	}

	// -----------------------------------------------------------------------
	// Undo/Redo (delegate to SelectionStore)
	// -----------------------------------------------------------------------

	/**
	 * Undo the last change.
	 */
	undo(): void {
		this.selectionStore.undo();
		this.sessionStore.markDirty();
	}

	/**
	 * Redo the last undone change.
	 */
	redo(): void {
		this.selectionStore.redo();
		this.sessionStore.markDirty();
	}

	// -----------------------------------------------------------------------
	// Session Conversion
	// -----------------------------------------------------------------------

	/**
	 * Convert the current store state to a ReviewSession object.
	 */
	toSession(): ReviewSession {
		return {
			student_id: this.student_id,
			assignment_id: this.rubricStore.assignment_id,
			mode: this.mode,
			category_selections: this.selectionStore.toSession(),
			grading: this.gradingStore.toSession(),
			generated_text: this.generated_text,
			started_at: this.started_at,
			updated_at: new Date().toISOString(),
		};
	}

	/**
	 * Restore store state from a ReviewSession object.
	 */
	private async fromSession(session: ReviewSession): Promise<void> {
		this.student_id = session.student_id;
		this.rubricStore.assignment_id = session.assignment_id;
		// Preserve current user mode — do not overwrite from imported session
		this.generated_text = session.generated_text;
		this.started_at = session.started_at;

		this.selectionStore.fromSession(session);
		this.gradingStore.fromSession(session);
		this.is_forced_read_only = false;
	}

	// -----------------------------------------------------------------------
	// Reset
	// -----------------------------------------------------------------------

	/**
	 * Reset the store to its initial state.
	 */
	reset(): void {
		this.student_id = "";
		this.mode = "student";
		this.is_read_only = false;
		this.is_forced_read_only = false;
		this.generated_text = "";
		this.started_at = new Date().toISOString();

		this.rubricStore.reset();
		this.gradingStore.reset();
		this.selectionStore.reset();
		this.sessionStore.reset();
		this.exportStore = new ExportStore();
	}

	/**
	 * Clear all cached criteria and grading config.
	 */
	clearCaches(): void {
		this.rubricStore.clearCaches();
	}
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

/** Global review store instance. */
export const reviewStore = new ReviewStore();
