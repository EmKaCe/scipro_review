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
import { loadGradingConfigFile } from "./grading-config-writer";

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
// Upload validation
// ---------------------------------------------------------------------------

/**
 * A rejected criteria YAML upload (schema violation, duplicate category key,
 * or collision with general.yaml). Carries a message the route surfaces as a
 * 400 — see {@link validateCriteriaYaml}.
 */
export class CriteriaValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CriteriaValidationError";
	}
}

const SENTIMENTS = ["positive", "neutral", "negative"] as const;

/** Assert a value is an object (a map). */
function requireRecord(value: unknown, label: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new CriteriaValidationError(`criteria: ${label} must be a map`);
	}
	return value as Record<string, unknown>;
}

/** Assert an array (may be empty). */
function requireArray(value: unknown, label: string): unknown[] {
	if (!Array.isArray(value)) {
		throw new CriteriaValidationError(`criteria: ${label} must be an array`);
	}
	return value;
}

/** Assert a string. */
function requireString(value: unknown, label: string): string {
	if (typeof value !== "string") {
		throw new CriteriaValidationError(`criteria: ${label} must be a string`);
	}
	return value;
}

/** Assert an optional boolean (absent or boolean). */
function requireOptionalBoolean(value: unknown, label: string): void {
	if (value === undefined) return;
	if (typeof value !== "boolean") {
		throw new CriteriaValidationError(`criteria: ${label} must be a boolean`);
	}
}

/**
 * Validate an optional `dimensions` field (main-point default or sub-point
 * override). Absent → allowed. Present → must be a non-empty array of
 * non-empty strings, and (when the grading config loads) every key must be a
 * known dimension key. Unknown YAML keys remain tolerated elsewhere — only a
 * PRESENT-but-malformed `dimensions` field is rejected here.
 */
function requireOptionalDimensions(value: unknown, label: string): void {
	if (value === undefined) return;
	const isNonEmptyStringArray =
		Array.isArray(value) &&
		value.length > 0 &&
		value.every((entry) => typeof entry === "string" && entry.trim().length > 0);
	if (!isNonEmptyStringArray) {
		throw new CriteriaValidationError(
			`criteria: ${label} must be a non-empty array of strings`,
		);
	}
}

/**
 * Validate a v2 criteria YAML document (the schema used by
 * data/criteria/*.yaml — see {@link CriteriaFile}).
 *
 * Returns the parsed shape for the caller to persist. Throws a
 * {@link CriteriaValidationError} (message intended for a 400 response) when:
 * - the document is not valid YAML or `categories` is missing / not a
 *   non-empty object
 * - a category misses `title` (string) or `additional_notes` (boolean), or a
 *   sentiment list is not an array
 * - a main-point item lacks a `main_point` string or a `sub_points` array
 * - a sub-point lacks a `text` string or carries a non-boolean
 *   `comment` / `point_deduction`
 * - a present-but-malformed `dimensions` field (non-array, empty array, or
 *   non-string entry) on a main point or sub-point
 * - a `dimensions` key that is not a known grading dimension (checked only
 *   when data/grading_config.yaml loads; absent or unloadable config SKIPS
 *   the membership check — the malformed-shape checks above always apply)
 * - a category key is duplicated within the upload itself
 *
 * Duplicate-key detection uses YAML 1.2 (js-yaml default) semantics: the
 * loader throws on duplicated mapping keys, and explicit duplicate checks
 * cover keys duplicated with different casing or whitespace variants that
 * the parser normalizes away.
 *
 * @param raw - The YAML document text
 * @param fileName - File name for error messages
 */
