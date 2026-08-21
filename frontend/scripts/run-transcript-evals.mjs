#!/usr/bin/env node
/**
 * @file P12 — runEvals regression harness CLI (recorded copilot transcripts).
 *
 * Replays recorded copilot grading turns through the rubric-fidelity judge
 * (the SAME KI Connect model the copilot uses) and reports scores. No state
 * is touched: this script only READS the thread store and prints results.
 *
 * Usage (from the repo root or frontend/):
 *   cd frontend
 *   pnpm exec tsx scripts/run-transcript-evals.mjs --dry-run   # list proposals, NO LLM
 *   pnpm exec tsx scripts/run-transcript-evals.mjs              # live judge, concurrency 2
 *   pnpm exec tsx scripts/run-transcript-evals.mjs --json       # machine-readable JSON only
 *
 * Environment: DATA_DIR defaults to the repo `data/` dir (the recorded
 * transcripts mirror the Docker volume); the repo-root `.env` is loaded for
 * any variable not already present (KI_CONNECT_API_KEY, KI_CONNECT_BASE_URL).
 * The live run requires KI_CONNECT_API_KEY.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Environment bootstrap — must run before the $lib import chain is evaluated.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

if (!process.env.DATA_DIR) {
	process.env.DATA_DIR = path.join(REPO_ROOT, "data");
}

const envPath = path.join(REPO_ROOT, ".env");
try {
	const raw = await readFile(envPath, "utf-8");
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eq = trimmed.indexOf("=");
		if (eq === -1) continue;
		const key = trimmed
			.slice(0, eq)
			.trim()
			.replace(/^export\s+/, "");
		const value = trimmed.slice(eq + 1).trim();
		if (key && !(key in process.env)) process.env[key] = value;
	}
} catch {
	// No .env file — rely on the ambient environment.
}

const DRY_RUN = process.argv.includes("--dry-run");
const JSON_ONLY = process.argv.includes("--json");
const CONCURRENCY = 2; // KI Connect empirical ceiling — never run 3+ in parallel

/** Optional `--model <id>` override (the settings file may lag the deployment). */
function flagValue(name) {
	const idx = process.argv.indexOf(name);
	return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : undefined;
}
const MODEL_OVERRIDE = flagValue("--model");

// ---------------------------------------------------------------------------
// Judge instructions — MUST mirror rubric-fidelity.ts JUDGE_INSTRUCTIONS
// verbatim (that module does not export it; keep in sync when edited there).
// ---------------------------------------------------------------------------

const JUDGE_INSTRUCTIONS = [
	"You are a grading-quality judge for a scientific-programming course.",
	"Evaluate whether the copilot's proposed grading is FAITHFUL to the assignment's rubric.",
	"",
	"Check each dimension score against the rubric's max_points:",
	"- A score above the dimension's max_points is over-scoring (flag it).",
	"- A score far below what the rubric criteria justify is under-scoring (flag it).",
	"- Scores should be consistent with the rubric selections: if the rubric says",
	"  'good use of sklearn' but the dimension score is near the floor, that is a",
	"  contradiction.",
	"",
	"Check the rubric selections against the criteria:",
	"- A selected option must be a real option of that criterion.",
	"- Selections that contradict each other (e.g. both 'imports alphabetized' and",
	"  'imports not alphabetized') are a fidelity failure.",
	"",
	"Check the feedback text:",
	"- Feedback must match the selections (praise what is checked, note what is not).",
	"- Feedback that contradicts the scores or selections is a fidelity failure.",
	"",
	"Score 1.0 for a fully faithful proposal, 0.0 for one that contradicts the",
	"rubric. Be strict but fair: minor wording issues are not fidelity failures.",
	"Return a JSON object with 'score' (0-1) and 'reason' (one short paragraph).",
].join("\n");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(text, max) {
	const firstLine = (text ?? "").replace(/\s+/g, " ").trim();
	return firstLine.length > max ? `${firstLine.slice(0, max)}…` : firstLine;
}

function hasKeys(record) {
	return record && typeof record === "object" && Object.keys(record).length > 0;
}

function summaryOf(proposal) {
	return [
		`rubric:${hasKeys(proposal.rubric) ? Object.keys(proposal.rubric).length : 0}`,
		`dims:${hasKeys(proposal.dimensions) ? Object.keys(proposal.dimensions).length : 0}`,
		`feedback:${typeof proposal.feedback === "string" && proposal.feedback.length > 0 ? "yes" : "no"}`,
		`assignment:${proposal.assignmentId ?? "?"}`,
	].join(" ");
}

