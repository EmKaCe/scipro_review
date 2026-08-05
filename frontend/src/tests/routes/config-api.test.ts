// @vitest-environment node
/**
 * @file L5 API-contract tests for the config routes.
 *
 * Imports the route handlers directly and drives them with minimal Request
 * stubs against a throwaway DATA_DIR (mkdtemp), covering:
 *   GET /api/config/criteria — merged rubric from DATA_DIR, 404s, 500 on
 *                              corrupt criteria YAML
 *   GET /api/config/grading  — grading config from DATA_DIR, 500s
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { RequestEvent } from "@sveltejs/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET as criteriaGET } from "../../routes/api/config/criteria/+server";
import { GET as gradingGET } from "../../routes/api/config/grading/+server";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ASSIGNMENTS_YAML = `assignments:
  - id: soil_contamination
    title: Soil Contamination by Factories
    enabled: true
    criteria_files:
      - data/criteria/general.yaml
      - data/criteria/soil_contamination.yaml
    dimensions:
      - code_quality_design
  - id: molecular_dynamics
    title: Molecular Dynamics
    enabled: false
    criteria_files: []
    dimensions: []
`;

const GENERAL_YAML = `categories:
  code_formatting:
    title: Code Formatting
    additional_notes: false
    positive:
      - main_point: Good formatting
        sub_points:
          - text: consistent_indentation
    neutral: []
    negative: []
`;

const SOIL_YAML = `categories:
  pandas:
    title: Pandas
    additional_notes: true
    positive:
      - main_point: Good pandas usage
        sub_points:
          - text: correct_dataframe_ops
    neutral: []
    negative: []
`;

const CORRUPT_CRITERIA_YAML = `categories: [unclosed
  - not: valid
`;

const GRADING_YAML = `dimensions:
  - key: code_quality_design
    title: Code Quality & Design
    max_points: 6
    weight: 4
  - key: code_execution_results
    title: Code Execution & Results
    max_points: 6
    weight: 4
  - key: assignment_requirements
    title: Assignment Requirements
    max_points: 6
    weight: 4
  - key: scientific_programming
    title: Scientific Programming
    max_points: 6
    weight: 4
  - key: creativity
    title: Creativity
    max_points: 4
    weight: 1

grade_boundaries:
  - min_percentage: 95
    grade: 1.0
    label: excellent
    us_equiv: A+
  - min_percentage: 0
    grade: 5.0
    label: insufficient
    us_equiv: F
`;

// ---------------------------------------------------------------------------
// Setup: isolated DATA_DIR per test
// ---------------------------------------------------------------------------

let dataDir: string;

beforeEach(async () => {
	dataDir = await mkdtemp(path.join(tmpdir(), "config-api-"));
	vi.stubEnv("DATA_DIR", dataDir);
	await writeFile(path.join(dataDir, "assignments.yaml"), ASSIGNMENTS_YAML);
	await mkdir(path.join(dataDir, "criteria"), { recursive: true });
	await writeFile(path.join(dataDir, "criteria", "general.yaml"), GENERAL_YAML);
	await writeFile(path.join(dataDir, "criteria", "soil_contamination.yaml"), SOIL_YAML);
	await writeFile(path.join(dataDir, "grading_config.yaml"), GRADING_YAML);
});

afterEach(async () => {
	vi.unstubAllEnvs();
	await rm(dataDir, { recursive: true, force: true });
});

/** Minimal RequestEvent stub — the routes only touch url.searchParams. */
function makeEvent(url: string): RequestEvent {
	return {
		url: new URL(`http://localhost${url}`),
		params: {},
		request: new Request(`http://localhost${url}`, { method: "GET" }),
	} as unknown as RequestEvent;
}

