/**
 * @file Over-tick guard (review-diff workflow, signed off 2026-08-18).
 *
 * Compares a submission's pipeline-checked rubric items against the cohort
 * norm (data/cohort_norms/<assignment>.yaml) and produces advisory flags
 * for the teacher:
 *
 *   Signal A — global count flag (coarse): total checked count exceeds
 *     max(cohort_median * 1.5, cohort_median + 10). Catches only
 *     count outliers.
 *   Signal B — per-category flag (the useful one): a category's checked
 *     count exceeds category_median + 3. Catches the systematic padding
 *     pattern (plotting/codeFormatting/userDefinedFunctions over-ticking).
 *   Signal C — overlap warning (informational): when the total is within
 *     ±10 of the cohort median but fewer than 60% of the pipeline's items
 *     appear in the cohort's "typical review" set, the count looks normal
 *     but the selection differs — show a note on the review page.
 *
 * The flag is ADVISORY: it never blocks export (Q3 sign-off). The teacher
 * prunes or keeps; the final authority is the save.
 *
 * The norms file lives under DATA_DIR (like criteria/*.yaml) so the Docker
 * volume copy is what the app reads. Absent norms (assignment without a
 * committed norm, or a fresh clone before the volume sync) degrade to no
 * flags — the guard is a best-effort affordance, never a hard dependency.
 *
 * This module runs only on the SvelteKit server (`$lib/server/`).
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import * as yaml from "js-yaml";

import type { OverTickCategory, OverTickResult } from "$lib/types/submissions";
import type { StoredExecutionResult } from "../results-store";
import { getDataDir } from "../metadata";

// ---------------------------------------------------------------------------
// Types (client-safe shapes live in $lib/types/submissions; re-exported here
// for pipeline consumers, mirroring the GradingConfidence pattern).
// ---------------------------------------------------------------------------

export type { OverTickCategory, OverTickResult } from "$lib/types/submissions";

/** One rubric selection entry as stored on the preEval/postProcessed envelopes. */
export interface RubricSelection {
	categoryKey: string;
	optionKey: string;
}

/** Parsed cohort-norms document (data/cohort_norms/<assignment>.yaml). */
export interface CohortNorms {
	assignment: string;
	submissions: number;
	global: {
		min: number;
		max: number;
		mean: number;
		median: number;
		distribution: number[];
	};
	/** camelCase category name (professor's form) -> median/max counts. */
	categories: Record<string, { median: number; max: number }>;
	/** camelCase category name -> sub-point texts checked in ≥ 50% of the cohort. */
	typical_checked: Record<string, string[]>;
}

// ---------------------------------------------------------------------------
// Category key mapping
// ---------------------------------------------------------------------------

/**
 * Pipeline rubricSelections use the criteria YAML snake_case category keys;
 * the norms YAML is keyed by the professor's form names (camelCase).
 * Categories without a norm entry (e.g. `genai`) are simply never flagged.
 */
const PIPELINE_TO_NORM: Record<string, string> = {
	code_formatting: "codeFormatting",
	coding_concept: "codingConcept",
	jupyter_notebooks: "jupyterNotebooks",
	academic_scholarship: "academicScholarship",
	following_instructions: "followingInstructions",
	general_feedback: "general",
	user_defined_functions: "userDefinedFunctions",
	function_calling: "callingFunction",
	plotting_visualization: "plotting",
	pandas: "Pandas",
	numpy: "NumPy",
	scipy: "SciPy",
	sklearn: "sklearn",
};

/** Signal A threshold: max(median * 1.5, median + 10). */
export function globalFlagThreshold(median: number): number {
	return Math.max(median * 1.5, median + 10);
}

/** Signal B threshold: category_median + 3. */
export function categoryFlagThreshold(median: number): number {
	return median + 3;
}

// ---------------------------------------------------------------------------
// Norm loading
// ---------------------------------------------------------------------------