/** Run `fn` over items with a fixed-width worker pool (never exceeds `limit`). */
async function mapWithConcurrency(items, limit, fn) {
	const results = new Array(items.length);
	let next = 0;
	async function worker() {
		while (true) {
			const idx = next++;
			if (idx >= items.length) return;
			results[idx] = await fn(items[idx], idx);
		}
	}
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const { loadRecordedThreads } = await import("$lib/server/copilot/eval-transcript");
const { rubricFidelityOutputSchema } = await import("$lib/server/copilot/rubric-fidelity");

const threads = await loadRecordedThreads();
const items = threads.flatMap((t) =>
	t.proposals.map((proposal, i) => ({ thread: t, turn: t.turns[i], proposal })),
);

if (items.length === 0) {
	if (!JSON_ONLY) {
		console.log("No recorded threads with grading proposals found");
		console.log(`DATA_DIR=${process.env.DATA_DIR}`);
	}
	process.exit(0);
}

if (DRY_RUN) {
	for (const { thread, turn, proposal } of items) {
		console.log(`[${thread.threadId}] turn ${turn} | ${summaryOf(proposal)}`);
		if (hasKeys(proposal.rubric)) {
			console.log(`  rubric: ${JSON.stringify(proposal.rubric)}`);
		}
		if (hasKeys(proposal.dimensions)) {
			console.log(`  dimensions: ${JSON.stringify(proposal.dimensions)}`);
		}
		if (typeof proposal.feedback === "string" && proposal.feedback.length > 0) {
			console.log(`  feedback: ${truncate(proposal.feedback, 120)}`);
		}
		console.log(`  thread: ${truncate(thread.title, 70) || "(untitled)"}`);
	}
	const byThread = new Map();
	for (const item of items) {
		byThread.set(item.thread.threadId, (byThread.get(item.thread.threadId) ?? 0) + 1);
	}
	console.log("");
	console.log(
		`SUMMARY: ${items.length} proposal(s) from ${byThread.size} thread(s) ` +
			`(${[...byThread.entries()].map(([id, n]) => `${id}: ${n}`).join(", ")})`,
	);
	console.log(`DATA_DIR=${process.env.DATA_DIR}`);
	console.log("Dry run — no LLM calls were made. Remove --dry-run to score live.");
	process.exit(0);
}

if (!process.env.KI_CONNECT_API_KEY) {
	console.error("KI_CONNECT_API_KEY is not set — the live judge cannot run.");
	console.error("Use --dry-run to list the extracted proposals without calling the LLM.");
	process.exit(1);
}

const { loadSettings } = await import("$lib/server/settings");
const { getKiConnectClient } = await import("$lib/server/ki-connect");

const settings = await loadSettings();
const client = getKiConnectClient();
const model = MODEL_OVERRIDE ?? settings.llm.model;

if (!JSON_ONLY) {
	console.log(
		`Scoring ${items.length} proposal(s) with model ${model} (concurrency ${CONCURRENCY})`,
	);
	console.log("");
}

const scored = await mapWithConcurrency(items, CONCURRENCY, async ({ thread, turn, proposal }) => {
	try {
		const userPrompt = `Grading proposal to evaluate:\n${JSON.stringify(proposal, null, 2)}`;
		const raw = await client.chatCompletion(
			JUDGE_INSTRUCTIONS,
			userPrompt,
			0.1,
			{ type: "json_object" },
			rubricFidelityOutputSchema,
			undefined,
			model,
		);
		const { score, reason } = raw;
		return { thread, turn, proposal, score, reason };
	} catch (err) {
		// One failed judge call must not abort the whole run: mark the item
		// failed, keep the already-completed scores, and let the summary
		// report the failure count.
		return {
			thread,
			turn,
			proposal,
			score: null,
			reason: null,
			error: String(err?.message ?? err),
		};
	}
});

if (!JSON_ONLY) {
	for (const { thread, turn, proposal, score, reason, error } of scored) {
		if (score === null) {
			console.log(
				`[${thread.threadId}] turn ${turn} | ${summaryOf(proposal)} | ERROR: ${truncate(error ?? "unknown", 100)}`,
			);
			continue;
		}
		console.log(
			`[${thread.threadId}] turn ${turn} | ${summaryOf(proposal)} | score=${score.toFixed(2)} | ${truncate(reason, 100)}`,
		);
	}
	const valid = scored.filter((s) => s.score !== null);
	const mean =
		valid.length > 0 ? valid.reduce((sum, s) => sum + s.score, 0) / valid.length : null;
	console.log("");
	console.log(
		`SUMMARY: ${scored.length} proposal(s); ${valid.length} scored, ${scored.length - valid.length} failed; mean rubric-fidelity = ${mean === null ? "n/a" : mean.toFixed(3)}`,
	);
}

const report = {
	harness: "rubric-fidelity-transcript-evals",
	runAt: new Date().toISOString(),
	dryRun: false,
	concurrency: CONCURRENCY,
	model,
	threads: threads.map((t) => ({
		threadId: t.threadId,
		title: t.title,
		resourceId: t.resourceId,
		proposals: t.proposals.map((proposal, i) => {
			const s = scored.find((x) => x.thread.threadId === t.threadId && x.turn === t.turns[i]);
			return {
				turn: t.turns[i],
				proposal,
				...(s ? { score: s.score, reason: s.reason } : {}),
			};
		}),
	})),
	summary: {
		proposalCount: scored.length,
		failedCount: scored.filter((s) => s.score === null).length,
		meanScore:
			scored.filter((s) => s.score !== null).length > 0
				? scored.filter((s) => s.score !== null).reduce((sum, s) => sum + s.score, 0) /
					scored.filter((s) => s.score !== null).length
				: null,
	},
};

if (JSON_ONLY) {
	console.log(JSON.stringify(report, null, 2));
} else {
	console.log("\n=== JSON report (stdout, nothing written to disk) ===");
	console.log(JSON.stringify(report, null, 2));
}
