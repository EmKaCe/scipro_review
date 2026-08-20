/**
 * @file Synthetic grading-quality gate (replaces the removed Karl gate).
 *
 * A DETERMINISTIC safety net that validates proposed grading (dimension
 * scores + rubric selections) against the REAL rubric and grading config,
 * over COMMITTED SYNTHETIC fixtures. No LLM, no network, no student data —
 * as safe to run as a unit test (harness-agnostic CLI + vitest).
 *
 * Why this exists: the old "Karl ground-truth gate" compared the pipeline
 * against real emailed student grades to surface grading-quality defects
 * (e.g. the B7 bug where `update-grade-dimension` wrote 500/600 on an
 * arbitrary [0,1000] scale while rubric max_points are 4–6, plus over-ticking
 * and mutual-exclusion violations). Real grades were removed for privacy
 * (2026-08-20). The gate's FUNCTION is preserved here, deterministically:
 * assertions that run on synthetic authored fixtures and can never break
 * because a real student's data was introduced.
 *
 * Invariant classes checked (all pure functions of committed fixtures):
 *   1. Dimension-scale bounds (B7 class): a proposed score must be in
 *      [0, max_points] of the dimension per the REAL data/grading_config.yaml.
 *   2. Rubric-selection integrity: a proposed option text must be a real
 *      sub-point of that category in the REAL data/criteria/*.yaml
 *      (no unknown/invented options).
 *   3. Mutual-exclusion: a proposal must not check both sides of a configured
 *      mutual-exclusion pair.
 *
 * The gate FAILS (exit≠0 / test failure) when a fixture that is authored to
 * PASS fails a check, OR a fixture authored to FAIL passes every check — i.e.
 * the gate is a living spec: if the pipeline logic ever regresses such that a
 * known-bad proposal becomes "valid", the gate catches it.
 *
 * This module runs only on the SvelteKit server (`$lib/server/`).
 */

import path from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { loadGradingConfigFile } from "$lib/server/grading-config-writer";
import { getAssignmentById } from "$lib/server/assignments";
import { loadCriteriaForAssignment } from "$lib/server/criteria";
import { MUTUAL_EXCLUSION_PAIRS } from "$lib/server/copilot/worksheet";
import { allSubPoints } from "$lib/types/criteria";

import type { Category } from "$lib/types/criteria";

// ---------------------------------------------------------------------------
// Fixture schema
// ---------------------------------------------------------------------------

/** A synthetic grading proposal + its authored expectation. */
export interface GradingGateFixture {
	/** Unique fixture id (also the filename stem). */
	id: string;
	/** Assignment whose rubric + grading config ground the checks. */
	assignmentId: string;
	/** The authored expectation: true = this proposal MUST validate clean. */
	expectPass: boolean;
	/** Proposed dimension scores: dimension id -> score (points). */
	dimensions: Record<string, number>;
	/** Proposed rubric selections: category key -> option text(s). */
	rubric?: Record<string, string[]>;
}

/** Per-check result for one fixture. */
export interface GradingGateCheckResult {
	ok: boolean;
	check: "dimension_scale" | "rubric_option" | "mutual_exclusion";
	message: string;
}

/** Result of running the gate on one fixture. */
export interface GradingGateFixtureResult {
	fixture: string;
	/** Documented expectation (`expectPass` from the fixture). */
	expected: boolean;
	/** Whether the fixture validated clean (all checks ok). */
	actual: boolean;
	/** Non-empty when actual !== expected: the gate caught a regression. */
	pass: boolean;
	/** Detailed per-check results (for the report). */
	checks: GradingGateCheckResult[];
	/** First failing check message (for the summary). */
	detail?: string;
}

/** Full gate report. */
export interface GradingGateReport {
	gate: "grading-gate";
	runAt: string;
	fixtures: GradingGateFixtureResult[];
	summary: {
		total: number;
		passed: number;
		failed: number;
	};
}

// ---------------------------------------------------------------------------
// Check implementations (pure — unit testable)
// ---------------------------------------------------------------------------

/** True when `score` is within [0, max] for a dimension (B7 class). */
export function isInScale(score: number, max: number): boolean {
	return Number.isFinite(score) && score >= 0 && score <= max;
}

/** True when `optionText` is a real sub-point of `category`. */
export function isRealOption(category: Category, optionText: string): boolean {
	const texts = allSubPoints(category).map((sp) => sp.text);
	return texts.includes(optionText);
}

/**
 * Run all deterministic checks for one fixture against the real scoring data.
 * Pure given the fixtures + resolved config/rubric.
 */
