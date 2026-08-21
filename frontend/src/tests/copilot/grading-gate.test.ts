// @vitest-environment node
/**
 * @file Synthetic grading-quality gate tests (replaces the removed ground-truth gate).
 *
 * Runs the deterministic grading gate over the committed synthetic fixtures in
 * fixtures/grading-gate/*.json and asserts the gate's contract: a fixture
 * authored expectPass=true must validate clean, and expectPass=false must fail
 * at least one check. This makes the gate a LIVING SPEC — if the pipeline's
 * validation logic ever regresses so a known-bad proposal becomes "valid" (or
 * a known-good proposal is wrongly rejected), this suite catches it.
 *
 * Also unit-tests the pure checks (isInScale, isRealOption) directly.
 */

import { describe, expect, it, beforeAll } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
	loadGateFixtures,
	runGradingGate,
	resolveMaxPoints,
	resolveRubric,
	runFixtureChecks,
	isInScale,
	isRealOption,
} from "$lib/server/copilot/grading-gate";

// The gate reads the REAL committed grading config + rubric (read-only) so the
// fixture assertions are grounded in production data. Point DATA_DIR at the
// repo data/ explicitly (vitest forbids the implicit real tree).
const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
	"..",
);
beforeAll(() => {
	process.env.DATA_DIR = path.join(REPO_ROOT, "data");
});

describe("grading-gate pure checks", () => {
	it("isInScale bounds scores to [0, max]", () => {
		expect(isInScale(5, 6)).toBe(true);
		expect(isInScale(0, 6)).toBe(true);
		expect(isInScale(6, 6)).toBe(true);
		expect(isInScale(7, 6)).toBe(false);
		expect(isInScale(-1, 6)).toBe(false);
		expect(isInScale(Number.NaN, 6)).toBe(false);
		expect(isInScale(Number.POSITIVE_INFINITY, 6)).toBe(false);
	});

	it("isRealOption distinguishes real vs invented rubric texts", async () => {
		const rubric = await resolveRubric("soil_contamination");
		const cat = rubric["code_formatting"];
		expect(cat).toBeDefined();
		expect(isRealOption(cat!, "blank lines - consistent and good usage")).toBe(true);
		expect(isRealOption(cat!, "invented rubric option")).toBe(false);
	});
});

describe("grading-gate over committed synthetic fixtures", () => {
	it("fixtures dir exists and holds at least the four canonical cases", async () => {
		const fixtures = await loadGateFixtures();
		const ids = fixtures.map((f) => f.id).sort();
		expect(ids).toContain("valid-proposal");
		expect(ids).toContain("over-scale-dimension");
		expect(ids).toContain("unknown-rubric-option");
		expect(ids).toContain("mutual-exclusion-violation");
	});

	it("every committed fixture validates to its authored expectation (gate is green)", async () => {
		const fixtures = await loadGateFixtures();
		const maxPoints = await resolveMaxPoints();
		const report = await runGradingGate(fixtures, maxPoints);

		// The report is computed from the fixtures' own expectations — but that
		// is NOT circular: runFixtureChecks compares the fixture's authored
		// expectation (expectPass) against the ACTUAL check result on the real
		// rubric/config. A mismatch is a real gate failure.
		expect(report.summary.failed).toBe(0);
		expect(report.summary.passed).toBe(report.summary.total);

		for (const r of report.fixtures) {
			expect(r.pass, `${r.fixture}: ${r.detail ?? "unexpected"}`).toBe(true);
		}
	});

	it("the canonical cases produce the expected actual outcomes", async () => {
		const fixtures = await loadGateFixtures();
		const maxPoints = await resolveMaxPoints();
		const rubric = await resolveRubric("soil_contamination");

		for (const fx of fixtures) {
			const result = await runFixtureChecks(fx, maxPoints, rubric);
			// Live assertion of the exact known-bad/good outcomes — guard against
			// a fixture file being edited to a degenerate state.
			switch (fx.id) {
				case "valid-proposal":
					expect(result.actual).toBe(true);
					break;
				case "over-scale-dimension":
					expect(result.actual).toBe(false);
					expect(result.detail).toMatch(/creativity/);
					break;
				case "unknown-rubric-option":
					expect(result.actual).toBe(false);
					expect(result.detail).toMatch(/not a real option/);
					break;
				case "mutual-exclusion-violation":
					expect(result.actual).toBe(false);
					expect(result.detail).toMatch(/mutually exclusive/);
					break;
			}
		}
	});
});

describe("over-scale regression (B7 class)", () => {
	it("a dimension scored above its max_points is flagged — the 500/1000 bug class", async () => {
		const result = await runFixtureChecks(
			{
				id: "b7-regression",
				assignmentId: "soil_contamination",
				expectPass: false,
				dimensions: { scientific_programming: 500, creativity: 3 },
			},
			await resolveMaxPoints(),
			await resolveRubric("soil_contamination"),
		);
		expect(result.actual).toBe(false);
		expect(result.detail).toMatch(/out of \[0, 6\]/);
	});
});
