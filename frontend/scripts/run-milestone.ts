#!/usr/bin/env node
/**
 * @file Standalone milestone runner (Wave 2A).
 *
 * Runs the turn-based rubric-selection protocol for ONE submission and ONE
 * category against live KI Connect, prints the final worksheet section plus
 * the resolved rubric selections / additional notes, and diffs them against
 * the checked `codeFormatting-*` keys of the reference grading output
 * (`grading-output/final_2/2026SS_00.json`).
 *
 * Usage (from the repo root):
 *   cd frontend && npx tsx scripts/run-milestone.ts
 *
 * Environment: DATA_DIR defaults to the repo `data/` dir; the repo-root
 * `.env` (KI_CONNECT_API_KEY, KI_CONNECT_BASE_URL, …) is loaded for any
 * variable not already present in the process environment.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as yaml from "js-yaml";

// ---------------------------------------------------------------------------
// Environment bootstrap — must run before the $lib import chain is evaluated.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

if (!process.env.DATA_DIR) {
	process.env.DATA_DIR = path.join(REPO_ROOT, "data");
}

// Load the repo-root .env for any variable not already set in the process
// environment (the real KI Connect API key lives there). Missing .env is fine
// — the ambient environment may already carry the variables.
const envPath = path.join(REPO_ROOT, ".env");
try {
	const raw = await readFile(envPath, "utf-8");
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eq = trimmed.indexOf("=");
		if (eq === -1) continue;
		const key = trimmed.slice(0, eq).trim().replace(/^export\s+/, "");
		const value = trimmed.slice(eq + 1).trim();
		if (key && !(key in process.env)) process.env[key] = value;
	}
} catch {
	// No .env file — rely on the ambient environment.
}

// ---------------------------------------------------------------------------
// Milestone run
// ---------------------------------------------------------------------------

const SUBMISSION_ID = "2026SS_00";
const ASSIGNMENT_ID = "soil_contamination";
const CATEGORY_KEY = "code_formatting";
const MODEL = "qwen3-30b-a3b-instruct-2507";
const TEMPERATURE = 0.2;

const EXPECTED_JSON_PATH = path.join(
	REPO_ROOT,
	"grading-output",
	"final_2",
	`${SUBMISSION_ID}.json`,
);

/** One rubric sub-point with its sentiment + main-point group (verbatim texts). */
interface SubPointRef {
	sentiment: string;
	mainPoint: string;
	subPoint: string;
}

/**
 * Load the assignment's criteria files and collect every sub-point of the
 * milestone category, so expected Karl-form keys can be mapped back to
 * optionKeys (the key format is `prefix-sentiment-mainPoint-subPoint` with
 * verbatim texts — hyphens included).
 */
async function loadCategorySubPoints(): Promise<SubPointRef[]> {
	const assignmentsRaw = await readFile(
		path.join(process.env.DATA_DIR!, "assignments.yaml"),
		"utf-8",
	);
	const registry = yaml.load(assignmentsRaw) as {
		assignments: { id: string; criteria_files: string[] }[];
	};
	const assignment = registry.assignments.find((a) => a.id === ASSIGNMENT_ID);
	if (!assignment) {
		throw new Error(`Assignment "${ASSIGNMENT_ID}" not found in assignments.yaml`);
	}

	const subPoints: SubPointRef[] = [];
	for (const file of assignment.criteria_files) {
		const rel = file.replace(/^data[/\\]/, "");
		const raw = await readFile(path.join(process.env.DATA_DIR!, rel), "utf-8");
		const parsed = yaml.load(raw) as {
			categories: Record<
				string,
				{
					positive?: { main_point: string; sub_points: { text: string }[] }[];
					negative?: { main_point: string; sub_points: { text: string }[] }[];
					neutral?: { main_point: string; sub_points: { text: string }[] }[];
				}
			>;
		};
		const category = parsed.categories[CATEGORY_KEY];
		if (!category) continue;
		for (const sentiment of ["positive", "negative", "neutral"] as const) {
			for (const mainPoint of category[sentiment] ?? []) {
				for (const sub of mainPoint.sub_points) {
					subPoints.push({ sentiment, mainPoint: mainPoint.main_point, subPoint: sub.text });
				}
			}
		}
	}
	return subPoints;
}

