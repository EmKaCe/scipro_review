/**
 * @file Grading configuration loader — fetches and parses grading_config.yaml.
 *
 * Provides the grading dimensions and grade boundaries used by the grade calculator.
 * Results are cached in memory.
 *
 * @see .github/references/schemas/grading-config-schema.md
 */

import * as yaml from "js-yaml";
import { base } from "$app/paths";
import type { GradingConfig, GradeDimension, GradeBoundary } from "../types/grading.js";
import { parseDimensionKey } from "../types/grading.js";

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

let cachedConfig: GradingConfig | null = null;

// ---------------------------------------------------------------------------
// YAML fetching
// ---------------------------------------------------------------------------

/**
 * Fetch and parse the grading configuration from data/grading_config.yaml.
 *
 * Results are cached — subsequent calls return the cached value.
 *
 * @returns The grading configuration, or null on failure
 */
export async function loadGradingConfig(): Promise<GradingConfig | null> {
	if (cachedConfig) return cachedConfig;

	try {
		const url = new URL(`${base}/data/grading_config.yaml`, window.location.origin);
		const response = await fetch(url);
		if (!response.ok) {
			console.error(
				`[grading-config] Failed to fetch grading_config.yaml: ${response.status}`,
			);
			return null;
		}
		const text = await response.text();
		const raw = yaml.load(text) as Record<string, unknown>;

		if (!raw.dimensions || !Array.isArray(raw.dimensions)) {
			console.error(
				"[grading-config] Invalid grading_config.yaml: missing 'dimensions' array",
			);
			return null;
		}

		if (!raw.grade_boundaries || !Array.isArray(raw.grade_boundaries)) {
			console.error(
				"[grading-config] Invalid grading_config.yaml: missing 'grade_boundaries' array",
			);
			return null;
		}

		const dimensions: GradeDimension[] = (raw.dimensions as Record<string, unknown>[]).map(
			(d) => ({
				key: parseDimensionKey(d.key as string),
				title: d.title as string,
				max_points: d.max_points as number,
				weight: d.weight as number,
			}),
		);

		const grade_boundaries: GradeBoundary[] = (
			raw.grade_boundaries as Record<string, unknown>[]
		).map((b) => ({
			min_percentage: b.min_percentage as number,
			grade: b.grade as number,
			label: b.label as string,
			us_equiv: b.us_equiv as string,
		}));

		// Sort boundaries by min_percentage descending for efficient lookup
		grade_boundaries.sort((a, b) => b.min_percentage - a.min_percentage);

		const config: GradingConfig = { dimensions, grade_boundaries };
		cachedConfig = config;
		return config;
	} catch (error) {
		console.error("[grading-config] Error loading grading_config.yaml:", error);
		return null;
	}
}

/**
 * Get the grading configuration, loading it if necessary.
 *
 * Throws if the configuration cannot be loaded.
 *
 * @returns The grading configuration
 */
export async function getGradingConfig(): Promise<GradingConfig> {
	const config = await loadGradingConfig();
	if (!config) {
		throw new Error("Failed to load grading configuration");
	}
	return config;
}

// ---------------------------------------------------------------------------
// Cache management
// ---------------------------------------------------------------------------

/** Clear the cached configuration. Useful for testing or forced refresh. */
export function clearGradingConfigCache(): void {
	cachedConfig = null;
}
