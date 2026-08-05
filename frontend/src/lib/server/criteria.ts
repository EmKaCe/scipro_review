/**
 * @file Filesystem criteria loader for server-side routes.
 *
 * Server counterpart to $lib/services/criteria-loader.ts: reads the same
 * criteria YAML files directly from the data dir (DATA_DIR, default ./data)
 * and merges them into a MergedRubric with the same ordering and key parsing
 * as the client, so the teacher build and the student build produce
 * comparable rubrics from the same source files.
 *
 * Deliberate divergence from the client: a file that exists but is corrupt
 * (invalid YAML or missing `categories`) THROWS here so the API route can
 * surface a 500 instead of the client's silent null.
 *
 * This module runs only on the SvelteKit server (`$lib/server/`).
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import * as yaml from "js-yaml";

import type { Category, CategoryEntry, CriteriaFile, MergedRubric } from "$lib/types/criteria";
import { parseCategoryKey } from "$lib/types/criteria";
import { getDataDir } from "./metadata";

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Absolute path of a criteria file on disk.
 *
 * Registry `criteria_files` entries carry a `data/` prefix relative to the
 * data root (e.g. "data/criteria/general.yaml") — strip it before joining so
 * the file resolves inside DATA_DIR itself.
 */
export function getCriteriaPath(filePath: string): string {
	const normalized = filePath.replace(/^data[/\\]/, "");
	return path.join(getDataDir(), normalized);
}

/**
 * Load and parse one criteria YAML file from the data dir.
 *
 * Returns null when the file does not exist. Throws when the file exists but
 * is not valid YAML or lacks the `categories` map — a server misconfig should
 * surface as a 500, not a silent empty rubric.
 */
export async function loadCriteriaFile(filePath: string): Promise<CriteriaFile | null> {
	let raw: string;
	try {
		raw = await readFile(getCriteriaPath(filePath), "utf-8");
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
		throw new Error(`criteria file ${filePath} is not valid YAML: ${(err as Error).message}`, {
			cause: err,
		});
	}

	const record = parsed as { categories?: unknown };
	if (
		!parsed ||
		typeof parsed !== "object" ||
		Array.isArray(parsed) ||
		!record.categories ||
		typeof record.categories !== "object"
	) {
		throw new Error(`criteria file ${filePath} is invalid: missing 'categories' map`);
	}
	return parsed as CriteriaFile;
}

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

/**
 * Load and merge all criteria files for an assignment into a MergedRubric.
 *
 * Categories are ordered: general first, then assignment-specific, preserving
 * the order defined in the assignment's `criteria_files` list. Missing files
 * are skipped. The merge logic mirrors the client's
 * `loadCriteriaForAssignment` (criteria-loader.ts) so both paths produce the
 * same category order.
 *
 * @param criteriaFiles - Ordered list of criteria file paths from the registry
 * @returns Merged rubric with all categories (possibly empty)
 */
export async function loadCriteriaForAssignment(
	criteriaFiles: readonly string[],
): Promise<MergedRubric> {
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

	return { categories };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
	return err instanceof Error && "code" in err;
}
