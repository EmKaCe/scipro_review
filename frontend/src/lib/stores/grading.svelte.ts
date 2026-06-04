/** @file Grading sub-store — manages dimension scores and grade-related state. */
import type { GradingConfig, GradingInputs, GradeResult } from "../types/grading.js";
import { calculateGrade, defaultGradingInputsFromConfig } from "../services/grade-calculator.js";
import type { ReviewSession } from "../types/session.js";

/**
 * Manages grading dimension scores and computed grade results.
 *
 * This store is responsible for:
 * - Tracking raw scores for each grading dimension
 * - Computing grade results (when provided with config and deductions)
 *
 * Note: Grade result computation requires external grading config and deductions,
 * which the orchestrator bridges via $derived.
 */
export class GradingStore {
	// -----------------------------------------------------------------------
	// State
	// -----------------------------------------------------------------------

	/** Raw scores for each grading dimension. */
	grading = $state<GradingInputs>({} as unknown as GradingInputs);

	// -----------------------------------------------------------------------
	// Actions
	// -----------------------------------------------------------------------

	/**
	 * Set a grading dimension score.
	 *
	 * @param key - The dimension key
	 * @param value - The score value
	 */
	setGradingInput(key: string, value: number): void {
		(this.grading as unknown as Record<string, number>)[key] = value;
	}

	/**
	 * Reset grading inputs to defaults from config.
	 *
	 * @param config - The grading configuration
	 */
	resetFromConfig(config: GradingConfig): void {
		this.grading = defaultGradingInputsFromConfig(config);
	}

	/**
	 * Reset to empty state.
	 */
	reset(): void {
		this.grading = {} as unknown as GradingInputs;
	}

	// -----------------------------------------------------------------------
	// Session conversion
	// -----------------------------------------------------------------------

	/**
	 * Restore grading state from a ReviewSession.
	 */
	fromSession(session: ReviewSession): void {
		this.grading = { ...session.grading };
	}

	/**
	 * Extract grading state for a ReviewSession.
	 */
	toSession(): GradingInputs {
		return { ...this.grading } as GradingInputs;
	}

	// -----------------------------------------------------------------------
	// Grade computation (orchestrator bridges config + deductions)
	// -----------------------------------------------------------------------

	/**
	 * Calculate the grade result from current inputs.
	 *
	 * @param config - The grading configuration
	 * @param deductions - Total point deductions
	 * @returns The computed grade result, or null if inputs are empty
	 */
	calculateGradeResult(config: GradingConfig, deductions: number = 0): GradeResult | null {
		if (Object.keys(this.grading as object).length === 0) {
			return null;
		}
		return calculateGrade(this.grading, config, deductions);
	}
}
