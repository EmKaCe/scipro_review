/**
 * @file Server-side write operations for the assignments registry.
 *
 * Create/update/delete assignments in data/assignments.yaml with validation
 * and atomic writes (temp file + rename), preserving any other top-level
 * keys in the file. Read side lives in $lib/server/assignments.ts.
 *
 * Environment:
 *   DATA_DIR — data root (default: ./data, i.e. /app/data in Docker)
 *
 * This module runs only on the SvelteKit server (`$lib/server/`).
 */

import { mkdir, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import * as yaml from "js-yaml";

import type { Assignment, AssignmentsRegistry } from "$lib/types/assignments";
import type { DimensionKey } from "$lib/types/grading";

import { getAssignmentsPath, loadAssignmentsRegistry } from "./assignments";
import { getDataDir } from "./metadata";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * A rejected registry write. Carries the HTTP status the route layer should
 * surface (400 validation, 404 unknown id, 409 duplicate / has submissions).
 */
export class AssignmentWriteError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = "AssignmentWriteError";
		this.status = status;
	}
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Snake_case ids: lowercase letters, digits, underscores. */
const ID_PATTERN = /^[a-z0-9_]+$/;

/** All dimensions the grading config knows about (see grading.ts). */
const KNOWN_DIMENSIONS = new Set([
	"code_quality_design",
	"code_execution_results",
	"assignment_requirements",
	"scientific_programming",
	"creativity",
]);

/** Validate an assignment id; throws 400 when malformed. */
function validateId(id: unknown): string {
	if (typeof id !== "string" || !ID_PATTERN.test(id)) {
		throw new AssignmentWriteError(
			400,
			`Invalid assignment id ${JSON.stringify(id)} — must match ^[a-z0-9_]+$`,
		);
	}
	return id;
}

/** Validate a non-empty title; throws 400 when missing/blank. */
function validateTitle(title: unknown): string {
	if (typeof title !== "string" || title.trim().length === 0) {
		throw new AssignmentWriteError(400, "Assignment title must be a non-empty string");
	}
	return title;
}

/** Validate criteria_files entries (paths may reference not-yet-existing files). */
function validateCriteriaFiles(value: unknown): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.some((f) => typeof f !== "string")) {
		throw new AssignmentWriteError(400, "criteria_files must be an array of file path strings");
	}
	return value as string[];
}

/** Validate dimensions against the known DimensionKey set. */
function validateDimensions(value: unknown): DimensionKey[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.some((d) => typeof d !== "string")) {
		throw new AssignmentWriteError(400, "dimensions must be an array of strings");
	}
	for (const dim of value as string[]) {
		if (!KNOWN_DIMENSIONS.has(dim)) {
			throw new AssignmentWriteError(400, `Unknown dimension "${dim}"`);
		}
	}
	return value as DimensionKey[];
}

/** Validate an optional boolean (enabled). */
function validateEnabled(value: unknown): boolean | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") {
		throw new AssignmentWriteError(400, "enabled must be a boolean");
	}
	return value;
}

/** Shape accepted by createAssignment. */
export interface AssignmentCreateInput {
	id: string;
	title: string;
	enabled?: boolean;
	criteria_files?: string[];
	dimensions?: string[];
}

/** Shape accepted by updateAssignment (partial — absent keys keep their value). */
export type AssignmentUpdateInput = Partial<Omit<AssignmentCreateInput, "id">>;

// ---------------------------------------------------------------------------
// Registry persistence
// ---------------------------------------------------------------------------

/** Atomically persist the registry (temp file in the same dir + rename). */
async function writeRegistry(registry: AssignmentsRegistry): Promise<void> {
	const filePath = getAssignmentsPath();
	await mkdir(path.dirname(filePath), { recursive: true });
	const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
	await writeFile(tmpPath, yaml.dump(registry), "utf-8");
	await rename(tmpPath, filePath);
}

/** Ensure every registry id is unique and well-formed; throws 400 otherwise. */
function assertValidRegistry(registry: AssignmentsRegistry): void {
	const seen = new Set<string>();
	for (const entry of registry.assignments) {
		validateId(entry.id);
		if (seen.has(entry.id)) {
			throw new AssignmentWriteError(400, `Duplicate assignment id "${entry.id}"`);
		}
		seen.add(entry.id);
	}
}

