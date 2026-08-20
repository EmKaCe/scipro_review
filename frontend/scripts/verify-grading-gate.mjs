#!/usr/bin/env node
/**
 * @file Verify the synthetic grading-quality gate (replaces verify-karl-gate.py).
 *
 * A DETERMINISTIC, safe-to-run grader-quality check over committed synthetic
 * fixtures. No LLM, no network, no student data — as safe as a unit test.
 * Exits 0 when every fixture matches its authored expectation, non-zero
 * otherwise (for CI).
 *
 * Install/run (needs DATA_DIR pointing at the repo `data/`, which is the
 * default when run from the repo root):
 *   cd /root/projects/svelte-review-copilot/frontend
 *   pnpm exec tsx scripts/verify-grading-gate.mjs
 *   pnpm exec tsx scripts/verify-grading-gate.mjs --json   # machine report
 *
 * The same checks run as a vitest suite (src/tests/copilot/grading-gate.test.ts)
 * as part of the full test run.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import { runGradingGate } from "$lib/server/copilot/grading-gate";

// Point DATA_DIR at the repo data/ (where the committed grading config, rubric
// and assignments.yaml live) unless the environment already sets it. This makes
// the CLI runnable from the repo root or frontend/ without extra setup.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
if (!process.env.DATA_DIR) {
	process.env.DATA_DIR = path.join(REPO_ROOT, "data");
}

const JSON_ONLY = process.argv.includes("--json");

const report = await runGradingGate();

if (!JSON_ONLY) {
	if (report.fixtures.length === 0) {
		console.log("No committed grading-gate fixtures found.");
		process.exit(1);
	}
	console.log(
		`${"fixture".padEnd(26)} ${"expected".padEnd(9)} ${"actual".padEnd(7)} ${"PASS".padEnd(5)} detail`,
	);
	for (const r of report.fixtures) {
		console.log(
			`${r.fixture.padEnd(26)} ${String(r.expected).padEnd(9)} ${String(r.actual).padEnd(7)} ` +
				`${r.pass ? "PASS" : "FAIL".padEnd(5)}${r.pass ? "" : `  ${r.detail ?? ""}`}`,
		);
	}
	console.log("");
	console.log(
		`SUMMARY: ${report.summary.passed}/${report.summary.total} fixtures match their authored expectation`,
	);
	console.log("Deterministic grade-quality gate — no LLM, no student data.");
}

console.log(JSON.stringify(report, null, 2));

process.exit(report.summary.failed > 0 ? 1 : 0);
