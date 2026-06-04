/** @file Rubric sub-store — manages rubric loading, assignment selection, and grading config. */
import type { MergedRubric } from "../types/criteria.js";
import type { GradingConfig } from "../types/grading.js";
import type { Assignment } from "../types/assignments.js";
import {
	getCriteriaForAssignment,
	loadAssignments,
	clearCache as clearCriteriaCache,
} from "../services/criteria-loader.js";
import { loadGradingConfig, clearGradingConfigCache } from "../services/grading-config.js";
import { defaultGradingInputsFromConfig } from "../services/grade-calculator.js";
import type { GradingInputs } from "../types/grading.js";

/**
 * Manages rubric loading, assignment selection, and grading configuration.
 *
 * This store is responsible for:
 * - Loading and caching assignments from the registry
 * - Loading and caching grading configuration
 * - Loading criteria/rubrics for specific assignments
 * - Tracking the current assignment ID
 */
export class RubricStore {
	// -----------------------------------------------------------------------
	// State
	// -----------------------------------------------------------------------

	/** Current assignment key (e.g., "atom_interaction"). */
	assignment_id = $state("");

	/** Loaded rubric for the current assignment. */
	rubric = $state<MergedRubric | null>(null);

	/** Available assignments from the registry. */
	assignments = $state<Assignment[]>([]);

	/** Grading configuration (dimensions + boundaries). */
	grading_config = $state<GradingConfig | null>(null);

	/** Whether the store is currently loading data. */
	is_loading = $state(false);

	// -----------------------------------------------------------------------
	// Initialization
	// -----------------------------------------------------------------------

	/**
	 * Initialize by loading assignments and grading config.
	 * Call this once on app mount.
	 */
	async init(): Promise<void> {
		this.is_loading = true;
		try {
			const [registry, config] = await Promise.all([loadAssignments(), loadGradingConfig()]);

			if (registry) {
				this.assignments = registry.assignments.filter((a) => a.enabled);
			}

			if (config) {
				this.grading_config = config;
			}
		} catch (error) {
			console.error("[RubricStore] Initialization failed:", error);
			throw error;
		} finally {
			this.is_loading = false;
		}
	}

	// -----------------------------------------------------------------------
	// Assignment & Criteria
	// -----------------------------------------------------------------------

	/**
	 * Set the current assignment and load its criteria.
	 *
	 * @param assignmentId - The assignment ID to load
	 * @returns The loaded rubric, or null if loading failed
	 */
	async setAssignment(assignmentId: string): Promise<MergedRubric | null> {
		this.assignment_id = assignmentId;

		const rubric = await getCriteriaForAssignment(assignmentId);
		if (!rubric) {
			console.error(`[RubricStore] Failed to load criteria for "${assignmentId}"`);
			return null;
		}

		this.rubric = rubric;
		return rubric;
	}

	/**
	 * Create default grading inputs from the current grading config.
	 *
	 * @returns Default grading inputs, or empty object if no config loaded
	 */
	createDefaultGradingInputs(): GradingInputs {
		if (!this.grading_config) {
			return {} as unknown as GradingInputs;
		}
		return defaultGradingInputsFromConfig(this.grading_config);
	}

	// -----------------------------------------------------------------------
	// Cache management
	// -----------------------------------------------------------------------

	/** Clear all cached criteria and grading config. */
	clearCaches(): void {
		clearCriteriaCache();
		clearGradingConfigCache();
	}

	/** Reset to initial state. */
	reset(): void {
		this.assignment_id = "";
		this.rubric = null;
		this.assignments = [];
		this.grading_config = null;
		this.is_loading = false;
	}
}
