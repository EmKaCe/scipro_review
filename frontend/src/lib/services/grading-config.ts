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
// Teacher mode switch
// ---------------------------------------------------------------------------

/**
 * Teacher-mode switch: true in the teacher (node) build, where the grading
 * configuration is served by GET /api/config/grading reading DATA_DIR
 * directly.
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

	// Teacher mode: the config comes from GET /api/config/grading, which
	// reads data/grading_config.yaml from DATA_DIR on the server.
	if (apiMode.value) {
		try {
			const response = await fetch(`${base}/api/config/grading`);
			if (!response.ok) {
				console.error(
					`[grading-config] Failed to fetch /api/config/grading: ${response.status}`,
				);
				return null;
			}
			const body = (await response.json()) as { config?: GradingConfig };
			if (!body || !body.config || !Array.isArray(body.config.dimensions)) {
				console.error("[grading-config] Invalid /api/config/grading response");
				return null;
			}
			cachedConfig = body.config;
			return body.config;
		} catch (error) {
			console.error("[grading-config] Error fetching /api/config/grading:", error);
			return null;
		}
	}

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
