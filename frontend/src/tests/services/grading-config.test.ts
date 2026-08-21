/**
 * @file Unit tests for grading-config.ts
 *
 * Tests YAML fetching, parsing, caching, and error handling.
 * Uses mocked fetch to avoid network requests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as gradingService from "$lib/services/grading-config";
import {
	loadGradingConfig,
	getGradingConfig,
	clearGradingConfigCache,
	saveGradingConfig,
	fetchGradingConfig,
} from "$lib/services/grading-config";

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const MOCK_VALID_YAML = `
dimensions:
  - key: code_quality_design
    title: "Code Quality & Design"
    max_points: 6
    weight: 4
  - key: code_execution_results
    title: "Code Execution & Results"
    max_points: 6
    weight: 4
  - key: assignment_requirements
    title: "Assignment Requirements"
    max_points: 6
    weight: 4
  - key: scientific_programming
    title: "Scientific Programming"
    max_points: 6
    weight: 4
  - key: creativity
    title: "Creativity"
    max_points: 4
    weight: 1

grade_boundaries:
  - min_percentage: 95
    grade: 1.0
    label: "excellent"
    us_equiv: "A+"
  - min_percentage: 50
    grade: 4.0
    label: "sufficient"
    us_equiv: "D"
  - min_percentage: 0
    grade: 5.0
    label: "insufficient"
    us_equiv: "F"
`;

const MOCK_MISSING_DIMENSIONS_YAML = `
grade_boundaries:
  - min_percentage: 95
    grade: 1.0
    label: "excellent"
    us_equiv: "A+"
`;

const MOCK_MISSING_BOUNDARIES_YAML = `
dimensions:
  - key: code_quality_design
    title: "Code Quality & Design"
    max_points: 6
    weight: 4
`;

// ---------------------------------------------------------------------------
// Mock fetch
// ---------------------------------------------------------------------------

function mockFetch(urlMap: Record<string, string>) {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
		const url =
			typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		for (const [path, content] of Object.entries(urlMap)) {
			if (url.endsWith(path) || url.includes(path)) {
				return new Response(content, {
					status: 200,
					headers: { "Content-Type": "text/yaml" },
				});
			}
		}
		return new Response("Not Found", { status: 404 });
	}) as unknown as typeof fetch;
	return () => {
		globalThis.fetch = originalFetch;
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
	clearGradingConfigCache();
});

/**
 * Flip the service's exported apiMode flag. The flag is a mutable holder
 * object (ESM namespace bindings are read-only, so a bare `export let`
 * could not be reassigned from tests) — mutating `.value` works in both
 * the module namespace and the live bindings.
 */
function setApiMode(value: boolean): void {
	gradingService.apiMode.value = value;
}

afterEach(() => {
	// The apiMode describe block flips this; always restore the student
	// (static) default so tests never leak teacher mode into each other.
	setApiMode(false);
});

describe("loadGradingConfig", () => {
	it("loads and parses grading_config.yaml", async () => {
		const restore = mockFetch({
			"data/grading_config.yaml": MOCK_VALID_YAML,
		});

		const config = await loadGradingConfig();
		expect(config).not.toBeNull();
		expect(config!.dimensions).toHaveLength(5);
		expect(config!.dimensions[0].key).toBe("code_quality_design");
		expect(config!.dimensions[0].title).toBe("Code Quality & Design");
		expect(config!.dimensions[0].max_points).toBe(6);
		expect(config!.dimensions[0].weight).toBe(4);

		expect(config!.grade_boundaries).toHaveLength(3);
		expect(config!.grade_boundaries[0].min_percentage).toBe(95);
		expect(config!.grade_boundaries[0].grade).toBe(1.0);
		expect(config!.grade_boundaries[0].label).toBe("excellent");

		restore();
	});

	it("caches config after first load", async () => {
		const restore = mockFetch({
			"data/grading_config.yaml": MOCK_VALID_YAML,
		});

		await loadGradingConfig();
		await loadGradingConfig(); // Second call should use cache

		// fetch should only be called once (second call uses cache)
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);

		restore();
	});

	it("returns null on 404 fetch failure", async () => {
		const restore = mockFetch({}); // No URLs mapped

		const result = await loadGradingConfig();
		expect(result).toBeNull();

		restore();
	});

	it("returns null when YAML is missing 'dimensions' array", async () => {
		const restore = mockFetch({
			"data/grading_config.yaml": MOCK_MISSING_DIMENSIONS_YAML,
		});

		const result = await loadGradingConfig();
		expect(result).toBeNull();

		restore();
	});

	it("returns null when YAML is missing 'grade_boundaries' array", async () => {
		const restore = mockFetch({
			"data/grading_config.yaml": MOCK_MISSING_BOUNDARIES_YAML,
		});

		const result = await loadGradingConfig();
		expect(result).toBeNull();

		restore();
	});
});

describe("getGradingConfig", () => {
	it("returns config when load succeeds", async () => {
		const restore = mockFetch({
			"data/grading_config.yaml": MOCK_VALID_YAML,
		});

		const config = await getGradingConfig();
		expect(config).not.toBeNull();
		expect(config.dimensions).toHaveLength(5);

		restore();
	});

	it("throws when load fails", async () => {
		const restore = mockFetch({}); // No URLs mapped

		await expect(getGradingConfig()).rejects.toThrow("Failed to load grading configuration");

		restore();
	});
});