export async function validateCriteriaYaml(
	raw: string,
	fileName: string,
): Promise<{ fileName: string; categories: Record<string, unknown> }> {
	let parsed: unknown;
	try {
		parsed = yaml.load(raw);
	} catch (err) {
		throw new CriteriaValidationError(
			`${fileName} is not valid YAML: ${(err as Error).message}`,
		);
	}

	const root = requireRecord(parsed, "top level");
	const categories = requireRecord(root.categories, "categories");
	if (Object.keys(categories).length === 0) {
		throw new CriteriaValidationError("criteria: categories must not be empty");
	}

	// Casing/whitespace variants of a key all resolve to the same YAML map
	// key — reject them as duplicates of an existing key.
	const seen = new Map<string, string>();
	for (const key of Object.keys(categories)) {
		const normalized = key.trim().toLowerCase();
		const existing = seen.get(normalized);
		if (existing !== undefined && existing !== key) {
			throw new CriteriaValidationError(
				`criteria: duplicate category key "${key}" (conflicts with "${existing}")`,
			);
		}
		seen.set(normalized, key);
	}

	for (const [key, value] of Object.entries(categories)) {
		const category = requireRecord(value, `category "${key}"`);
		requireString(category.title, `category "${key}".title`);
		requireOptionalBoolean(category.additional_notes, `category "${key}".additional_notes`);
		for (const sentiment of SENTIMENTS) {
			const mainPoints = requireArray(category[sentiment], `category "${key}".${sentiment}`);
			for (const [i, mp] of mainPoints.entries()) {
				const mainPoint = requireRecord(mp, `category "${key}".${sentiment}[${i}]`);
				requireString(
					mainPoint.main_point,
					`category "${key}".${sentiment}[${i}].main_point`,
				);
				requireOptionalDimensions(
					mainPoint.dimensions,
					`category "${key}".${sentiment}[${i}].dimensions`,
				);
				const subPoints = requireArray(
					mainPoint.sub_points,
					`category "${key}".${sentiment}[${i}].sub_points`,
				);
				for (const [j, sp] of subPoints.entries()) {
					const subPoint = requireRecord(
						sp,
						`category "${key}".${sentiment}[${i}].sub_points[${j}]`,
					);
					requireString(
						subPoint.text,
						`category "${key}".${sentiment}[${i}].sub_points[${j}].text`,
					);
					requireOptionalBoolean(
						subPoint.comment,
						`category "${key}".${sentiment}[${i}].sub_points[${j}].comment`,
					);
					requireOptionalBoolean(
						subPoint.point_deduction,
						`category "${key}".${sentiment}[${i}].sub_points[${j}].point_deduction`,
					);
					requireOptionalDimensions(
						subPoint.dimensions,
						`category "${key}".${sentiment}[${i}].sub_points[${j}].dimensions`,
					);
				}
			}
		}
	}

	// Key membership (soft): unknown dimension keys are rejected ONLY when
	// grading_config.yaml loads. A missing file or an unloadable (corrupt)
	// config skips the check entirely — a valid rubric must never be blocked
	// because the global grading config is absent.
	let knownDimensionKeys: Set<string> | null = null;
	try {
		const gradingConfig = await loadGradingConfigFile();
		if (gradingConfig) {
			knownDimensionKeys = new Set(gradingConfig.dimensions.map((d) => d.key));
		}
	} catch {
		knownDimensionKeys = null;
	}
	if (knownDimensionKeys) {
		const listDimensions = (value: unknown): readonly string[] =>
			Array.isArray(value) ? value.filter((e): e is string => typeof e === "string") : [];
		const seen = new Set<string>();
		for (const [key, value] of Object.entries(categories)) {
			const category = requireRecord(value, `category "${key}"`);
			for (const sentiment of SENTIMENTS) {
				const mainPoints = requireArray(
					category[sentiment],
					`category "${key}".${sentiment}`,
				);
				for (const [i, mp] of mainPoints.entries()) {
					const mainPoint = requireRecord(mp, `category "${key}".${sentiment}[${i}]`);
					for (const dim of listDimensions(mainPoint.dimensions)) {
						if (seen.has(`${sentiment}[${i}].${dim}`)) continue;
						seen.add(`${sentiment}[${i}].${dim}`);
						if (!knownDimensionKeys.has(dim)) {
							throw new CriteriaValidationError(
								`criteria: category "${key}".${sentiment}[${i}].dimensions contains unknown key "${dim}" (known: ${[...knownDimensionKeys].join(", ")})`,
							);
						}
					}
					const subPoints = requireArray(
						mainPoint.sub_points,
						`category "${key}".${sentiment}[${i}].sub_points`,
					);
					for (const [j, sp] of subPoints.entries()) {
						const subPoint = requireRecord(
							sp,
							`category "${key}".${sentiment}[${i}].sub_points[${j}]`,
						);
						for (const dim of listDimensions(subPoint.dimensions)) {
							if (seen.has(`${sentiment}[${i}][${j}].${dim}`)) continue;
							seen.add(`${sentiment}[${i}][${j}].${dim}`);
							if (!knownDimensionKeys.has(dim)) {
								throw new CriteriaValidationError(
									`criteria: category "${key}".${sentiment}[${i}].sub_points[${j}].dimensions contains unknown key "${dim}" (known: ${[...knownDimensionKeys].join(", ")})`,
								);
							}
						}
					}
				}
			}
		}
	}

	return { fileName, categories };
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
