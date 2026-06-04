/**
 * @file Assignment registry — the single source of truth for what assignments
 * exist, which criteria files they use, and which grading dimensions apply.
 *
 * Loaded from data/assignments.yaml.
 *
 * @see .github/references/schemas/assignments-schema.md
 */

import type { DimensionKey } from "./grading.js";

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------

/** A single assignment defined in the registry. */
export interface Assignment {
	/** Snake_case identifier (e.g., "atom_interaction"). */
	readonly id: string;
	/** Human-readable display title. */
	readonly title: string;
	/** Whether the assignment appears in the selector. */
	readonly enabled: boolean;
	/** Ordered list of criteria YAML files (relative to data/criteria/). */
	readonly criteria_files: readonly string[];
	/** Dimension keys that apply to this assignment. */
	readonly dimensions: readonly DimensionKey[];
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** Full assignments registry parsed from assignments.yaml. */
export interface AssignmentsRegistry {
	/** All registered assignments. */
	readonly assignments: readonly Assignment[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Find an assignment by ID. Returns undefined if not found. */
export function findAssignment(registry: AssignmentsRegistry, id: string): Assignment | undefined {
	return registry.assignments.find((a) => a.id === id);
}

/** Get only enabled assignments. */
export function enabledAssignments(registry: AssignmentsRegistry): readonly Assignment[] {
	return registry.assignments.filter((a) => a.enabled);
}