describe("clearGradingConfigCache", () => {
	it("resets cache so next load re-fetches", async () => {
		const restore = mockFetch({
			"data/grading_config.yaml": MOCK_VALID_YAML,
		});

		await loadGradingConfig();
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);

		clearGradingConfigCache();

		await loadGradingConfig();
		// Should fetch again because cache was cleared
		expect(globalThis.fetch).toHaveBeenCalledTimes(2);

		restore();
	});
});

// ---------------------------------------------------------------------------
// apiMode (teacher build) branch
// ---------------------------------------------------------------------------

describe("apiMode (teacher build)", () => {
	it("loadGradingConfig fetches /api/config/grading and returns the config", async () => {
		setApiMode(true);
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					config: {
						dimensions: [
							{
								key: "code_quality_design",
								title: "Code Quality & Design",
								max_points: 6,
								weight: 4,
							},
						],
						grade_boundaries: [
							{ min_percentage: 95, grade: 1.0, label: "excellent", us_equiv: "A+" },
						],
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			),
		);
		vi.stubGlobal("fetch", fetchMock);

		const config = await loadGradingConfig();
		expect(config).not.toBeNull();
		expect(config!.dimensions).toHaveLength(1);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		// base may be "" (dev/node) or "/scipro_review" (static build) —
		// assert the API path itself.
		expect(String(fetchMock.mock.calls[0][0])).toContain("/api/config/grading");

		vi.unstubAllGlobals();
	});

	it("loadGradingConfig returns null on API failure", async () => {
		setApiMode(true);
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response("Not Found", { status: 404 })),
		);

		const config = await loadGradingConfig();
		expect(config).toBeNull();

		vi.unstubAllGlobals();
	});

	it("caches the API result for repeated calls", async () => {
		setApiMode(true);
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					config: { dimensions: [], grade_boundaries: [] },
				}),
				{ status: 200 },
			),
		);
		vi.stubGlobal("fetch", fetchMock);

		await loadGradingConfig();
		await loadGradingConfig();
		expect(fetchMock).toHaveBeenCalledTimes(1);

		vi.unstubAllGlobals();
	});
});

// ---------------------------------------------------------------------------
// Settings editor: fetchGradingConfig / saveGradingConfig
// ---------------------------------------------------------------------------

describe("fetchGradingConfig / saveGradingConfig (settings editor)", () => {
	beforeEach(() => {
		clearGradingConfigCache();
		setApiMode(false);
	});

	it("saveGradingConfig PUTs { config } and returns the saved config", async () => {
		const savedConfig = {
			dimensions: [
				{
					key: "code_quality_design",
					title: "Code Quality & Design",
					max_points: 6,
					weight: 4,
				},
			],
			grade_boundaries: [
				{ min_percentage: 95, grade: 1.0, label: "excellent", us_equiv: "A+" },
			],
		};
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ config: savedConfig }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const out = await saveGradingConfig(
			savedConfig as unknown as Parameters<typeof saveGradingConfig>[0],
		);
		expect(out.dimensions).toHaveLength(1);
		expect(out.grade_boundaries).toHaveLength(1);

		const [url, init] = fetchMock.mock.calls[0] as [unknown, RequestInit];
		expect(String(url)).toContain("/api/config/grading");
		expect((init as RequestInit).method).toBe("PUT");
		expect(JSON.parse((init as RequestInit).body as string).config).toEqual(savedConfig);

		vi.unstubAllGlobals();
	});

	it("saveGradingConfig refreshes the in-memory cache on success", async () => {
		clearGradingConfigCache();
		const savedConfig = { dimensions: [], grade_boundaries: [] };
		const fetchMock = vi
			.fn()
			.mockResolvedValue(
				new Response(JSON.stringify({ config: savedConfig }), { status: 200 }),
			);
		vi.stubGlobal("fetch", fetchMock);

		await saveGradingConfig({ dimensions: [], grade_boundaries: [] });
		const cfg = await loadGradingConfig(); // cache hit — no new fetch
		expect(cfg).not.toBeNull();
		expect(cfg!.dimensions).toEqual([]);
		expect(fetchMock).toHaveBeenCalledTimes(1); // only the save call

		vi.unstubAllGlobals();
	});

	it("saveGradingConfig throws on a non-OK response", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ message: "Invalid grading config: bad" }), {
				status: 400,
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(saveGradingConfig({ dimensions: [], grade_boundaries: [] })).rejects.toThrow(
			"Invalid grading config",
		);

		vi.unstubAllGlobals();
	});

	it("fetchGradingConfig issues a fresh GET (bypasses cache)", async () => {
		clearGradingConfigCache();
		const savedConfig = { dimensions: [], grade_boundaries: [] };
		const fetchMock = vi
			.fn()
			.mockResolvedValue(
				new Response(JSON.stringify({ config: savedConfig }), { status: 200 }),
			);
		vi.stubGlobal("fetch", fetchMock);

		const out = await fetchGradingConfig();
		expect(out.dimensions).toEqual([]);
		expect(String(fetchMock.mock.calls[0][0])).toContain("/api/config/grading");

		vi.unstubAllGlobals();
	});
});
