/**
 * @file Criteria loader — fetches and parses YAML rubric definitions from static data.
 *
 * Loads assignments.yaml, then criteria YAML files, and merges them into a
 * MergedRubric for a given assignment. Results are cached in memory.
 *
 * @see .github/references/schemas/criteria-schema.md
 */

import * as yaml from "js-yaml";
import { base } from "$app/paths";
import type { Category, CategoryEntry, CriteriaFile, MergedRubric } from "../types/criteria.js";
import type { Assignment, AssignmentsRegistry } from "../types/assignments.js";
import { parseCategoryKey } from "../types/criteria.js";

// ---------------------------------------------------------------------------
// Teacher mode switch
// ---------------------------------------------------------------------------

/**
 * Teacher-mode switch: true in the teacher (node) build, where config is
 * served by the API routes (`/api/config/*`) reading DATA_DIR directly.
 *
 * Computed once at module top because `__TEACHER_MODE__` is a compile-time
 * Rollup `define` — it is replaced textually at build time and CANNOT be
 * stubbed at runtime (e.g. with vi.stubGlobal). Exported as a mutable holder
 * (ESM namespace objects are read-only, so a bare `export let` could not be
 * flipped from tests); tests set `apiMode.value = true` to exercise the API
 * branch and restore `false` afterwards.
 */
export const apiMode: { value: boolean } = {
	value: typeof __TEACHER_MODE__ !== "undefined" && __TEACHER_MODE__,
};

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

/** In-memory cache for loaded assignments registry. */
let cachedAssignments: AssignmentsRegistry | null = null;

/** In-memory cache for merged rubrics, keyed by assignment ID. */
const rubricCache = new Map<string, MergedRubric>();

/** In-memory cache for raw criteria files, keyed by file path. */
const criteriaCache = new Map<string, CriteriaFile>();

// ---------------------------------------------------------------------------
// YAML fetching
// ---------------------------------------------------------------------------

/**
 * Fetch and parse a YAML file from the static data directory.
 *
 * @param path - Path relative to the base URL (e.g., "data/criteria/general.yaml")
 * @returns Parsed YAML as typed object, or null on failure
 */
async function fetchYaml<T>(path: string): Promise<T | null> {
	try {
		const url = new URL(`${base}/${path}`, window.location.origin);
		const response = await fetch(url);
		if (!response.ok) {
			console.error(`[criteria-loader] Failed to fetch ${path}: ${response.status}`);
			return null;
		}
		const text = await response.text();
		return yaml.load(text) as T;
	} catch (error) {
		console.error(`[criteria-loader] Error parsing ${path}:`, error);
		return null;
	}
}

// ---------------------------------------------------------------------------
// Assignments
// ---------------------------------------------------------------------------

/**
 * Load the assignments registry from data/assignments.yaml.
 *
 * Results are cached — subsequent calls return the cached value.
 *
 * @returns The assignments registry, or null on failure
 */
export async function loadAssignments(): Promise<AssignmentsRegistry | null> {
	if (cachedAssignments) return cachedAssignments;

	// Teacher mode: the registry comes from GET /api/assignments (server
	// reads DATA_DIR directly). The API omits `dimensions` — map it to [].
	if (apiMode.value) {
		try {
			const response = await fetch(`${base}/api/assignments`);
			if (!response.ok) {
				console.error(
					`[criteria-loader] Failed to fetch /api/assignments: ${response.status}`,
				);
				return null;
			}
			const body = (await response.json()) as { assignments?: Array<Partial<Assignment>> };
			if (!body || !Array.isArray(body.assignments)) {
				console.error(
					"[criteria-loader] Invalid /api/assignments response: missing 'assignments'",
				);
				return null;
			}
			const registry: AssignmentsRegistry = {
				assignments: body.assignments.map((a) => ({
					id: a.id ?? "",
					title: a.title ?? "",
					enabled: a.enabled ?? false,
					criteria_files: a.criteria_files ?? [],
					dimensions: [],
				})),
			};
			cachedAssignments = registry;
			return registry;
		} catch (error) {
			console.error("[criteria-loader] Error fetching /api/assignments:", error);
			return null;
		}
	}

	const data = await fetchYaml<AssignmentsRegistry>("data/assignments.yaml");
	if (!data || !data.assignments) {
		console.error("[criteria-loader] Invalid assignments.yaml: missing 'assignments' key");
		return null;
	}

	cachedAssignments = data;
	return data;
}

/**
 * Get only enabled assignments from the registry.
 *
 * Loads the registry if not already cached.
 *
 * @returns Array of enabled assignments, or empty array on failure
 */
