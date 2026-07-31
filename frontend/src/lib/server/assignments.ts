/**
 * @file Filesystem assignments registry loader for server-side routes.
 *
 * Client code loads data/assignments.yaml over HTTP (criteria-loader.ts);
 * server routes read the same file directly from the data dir so they work
 * without a browser. The registry is re-read per call — cheap for a local
 * tool and avoids stale caches across file edits.
 *
 * Environment:
 *   DATA_DIR — data root (default: ./data, i.e. /app/data in Docker)
 *
 * This module runs only on the SvelteKit server (`$lib/server/`).
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import * as yaml from "js-yaml";

import type { Assignment, AssignmentsRegistry } from "$lib/types/assignments";
import { getDataDir } from "./metadata";

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/** Absolute path of the assignments registry file. */
export function getAssignmentsPath(): string {
	return path.join(getDataDir(), "assignments.yaml");
}

/**
 * Load and parse data/assignments.yaml.
 *
 * Returns null when the file does not exist. Throws when the file exists but
 * is not a valid registry (missing `assignments` list) — a server misconfig
 * should surface as a 500, not a silent empty list.
 */
export async function loadAssignmentsRegistry(): Promise<AssignmentsRegistry | null> {
	let raw: string;
	try {
		raw = await readFile(getAssignmentsPath(), "utf-8");
	} catch (err) {
		if (isNodeError(err) && err.code === "ENOENT") {
			return null;
		}
		throw err;
	}

	let parsed: unknown;
	try {
		parsed = yaml.load(raw);
	} catch (err) {
		throw new Error(
			`assignments.yaml is not valid YAML: ${(err as Error).message}`,
			{ cause: err },
		);
	}

	if (
		!parsed ||
		typeof parsed !== "object" ||
		Array.isArray(parsed) ||
		!Array.isArray((parsed as { assignments?: unknown }).assignments)
	) {
		throw new Error("assignments.yaml is invalid: missing 'assignments' list");
	}
	return parsed as AssignmentsRegistry;
}

/** Enabled assignments from the registry (empty when no file exists). */
export async function getEnabledAssignments(): Promise<Assignment[]> {
	const registry = await loadAssignmentsRegistry();
	if (!registry) return [];
	return registry.assignments.filter((a) => a.enabled);
}

/** Look up one assignment by id, or null. */
export async function getAssignmentById(id: string): Promise<Assignment | null> {
	const registry = await loadAssignmentsRegistry();
	return registry?.assignments.find((a) => a.id === id) ?? null;
}

/** True when the assignment id exists in the registry. */
export async function assignmentExists(id: string): Promise<boolean> {
	return (await getAssignmentById(id)) !== null;
}

/**
 * Resolve the assignment for a request: the explicit `?assignment=` / body
 * id wins; otherwise the first enabled assignment from assignments.yaml.
 * Returns null when nothing is configured.
 */
export async function resolveAssignmentId(
	explicit: string | null | undefined,
): Promise<string | null> {
	if (explicit && explicit.trim()) {
		return explicit.trim();
	}
	const enabled = await getEnabledAssignments();
	return enabled.length > 0 ? enabled[0]!.id : null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
	return err instanceof Error && "code" in err;
}
