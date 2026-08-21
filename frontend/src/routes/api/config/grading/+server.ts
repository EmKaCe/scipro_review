/**
 * @file GET/PUT /api/config/grading — grading configuration (dimensions +
 * grade boundaries) read from / written to data/grading_config.yaml in
 * DATA_DIR.
 *
 * GET — current config. Missing or invalid configuration is a 500 — the
 *       teacher UI needs this to compute grades, so failures must be
 *       visible, not silently null.
 * PUT — validate (reuse server/grading-validation.ts), no-op guard (skip the
 *       write when semantically identical to what's on disk), then write
 *       atomically (temp file + rename). Returns the persisted config.
 *
 * This is APPLICATION-level config (global, shared across assignments), so
 * it is edited on the Settings page — not per-assignment like criteria or
 * scoring (see the assignment editor).
 *
 * Environment: DATA_DIR (default ./data). Server-only ($lib/server deps).
 */
import { error, json } from "@sveltejs/kit";
import type { RequestEvent } from "@sveltejs/kit";

import { validateGradingConfig } from "$lib/server/grading-validation";
import {
	deepEqualGradingConfig,
	loadGradingConfigFile,
	writeGradingConfigFile,
} from "$lib/server/grading-config-writer";
import type { GradingConfig } from "$lib/types/grading";

/** Return a config whose grade boundaries are sorted by min_percentage
 * descending (the consumption order the rest of the app expects). Never
 * mutates the readonly source arrays. */
function withSortedBoundaries(config: GradingConfig): GradingConfig {
	return {
		dimensions: config.dimensions,
		grade_boundaries: [...config.grade_boundaries].sort(
			(a, b) => b.min_percentage - a.min_percentage,
		),
	};
}

export async function GET(_event: RequestEvent): Promise<Response> {
	let config: GradingConfig | null;
	try {
		config = await loadGradingConfigFile();
	} catch (err) {
		// Broken config should surface as a 500, not a silent empty editor.
		throw error(500, `Failed to read grading_config.yaml: ${(err as Error).message}`);
	}
	if (!config) {
		throw error(500, `grading_config.yaml not found in DATA_DIR`);
	}
	return json({ config: withSortedBoundaries(config) });
}

export async function PUT(event: RequestEvent): Promise<Response> {
	let body: unknown;
	try {
		body = await event.request.json();
	} catch {
		throw error(400, "Expected a JSON body");
	}
	const record = (body as Record<string, unknown> | null) ?? {};
	const config = record.config;

	const validationError = validateGradingConfig(config);
	if (validationError) {
		throw error(400, `Invalid grading config: ${validationError}`);
	}

	const normalized = config as GradingConfig;

	// Normalize the incoming config for the no-op comparison: grade boundaries
	// are consumed sorted by min_percentage, so their file order is cosmetic —
	// a save that only reorders boundaries is a semantic no-op.
	function forCompare(c: GradingConfig): GradingConfig {
		return {
			dimensions: c.dimensions,
			grade_boundaries: [...c.grade_boundaries].sort(
				(a, b) => b.min_percentage - a.min_percentage,
			),
		};
	}

	// No-op guard: when the saved config is semantically identical to what is
	// already on disk, skip the write entirely. The YAML dump reformats
	// (indentation, folding), so a no-op save must NOT churn the tracked git
	// file — otherwise every "Save" click produces a fake diff.
	const existing = await loadGradingConfigFile();
	if (existing && deepEqualGradingConfig(forCompare(existing), forCompare(normalized))) {
		return json({ config: withSortedBoundaries(normalized) });
	}

	try {
		await writeGradingConfigFile(normalized);
	} catch (err) {
		throw error(500, `Failed to write grading_config.yaml: ${(err as Error).message}`);
	}

	return json({ config: withSortedBoundaries(normalized) });
}