/** Summary shape exposed by the API (mirrors the GET list items). */
export function toAssignmentSummary(assignment: Assignment): {
	id: string;
	title: string;
	enabled: boolean;
	criteria_files: string[];
} {
	return {
		id: assignment.id,
		title: assignment.title,
		enabled: assignment.enabled,
		criteria_files: [...assignment.criteria_files],
	};
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/**
 * Create an assignment and append it to the registry.
 *
 * Returns the created assignment. Throws {@link AssignmentWriteError} with
 * 400 on invalid input or 409 when the id already exists.
 */
export async function createAssignment(input: AssignmentCreateInput): Promise<Assignment> {
	const id = validateId(input?.id);
	const title = validateTitle(input?.title);
	const enabled = validateEnabled(input?.enabled) ?? true;
	const criteria_files = validateCriteriaFiles(input?.criteria_files);
	const dimensions = validateDimensions(input?.dimensions);

	const registry = (await loadAssignmentsRegistry()) ?? { assignments: [] };
	if (registry.assignments.some((a) => a.id === id)) {
		throw new AssignmentWriteError(409, `Assignment "${id}" already exists`);
	}

	const entry: Assignment = { id, title, enabled, criteria_files, dimensions };
	const next: AssignmentsRegistry = {
		...registry,
		assignments: [...registry.assignments, entry],
	};
	await writeRegistry(next);
	return entry;
}

/**
 * Partially update an assignment. Absent fields keep their current values.
 *
 * Returns the updated assignment. Throws {@link AssignmentWriteError} with
 * 404 when the id is unknown, 400 on invalid input or a resulting registry
 * that no longer validates.
 */
export async function updateAssignment(
	id: string,
	input: AssignmentUpdateInput,
): Promise<Assignment> {
	validateId(id);

	const registry = await loadAssignmentsRegistry();
	const existing = registry?.assignments.find((a) => a.id === id);
	if (!registry || !existing) {
		throw new AssignmentWriteError(404, `Assignment "${id}" not found`);
	}

	// Validate only the fields that were provided (partial update).
	if (input.title !== undefined) validateTitle(input.title);
	if (input.enabled !== undefined) validateEnabled(input.enabled);
	if (input.criteria_files !== undefined) validateCriteriaFiles(input.criteria_files);
	if (input.dimensions !== undefined) validateDimensions(input.dimensions);

	const updated: Assignment = {
		...existing,
		...(input.title !== undefined ? { title: input.title } : {}),
		...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
		...(input.criteria_files !== undefined
			? { criteria_files: validateCriteriaFiles(input.criteria_files) }
			: {}),
		...(input.dimensions !== undefined
			? { dimensions: validateDimensions(input.dimensions) }
			: {}),
	};

	const next: AssignmentsRegistry = {
		...registry,
		assignments: registry.assignments.map((a) => (a.id === id ? updated : a)),
	};
	assertValidRegistry(next);
	await writeRegistry(next);
	return updated;
}

/**
 * Delete an assignment from the registry.
 *
 * Refuses (409) whenever `data/submissions/<id>/` exists on disk — the
 * assignment has submissions and must not be removed from under them.
 * Throws {@link AssignmentWriteError} with 404 when the id is unknown.
 */
export async function deleteAssignment(id: string): Promise<void> {
	validateId(id);

	const registry = await loadAssignmentsRegistry();
	if (!registry || !registry.assignments.some((a) => a.id === id)) {
		throw new AssignmentWriteError(404, `Assignment "${id}" not found`);
	}

	const submissionsDir = path.join(getDataDir(), "submissions", id);
	try {
		await readdir(submissionsDir);
		throw new AssignmentWriteError(
			409,
			`Assignment "${id}" has submissions — move or delete them first`,
		);
	} catch (err) {
		if (err instanceof AssignmentWriteError) throw err;
		if (!isNodeError(err) || err.code !== "ENOENT") {
			throw new AssignmentWriteError(
				500,
				`Failed to check submissions for assignment "${id}": ${(err as Error).message}`,
			);
		}
	}

	const next: AssignmentsRegistry = {
		...registry,
		assignments: registry.assignments.filter((a) => a.id !== id),
	};
	assertValidRegistry(next);
	await writeRegistry(next);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
	return err instanceof Error && "code" in err;
}
