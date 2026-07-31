/**
 * @file GET /api/assignments — list enabled assignments from data/assignments.yaml.
 *
 * Reads the YAML registry from the data directory (DATA_DIR, default ./data),
 * validates each entry, and returns only enabled assignments with the fields
 * the teacher UI needs: id, title, enabled, criteria_files.
 *
 * This is the server-side counterpart to $lib/services/criteria-loader.ts
 * (which fetches the same file over HTTP for static builds); here the file is
 * read directly from disk so the node build works against the shared data
 * volume.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import { error, json } from "@sveltejs/kit";
import * as yaml from "js-yaml";

import { getDataDir } from "$lib/server/metadata";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Assignment fields exposed by the list endpoint. */
interface AssignmentSummary {
	id: string;
	title: string;
	enabled: boolean;
	criteria_files: string[];
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * List all enabled assignments.
 *
 * Fails with 500 when assignments.yaml is missing, unreadable, corrupt, or has
 * no `assignments` list. Malformed entries are skipped — one bad entry must not
 * take down the registry.
 */
export async function GET(): Promise<Response> {
	const filePath = path.join(getDataDir(), "assignments.yaml");

	let raw: string;
	try {
		raw = await readFile(filePath, "utf-8");
	} catch (err) {
		if (isNodeError(err) && err.code === "ENOENT") {
			throw error(500, `assignments.yaml not found at ${filePath}`);
		}
		throw error(500, `Failed to read assignments.yaml: ${(err as Error).message}`);
	}

	let parsed: unknown;
	try {
		parsed = yaml.load(raw);
	} catch (err) {
		throw error(500, `Failed to parse assignments.yaml: ${(err as Error).message}`);
	}

	const registry = parsed as { assignments?: unknown };
	if (!registry || typeof registry !== "object" || !Array.isArray(registry.assignments)) {
		throw error(500, "assignments.yaml is missing the 'assignments' list");
	}

	const assignments: AssignmentSummary[] = [];
	for (const entry of registry.assignments) {
		const summary = toSummary(entry);
		if (summary?.enabled) assignments.push(summary);
	}

	return json({ assignments });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Validate one YAML entry; returns null when malformed. */
function toSummary(entry: unknown): AssignmentSummary | null {
	if (!entry || typeof entry !== "object") return null;
	const { id, title, enabled, criteria_files } = entry as Record<string, unknown>;
	if (typeof id !== "string" || typeof title !== "string" || typeof enabled !== "boolean") {
		return null;
	}
	if (!Array.isArray(criteria_files)) return null;
	return {
		id,
		title,
		enabled,
		criteria_files: criteria_files.filter((f): f is string => typeof f === "string"),
	};
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
	return err instanceof Error && "code" in err;
}