/** Absolute path of the cohort-norms file for an assignment. */
export function getCohortNormsPath(assignmentId: string): string {
	return path.join(getDataDir(), "cohort_norms", `${assignmentId}.yaml`);
}

/**
 * Load and parse the committed cohort norms for an assignment.
 * Returns null when the file is absent (no norm committed for this
 * assignment) — the guard degrades to no flags. Throws on corrupt YAML so
 * a misconfigured norm surfaces as a 500 rather than silently disabling
 * the guard.
 */
export async function loadCohortNorms(assignmentId: string): Promise<CohortNorms | null> {
	let raw: string;
	try {
		raw = await readFile(getCohortNormsPath(assignmentId), "utf-8");
	} catch (err) {
		if (isNodeError(err) && err.code === "ENOENT") {
			return null;
		}
		throw err;
	}
	const parsed = yaml.load(raw) as Partial<CohortNorms> | null | undefined;
	if (!parsed || typeof parsed !== "object") {
		throw new Error(`cohort norms file ${getCohortNormsPath(assignmentId)} is not valid YAML`);
	}
	return parsed as CohortNorms;
}

// ---------------------------------------------------------------------------
// Flag computation (pure — unit-testable with synthetic norms)
// ---------------------------------------------------------------------------

/**
 * Compute the over-tick flags for one submission's rubric selections.
 *
 * @param selections Pipeline-checked rubric items (categoryKey + optionKey).
 * @param norms      Cohort norms for the assignment.
 */
export function computeOverTick(
	selections: readonly RubricSelection[],
	norms: CohortNorms,
): OverTickResult {
	const counts = new Map<string, { count: number; items: string[] }>();
	for (const sel of selections) {
		const entry = counts.get(sel.categoryKey) ?? { count: 0, items: [] };
		entry.count += 1;
		entry.items.push(sel.optionKey);
		counts.set(sel.categoryKey, entry);
	}

	const total = selections.length;
	const median = norms.global.median;

	// Signal A — global count outlier.
	const totalFlagged = total > globalFlagThreshold(median);

	// Signal B — per-category over-tick.
	const overTickCategories: OverTickCategory[] = [];
	for (const [categoryKey, { count, items }] of counts) {
		const normName = PIPELINE_TO_NORM[categoryKey];
		const norm = normName ? norms.categories[normName] : undefined;
		if (!norm) continue; // no norm for this category — never flagged
		const threshold = categoryFlagThreshold(norm.median);
		if (count > threshold) {
			overTickCategories.push({
				categoryKey,
				count,
				median: norm.median,
				threshold,
				items,
			});
		}
	}
	overTickCategories.sort((a, b) => b.count - a.count);

	// Signal C — overlap warning (informational).
	let overlapNote: string | undefined;
	const withinBand = Math.abs(total - median) <= 10;
	if (withinBand && total > 0) {
		const typical = new Set<string>();
		for (const texts of Object.values(norms.typical_checked ?? {})) {
			for (const text of texts) typical.add(text);
		}
		let overlap = 0;
		for (const sel of selections) {
			if (typical.has(sel.optionKey)) overlap += 1;
		}
		if (overlap / total < 0.6) {
			const differ = total - overlap;
			overlapNote = `count looks normal, but ${differ} of ${total} items differ from a typical review — verify the selection.`;
		}
	}

	return { overTickCategories, totalFlagged, overlapNote, total, median };
}

/**
 * Convenience: extract the pipeline-checked selections from a stored
 * execution result (postProcessed when present — the corrected envelope the
 * teacher sees — else the raw preEval) and compute the flags.
 * Returns null when the submission carries no rubric selections.
 */
export function overTickFromStored(
	stored: StoredExecutionResult | null | undefined,
	norms: CohortNorms,
): OverTickResult | null {
	const selections =
		stored?.postProcessed?.rubricSelections ?? stored?.preEval?.rubricSelections ?? [];
	if (selections.length === 0) {
		return null;
	}
	return computeOverTick(selections, norms);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
	return err instanceof Error && "code" in err;
}
