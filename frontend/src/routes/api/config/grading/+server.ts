/**
 * @file GET /api/config/grading — grading configuration (dimensions +
 * grade boundaries) read from data/grading_config.yaml in DATA_DIR.
 *
 * Teacher-mode counterpart to $lib/services/grading-config.ts. Missing or
 * invalid configuration is a 500 — the teacher UI needs this to compute
 * grades, so failures must be visible, not silently null.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import * as yaml from "js-yaml";

import { error, json } from "@sveltejs/kit";
import type { RequestEvent } from "@sveltejs/kit";

import { getDataDir } from "$lib/server/metadata";
import type { GradingConfig, GradeBoundary, GradeDimension } from "$lib/types/grading";
import { parseDimensionKey } from "$lib/types/grading";

export async function GET(_event: RequestEvent): Promise<Response> {
	const filePath = path.join(getDataDir(), "grading_config.yaml");

	let raw: string;
	try {
		raw = await readFile(filePath, "utf-8");
	} catch (err) {
		if (isNodeError(err) && err.code === "ENOENT") {
			throw error(500, `grading_config.yaml not found at ${filePath}`);
		}
		throw error(500, `Failed to read grading_config.yaml: ${(err as Error).message}`);
	}

	let parsed: unknown;
	try {
		parsed = yaml.load(raw);
	} catch (err) {
		throw error(500, `Failed to parse grading_config.yaml: ${(err as Error).message}`);
	}

	const record = parsed as { dimensions?: unknown; grade_boundaries?: unknown };
	if (!record || typeof record !== "object" || !Array.isArray(record.dimensions)) {
		throw error(500, "grading_config.yaml is missing the 'dimensions' array");
	}
	if (!Array.isArray(record.grade_boundaries)) {
		throw error(500, "grading_config.yaml is missing the 'grade_boundaries' array");
	}

	const dimensions: GradeDimension[] = (record.dimensions as Record<string, unknown>[]).map(
		(d) => ({
			key: parseDimensionKey(d.key as string),
			title: d.title as string,
			max_points: d.max_points as number,
			weight: d.weight as number,
		}),
	);

	const grade_boundaries: GradeBoundary[] = (
		record.grade_boundaries as Record<string, unknown>[]
	).map((b) => ({
		min_percentage: b.min_percentage as number,
		grade: b.grade as number,
		label: b.label as string,
		us_equiv: b.us_equiv as string,
	}));

	// Sort boundaries by min_percentage descending for efficient lookup
	// (same post-processing as the client loader).
	grade_boundaries.sort((a, b) => b.min_percentage - a.min_percentage);

	const config: GradingConfig = { dimensions, grade_boundaries };
	return json({ config });
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
	return err instanceof Error && "code" in err;
}