/** Assert a handler rejects with a SvelteKit HttpError (status + message). */
async function expectApiError(
	promise: Promise<unknown>,
	status: number,
	messagePart?: string,
): Promise<void> {
	try {
		await promise;
	} catch (err) {
		const e = err as { status?: number; body?: { message?: string } };
		expect(e.status).toBe(status);
		if (messagePart !== undefined) {
			expect(e.body?.message).toContain(messagePart);
		}
		return;
	}
	expect.unreachable(`expected handler to fail with ${status}`);
}

// ---------------------------------------------------------------------------
// GET /api/config/criteria
// ---------------------------------------------------------------------------

describe("GET /api/config/criteria", () => {
	it("returns the merged rubric with general + assignment categories in order", async () => {
		const res = await criteriaGET(
			makeEvent("/api/config/criteria?assignment=soil_contamination"),
		);
		expect(res.status).toBe(200);

		const body = (await res.json()) as {
			rubric: { categories: Array<{ key: string; category: { title: string } }> };
		};
		expect(body.rubric.categories.map((c) => c.category.title)).toEqual([
			"Code Formatting",
			"Pandas",
		]);
		expect(body.rubric.categories[0].key).toBe("code_formatting");
		expect(body.rubric.categories[1].key).toBe("pandas");
	});

	it("404s for an unknown assignment", async () => {
		await expectApiError(
			criteriaGET(makeEvent("/api/config/criteria?assignment=unknown")),
			404,
			"Assignment not found: unknown",
		);
	});

	it("404s when the assignment has no criteria files", async () => {
		await expectApiError(
			criteriaGET(makeEvent("/api/config/criteria?assignment=molecular_dynamics")),
			404,
			"No criteria files found",
		);
	});

	it("400s when the assignment query parameter is missing", async () => {
		await expectApiError(criteriaGET(makeEvent("/api/config/criteria")), 400, "assignment");
	});

	it("500s on corrupt criteria YAML instead of returning a silent empty rubric", async () => {
		await writeFile(
			path.join(dataDir, "criteria", "soil_contamination.yaml"),
			CORRUPT_CRITERIA_YAML,
		);
		await expectApiError(
			criteriaGET(makeEvent("/api/config/criteria?assignment=soil_contamination")),
			500,
			"not valid YAML",
		);
	});

	it("500s when a criteria file lacks the categories map", async () => {
		await writeFile(
			path.join(dataDir, "criteria", "soil_contamination.yaml"),
			"some_key: true\n",
		);
		await expectApiError(
			criteriaGET(makeEvent("/api/config/criteria?assignment=soil_contamination")),
			500,
			"missing 'categories'",
		);
	});
});

// ---------------------------------------------------------------------------
// GET /api/config/grading
// ---------------------------------------------------------------------------

describe("GET /api/config/grading", () => {
	it("returns the grading config with 5 dimensions", async () => {
		const res = await gradingGET(makeEvent("/api/config/grading"));
		expect(res.status).toBe(200);

		const body = (await res.json()) as {
			config: { dimensions: unknown[]; grade_boundaries: unknown[] };
		};
		expect(body.config.dimensions).toHaveLength(5);
		expect(body.config.grade_boundaries).toHaveLength(2);
	});

	it("sorts grade boundaries by min_percentage descending", async () => {
		const res = await gradingGET(makeEvent("/api/config/grading"));
		const body = (await res.json()) as {
			config: { grade_boundaries: Array<{ min_percentage: number }> };
		};
		expect(body.config.grade_boundaries.map((b) => b.min_percentage)).toEqual([95, 0]);
	});

	it("500s when grading_config.yaml is missing", async () => {
		await rm(path.join(dataDir, "grading_config.yaml"));
		await expectApiError(gradingGET(makeEvent("/api/config/grading")), 500, "not found");
	});

	it("500s when grading_config.yaml is missing the dimensions array", async () => {
		await writeFile(path.join(dataDir, "grading_config.yaml"), "grade_boundaries: []\n");
		await expectApiError(gradingGET(makeEvent("/api/config/grading")), 500, "dimensions");
	});
});