export async function getEnabledAssignments(): Promise<Assignment[]> {
	const registry = await loadAssignments();
	if (!registry) return [];
	return registry.assignments.filter((a) => a.enabled);
}

// ---------------------------------------------------------------------------
// Criteria loading
// ---------------------------------------------------------------------------

/**
 * Load and parse a single criteria YAML file.
 *
 * Results are cached by file path.
 *
 * @param filePath - Path relative to the base URL (e.g., "data/criteria/general.yaml")
 * @returns Parsed criteria file, or null on failure
 */
export async function loadCriteriaFile(filePath: string): Promise<CriteriaFile | null> {
	if (criteriaCache.has(filePath)) {
		return criteriaCache.get(filePath)!;
	}

	// Teacher mode: criteria files are served merged by the API route — a
	// single call returns the whole rubric for the assignment, so this
	// per-file function is unused there. Kept on the static path for the
	// student build.
	if (apiMode.value) {
		return null;
	}

	const data = await fetchYaml<CriteriaFile>(filePath);
	if (!data || !data.categories) {
		console.error(
			`[criteria-loader] Invalid criteria file ${filePath}: missing 'categories' key`,
		);
		return null;
	}

	criteriaCache.set(filePath, data);
	return data;
}

/**
 * Load and merge all criteria files for a given assignment.
 *
 * Categories are ordered: general first, then assignment-specific,
 * preserving the order defined in the assignment's `criteria_files` list.
 *
 * @param assignmentId - The assignment ID to load criteria for
 * @param criteriaFiles - Ordered list of criteria file paths (relative to base URL)
 * @returns Merged rubric with all categories, or null on failure
 */
export async function loadCriteriaForAssignment(
	assignmentId: string,
	criteriaFiles: readonly string[],
): Promise<MergedRubric | null> {
	// Check cache first
	if (rubricCache.has(assignmentId)) {
		return rubricCache.get(assignmentId)!;
	}

	// Teacher mode: the API route merges the files server-side — use
	// getCriteriaForAssignment() instead; this per-file merge path is
	// student-build only.
	if (apiMode.value) {
		return null;
	}

	const categories: CategoryEntry[] = [];

	// Load all criteria files in parallel
	const results = await Promise.all(criteriaFiles.map((filePath) => loadCriteriaFile(filePath)));

	// Merge categories in order
	for (const result of results) {
		if (!result) continue;

		for (const [key, category] of Object.entries(result.categories)) {
			categories.push({
				key: parseCategoryKey(key),
				category: category as Category,
			});
		}
	}

	const rubric: MergedRubric = { categories };
	rubricCache.set(assignmentId, rubric);
	return rubric;
}

/**
 * Convenience function: load criteria for an assignment by its ID.
 *
 * Looks up the assignment in the registry, then loads and merges its criteria files.
 *
 * @param assignmentId - The assignment ID
 * @returns Merged rubric, or null if assignment not found or loading fails
 */
export async function getCriteriaForAssignment(assignmentId: string): Promise<MergedRubric | null> {
	// Check rubric cache first
	if (rubricCache.has(assignmentId)) {
		return rubricCache.get(assignmentId)!;
	}

	// Teacher mode: the merged rubric comes from GET /api/config/criteria,
	// which reads the criteria YAML from DATA_DIR on the server.
	if (apiMode.value) {
		try {
			const response = await fetch(
				`${base}/api/config/criteria?assignment=${encodeURIComponent(assignmentId)}`,
			);
			if (!response.ok) {
				console.error(
					`[criteria-loader] Failed to fetch criteria for ${assignmentId}: ${response.status}`,
				);
				return null;
			}
			const body = (await response.json()) as { rubric?: MergedRubric };
			if (!body || !body.rubric) {
				console.error(
					`[criteria-loader] Invalid /api/config/criteria response for ${assignmentId}`,
				);
				return null;
			}
			rubricCache.set(assignmentId, body.rubric);
			return body.rubric;
		} catch (error) {
			console.error(`[criteria-loader] Error fetching criteria for ${assignmentId}:`, error);
			return null;
		}
	}

	const registry = await loadAssignments();
	if (!registry) return null;

	const assignment = registry.assignments.find((a) => a.id === assignmentId);
	if (!assignment) {
		console.error(`[criteria-loader] Assignment not found: ${assignmentId}`);
		return null;
	}

	return loadCriteriaForAssignment(assignmentId, assignment.criteria_files);
}

// ---------------------------------------------------------------------------
// Cache management
// ---------------------------------------------------------------------------

/** Clear all cached data. Useful for testing or forced refresh. */
export function clearCache(): void {
	cachedAssignments = null;
	rubricCache.clear();
	criteriaCache.clear();
}
