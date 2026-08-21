/**
 * @file Server-side loader + writer for data/grading_config.yaml.
 *
 * Grading is an APPLICATION-level config (global dimensions + grade
 * boundaries shared across assignments), so its editor lives on the Settings
 * page and this module persists to the single tracked file — mirroring the
 * writeSettings discipline in settings.ts (fresh read, atomic temp+rename,
 * no-op guard).
 *
 * Environment:
 *   DATA_DIR — data root (default: ./data, i.e. /app/data in Docker)
 *
 * This module runs only on the SvelteKit server (`$lib/server/`).
 */

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import * as yaml from "js-yaml";

import { getDataDir } from "./metadata";
import {
	type GradingConfig,
	type GradeBoundary,
	type GradeDimension,
	parseDimensionKey,
} from "$lib/types/grading";

/** Absolute path to the tracked grading config file. */
export function getGradingConfigPath(): string {
	return path.join(getDataDir(), "grading_config.yaml");
}

/** Wire/config shape the writer persists (snake_case keys, same as the file). */
export interface GradingConfigPayload {
	dimensions: readonly GradeDimension[];
	grade_boundaries: readonly GradeBoundary[];
}

/** Serialize a grading config to the tracked YAML shape (snake_case keys). */
export function toGradingConfigYaml(config: GradingConfigPayload): string {
	return yaml.dump(
		{
			dimensions: (config.dimensions as readonly GradeDimension[]).map((d) => ({
				key: d.key,
				title: d.title,
				max_points: d.max_points,
				weight: d.weight,
			})),
			grade_boundaries: (config.grade_boundaries as readonly GradeBoundary[]).map((b) => ({
				min_percentage: b.min_percentage,
				grade: b.grade,
				label: b.label,
				us_equiv: b.us_equiv,
			})),
		},
		{ noRefs: true },
	);
}

/**
 * Deep structural equality for two grading configs (values only, key order in
 * objects ignored). Used by the PUT no-op guard: the client round-trips the
 * config through JSON, so a semantic no-op save must NOT churn the tracked
 * git file.
 */
export function deepEqualGradingConfig(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== typeof b || a === null || b === null) return false;
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
		return a.every((item, i) => deepEqualGradingConfig(item, b[i]));
	}
	if (typeof a === "object") {
		const aObj = a as Record<string, unknown>;
		const bObj = b as Record<string, unknown>;
		const aKeys = Object.keys(aObj);
		const bKeys = Object.keys(bObj);
		if (aKeys.length !== bKeys.length) return false;
		return aKeys.every((key) => deepEqualGradingConfig(aObj[key], bObj[key]));
	}
	return a === b;
}

/**
 * Atomically write data/grading_config.yaml (temp file in the same directory
 * + rename) so concurrent readers never observe a torn file.
 */
export async function writeGradingConfigFile(config: GradingConfigPayload): Promise<void> {
	const filePath = getGradingConfigPath();
	await mkdir(path.dirname(filePath), { recursive: true });
	const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
	await writeFile(tmpPath, toGradingConfigYaml(config), "utf-8");
	try {
		await rename(tmpPath, filePath);
	} catch (err) {
		// Best-effort cleanup so a failed rename never accumulates an orphaned
		// temp file in the data dir (writeFile already cleans its own partial
		// write on error; this covers the rename step specifically).
		await unlink(tmpPath).catch(() => {});
		throw err;
	}
}

/**
 * Read data/grading_config.yaml FRESH from disk (no cache) and parse it into
 * the standard config shape. Returns null when the file is absent; throws
 * when it exists but is invalid YAML or lacks the expected shape — a broken
 * grading config should surface, not silently vanish.
 */
export async function loadGradingConfigFile(): Promise<GradingConfig | null> {
	const filePath = getGradingConfigPath();
	let raw: string;
	try {
		raw = await readFile(filePath, "utf-8");
	} catch (err) {
		if (isNodeError(err) && err.code === "ENOENT") return null;
		throw err;
	}

	let parsed: unknown;
	try {
		parsed = yaml.load(raw);
	} catch (err) {
		throw new Error(`grading_config.yaml is invalid YAML: ${(err as Error).message}`, {
			cause: err,
		});
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(
			"grading_config.yaml must be an object with 'dimensions' and 'grade_boundaries'",
		);
	}
	const record = parsed as { dimensions?: unknown; grade_boundaries?: unknown };
	if (!Array.isArray(record.dimensions)) {
		throw new Error("grading_config.yaml is missing the 'dimensions' array");
	}
	if (!Array.isArray(record.grade_boundaries)) {
		throw new Error("grading_config.yaml is missing the 'grade_boundaries' array");
	}

	const dimensions = (record.dimensions as Record<string, unknown>[]).map((d) => ({
		key: parseDimensionKey(d.key as string),
		title: d.title as string,
		max_points: d.max_points as number,
		weight: d.weight as number,
	}));
	const grade_boundaries = (record.grade_boundaries as Record<string, unknown>[]).map((b) => ({
		min_percentage: b.min_percentage as number,
		grade: b.grade as number,
		label: b.label as string,
		us_equiv: b.us_equiv as string,
	}));

	return { dimensions, grade_boundaries };
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
	return err instanceof Error && "code" in err;
}