try {
	const { runTurnBasedCategoryMilestone } = await import(
		"$lib/server/copilot/pre-evaluation"
	);

	console.log(
		`Running milestone: submission=${SUBMISSION_ID} assignment=${ASSIGNMENT_ID} category=${CATEGORY_KEY} model=${MODEL} temperature=${TEMPERATURE}`,
	);
	console.log(`DATA_DIR=${process.env.DATA_DIR}`);
	console.log(`KI Connect key: ${process.env.KI_CONNECT_API_KEY ? "set" : "MISSING"}`);
	console.log("");

	const result = await runTurnBasedCategoryMilestone({
		submissionId: SUBMISSION_ID,
		assignmentId: ASSIGNMENT_ID,
		categoryKey: CATEGORY_KEY,
		model: MODEL,
		temperature: TEMPERATURE,
	});

	console.log("=== FINAL WORKSHEET SECTION (code_formatting) ===");
	console.log(result.worksheetSection);
	console.log("");

	console.log("=== RESOLVED RUBRIC SELECTIONS ===");
	if (result.rubricSelections.length === 0) {
		console.log("(none)");
	}
	for (const selection of result.rubricSelections) {
		console.log(`- [${selection.categoryKey}] ${selection.optionKey}`);
	}
	console.log("");

	console.log("=== ADDITIONAL NOTES ===");
	console.log(JSON.stringify(result.additionalNotes, null, 2));
	console.log("");

	// -----------------------------------------------------------------------
	// Comparison against the reference grading output
	// -----------------------------------------------------------------------

	const expectedRaw = await readFile(EXPECTED_JSON_PATH, "utf-8");
	const expectedJson = JSON.parse(expectedRaw) as Record<string, string>;

	const expectedCheckedKeys = Object.keys(expectedJson).filter(
		(key) => key.startsWith("codeFormatting-") && expectedJson[key] === "checked",
	);
	const expectedTextarea = expectedJson["codeFormatting-textarea"] ?? null;

	const subPoints = await loadCategorySubPoints();
	const expectedOptionKeys = new Set<string>();
	const unmatchedExpectedKeys: string[] = [];
	for (const key of expectedCheckedKeys) {
		const match = subPoints.find(
			(sp) => `codeFormatting-${sp.sentiment}-${sp.mainPoint}-${sp.subPoint}` === key,
		);
		if (match) {
			expectedOptionKeys.add(match.subPoint);
		} else {
			unmatchedExpectedKeys.push(key);
		}
	}

	const actualOptionKeys = new Set(result.rubricSelections.map((s) => s.optionKey));
	const missing = [...expectedOptionKeys].filter((key) => !actualOptionKeys.has(key));
	const unexpected = [...actualOptionKeys].filter((key) => !expectedOptionKeys.has(key));

	const actualTextarea = (result.additionalNotes[CATEGORY_KEY] ?? "").trim();
	const textareaMatches = actualTextarea === (expectedTextarea ?? "").trim();

	console.log("=== DIFF vs grading-output/final_2/2026SS_00.json ===");
	console.log(`Expected checked codeFormatting keys: ${expectedCheckedKeys.length}`);
	for (const key of expectedCheckedKeys) {
		console.log(`  - ${key}`);
	}
	if (unmatchedExpectedKeys.length > 0) {
		console.log(`Unmapped expected keys (no matching rubric sub-point): ${unmatchedExpectedKeys.length}`);
		for (const key of unmatchedExpectedKeys) {
			console.log(`  - ${key}`);
		}
	}
	console.log("");
	console.log(`MISSING (expected but not selected): ${missing.length}`);
	for (const key of missing) {
		console.log(`  - ${key}`);
	}
	console.log(`UNEXPECTED (selected but not expected): ${unexpected.length}`);
	for (const key of unexpected) {
		console.log(`  - ${key}`);
	}
	console.log("");
	console.log(`TEXTAREA match: ${textareaMatches ? "YES" : "NO"}`);
	if (!textareaMatches) {
		console.log("  expected:");
		console.log(`  ${JSON.stringify(expectedTextarea)}`);
		console.log("  actual:");
		console.log(`  ${JSON.stringify(actualTextarea)}`);
	}
	console.log("");
	console.log(
		`SUMMARY: ${missing.length} missing, ${unexpected.length} unexpected, textarea ${textareaMatches ? "matches" : "DIFFERS"}`,
	);
} catch (err) {
	console.error("\nMilestone runner failed:");
	console.error(err instanceof Error ? err.message : err);
	if (err instanceof Error && err.stack) {
		console.error(err.stack);
	}
	process.exit(1);
}