export async function runFixtureChecks(
	fixture: GradingGateFixture,
	maxPoints: Record<string, number>,
	rubricByCategory: Record<string, Category>,
): Promise<GradingGateFixtureResult> {
	const checks: GradingGateCheckResult[] = [];

	// 1. Dimension-scale bounds (B7 class).
	for (const [dim, score] of Object.entries(fixture.dimensions)) {
		const max = maxPoints[dim];
		if (max === undefined) {
			checks.push({
				ok: false,
				check: "dimension_scale",
				message: `dimension '${dim}' not in grading_config.yaml`,
			});
		} else if (!isInScale(score, max)) {
			checks.push({
				ok: false,
				check: "dimension_scale",
				message: `dimension '${dim}' score ${score} out of [0, ${max}]`,
			});
		} else {
			checks.push({
				ok: true,
				check: "dimension_scale",
				message: `dimension '${dim}' ${score} in [0, ${max}]`,
			});
		}
	}

	// 2 + 3. Rubric integrity + mutual exclusion.
	for (const [categoryKey, options] of Object.entries(fixture.rubric ?? {})) {
		const category = rubricByCategory[categoryKey];
		if (!category) {
			checks.push({
				ok: false,
				check: "rubric_option",
				message: `category '${categoryKey}' not in the rubric`,
			});
			continue;
		}
		for (const opt of options) {
			if (isRealOption(category, opt)) {
				checks.push({
					ok: true,
					check: "rubric_option",
					message: `'${opt}' is a real option of '${categoryKey}'`,
				});
			} else {
				checks.push({
					ok: false,
					check: "rubric_option",
					message: `'${opt}' is not a real option of '${categoryKey}'`,
				});
			}
		}

		// Mutual-exclusion: both sides of a configured pair present.
		const optionsSet = new Set(options);
		for (const pair of MUTUAL_EXCLUSION_PAIRS[categoryKey] ?? []) {
			if (optionsSet.has(pair.a) && optionsSet.has(pair.b)) {
				checks.push({
					ok: false,
					check: "mutual_exclusion",
					message: `'${pair.a}' and '${pair.b}' are mutually exclusive${pair.label ? ` (${pair.label})` : ""}`,
				});
			}
		}
	}

	const actual = checks.every((c) => c.ok);
	const detail = checks.find((c) => !c.ok)?.message;
	return {
		fixture: fixture.id,
		expected: fixture.expectPass,
		actual,
		pass: actual === fixture.expectPass,
		checks,
		detail,
	};
}

// ---------------------------------------------------------------------------
// Fixture loading + gate driver
// ---------------------------------------------------------------------------

/** Absolute path of the committed synthetic fixtures dir (robust under bundling). */
export function getGateFixturesDir(): string {
	return fileURLToPath(
		new URL("../../../tests/copilot/fixtures/grading-gate", import.meta.url),
	);
}

/** Load all committed fixtures from the fixtures dir. */
export async function loadGateFixtures(dir = getGateFixturesDir()): Promise<GradingGateFixture[]> {
	const entries = (await readdir(dir)).filter((f) => f.endsWith(".json"));
	const fixtures: GradingGateFixture[] = [];
	for (const file of [...entries].sort()) {
		const raw = await readFile(path.join(dir, file), "utf-8");
		fixtures.push(JSON.parse(raw) as GradingGateFixture);
	}
	return fixtures;
}

/**
 * Resolve the real max_points per dimension from the committed grading config.
 */
export async function resolveMaxPoints(): Promise<Record<string, number>> {
	const config = await loadGradingConfigFile();
	if (!config) return {};
	const out: Record<string, number> = {};
	for (const dim of config.dimensions) out[dim.key] = dim.max_points;
	return out;
}

/**
 * Resolve the real merged rubric for an assignment, keyed by category key.
 */
export async function resolveRubric(assignmentId: string): Promise<Record<string, Category>> {
	const assignment = await getAssignmentById(assignmentId);
	if (!assignment) return {};
	const merged = await loadCriteriaForAssignment(assignment.criteria_files as string[]);
	const byKey: Record<string, Category> = {};
	for (const entry of merged.categories) {
		byKey[String(entry.key)] = entry.category;
	}
	return byKey;
}

/**
 * Run the full grading gate over all committed fixtures.
 */
export async function runGradingGate(
	fixtures?: GradingGateFixture[],
	maxPoints?: Record<string, number>,
): Promise<GradingGateReport> {
	const allFixtures = fixtures ?? (await loadGateFixtures());
	const allMaxPoints = maxPoints ?? (await resolveMaxPoints());
	const rubricCache = new Map<string, Record<string, Category>>();
	const results: GradingGateFixtureResult[] = [];
	for (const fixture of allFixtures) {
		let rubricByCategory = rubricCache.get(fixture.assignmentId);
		if (!rubricByCategory) {
			rubricByCategory = await resolveRubric(fixture.assignmentId);
			rubricCache.set(fixture.assignmentId, rubricByCategory);
		}
		results.push(await runFixtureChecks(fixture, allMaxPoints, rubricByCategory));
	}
	const passed = results.filter((r) => r.pass).length;
	return {
		gate: "grading-gate",
		runAt: new Date().toISOString(),
		fixtures: results,
		summary: { total: results.length, passed, failed: results.length - passed },
	};
}
