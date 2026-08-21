/**
 * @file data/plagiarism/<assignment>.json cache for plagiarism results.
 *
 * The check route writes the completed comparison here (atomically, same
 * pattern as metadata.json / results.json); the results route reads it.
 *
 * Environment:
 *   DATA_DIR — data root (default: ./data, i.e. /app/data in Docker)
 *
 * This module runs only on the SvelteKit server (`$lib/server/`).
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { assertSafeSegment, getDataDir } from "../metadata";

import {
	classifyPair,
	combinedScore,
	reviewStatusOf,
	type PairReviewStatus,
	type PlagiarismPair,
} from "./structural";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Cached plagiarism comparison for one assignment. */
export interface PlagiarismResult {
	status: "pending" | "checking" | "done" | "error";
	assignmentId: string;
	/** ISO timestamp of the check run. */
	generatedAt: string;
	/** Flagged pairs, sorted by cellOverlap descending. */
	pairs: PlagiarismPair[];
	/** Total number of unique pairs compared (flagged + below threshold). */
	totalPairs: number;
	/** studentIds included in the comparison, sorted. */
	comparedSubmissions: string[];
	/** True when the semantic (LLM) pass ran and produced scores. */
	semanticChecked?: boolean;
	/** Error detail when status is "error". */
	error?: string;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Absolute path of the plagiarism cache file for an assignment. */
export function getPlagiarismCachePath(assignmentId: string): string {
	assertSafeSegment(assignmentId, "assignmentId");
	return path.join(getDataDir(), "plagiarism", `${assignmentId}.json`);
}

/**
 * Absolute path of the human-readable plagiarism assessment. A single
 * current-assessment file (the check route resolves one assignment per
 * run); the assignment id + timestamp in the header identify its scope.
 */
export function getPlagiarismAssessmentPath(): string {
	return path.join(getDataDir(), "plagiarism", "plagiarism-assessment.md");
}

// ---------------------------------------------------------------------------
// Read / write
// ---------------------------------------------------------------------------

/** Read the cached result; null when absent or corrupt. */
export async function readPlagiarismResult(assignmentId: string): Promise<PlagiarismResult | null> {
	const filePath = getPlagiarismCachePath(assignmentId);
	let raw: string;
	try {
		raw = await readFile(filePath, "utf-8");
	} catch (err) {
		if (isNodeError(err) && err.code === "ENOENT") {
			return null;
		}
		throw err;
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return null;
		}
		return parsed as PlagiarismResult;
	} catch {
		// Corrupt cache — treat as absent; a re-run will overwrite it.
		return null;
	}
}

/** Atomically persist a plagiarism result. */
export async function writePlagiarismResult(
	assignmentId: string,
	result: PlagiarismResult,
): Promise<void> {
	const filePath = getPlagiarismCachePath(assignmentId);
	await mkdir(path.dirname(filePath), { recursive: true });
	const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
	await writeFile(tmpPath, JSON.stringify(result, null, 2), "utf-8");
	await rename(tmpPath, filePath);

	// Keep the human-readable assessment deliverable in sync with the cached
	// JSON. Every writer lands here (the check route plus review-status /
	// archive / delete mutations), so the .md always mirrors the JSON.
	// Best-effort: a markdown write failure must not fail the comparison.
	try {
		await writePlagiarismAssessmentMarkdown(result);
	} catch (err) {
		console.warn(
			`[plagiarism] could not write plagiarism-assessment.md for "${assignmentId}": ${(err as Error).message}`,
		);
	}
}

// ---------------------------------------------------------------------------
// Human-readable assessment (plagiarism-assessment.md)
// ---------------------------------------------------------------------------

/** Format a 0..1 score as a percentage string ("—" when absent). */
function pct(value: number | undefined, digits = 0): string {
	if (value === undefined) return "—";
	return `${(value * 100).toFixed(digits)}%`;
}

/** Compact per-pair matched-cell list ("cell 2 ↔ 5 (98%), …", capped at 10). */
function cellSummary(pair: PlagiarismPair): string {
	const cells = pair.matchedCells.slice(0, 10);
	const parts = cells.map(
		(m) => `cell ${m.cellIndexA + 1} ↔ ${m.cellIndexB + 1} (${pct(m.similarity)})`,
	);
	if (pair.matchedCells.length > 10) {
		parts.push(`… and ${pair.matchedCells.length - 10} more`);
	}
	return parts.join(", ");
}

/**
 * Build the human-readable plagiarism assessment markdown for a cached
 * result: assignment id + timestamp, a flagged-pairs overview table, then
 * a per-pair verdict (structural overlap % + semantic score + combined
 * score + review status). Instructor-only deliverable — separate from the
 * grading JSONs, which must never contain plagiarism language.
 */
export function buildPlagiarismAssessmentMarkdown(result: PlagiarismResult): string {
	const lines: string[] = [];
	lines.push(`# Plagiarism Assessment — ${result.assignmentId}`);
	lines.push("");
	lines.push(`- **Assignment**: ${result.assignmentId}`);
	lines.push(`- **Generated**: ${result.generatedAt}`);
	lines.push(`- **Submissions compared**: ${result.comparedSubmissions.length}`);
	lines.push(`- **Pairs compared**: ${result.totalPairs}`);
	lines.push(`- **Flagged pairs**: ${result.pairs.length}`);
	lines.push(`- **Semantic (LLM) pass**: ${result.semanticChecked ? "run" : "not run"}`);
	if (result.status === "error") {
		lines.push(`- **Status**: error — ${result.error ?? "unknown error"}`);
	}

	if (result.pairs.length === 0) {
		lines.push("");
		lines.push("No flagged pairs — the structural comparison found no plagiarism concerns.");
		return lines.join("\n") + "\n";
	}

	lines.push("");
	lines.push("## Flagged pairs");
	lines.push("");
	lines.push(
		"| # | Student A | Student B | Cell overlap | Notebook overlap | Semantic | Combined | Severity | Review status |",
	);
	lines.push(
		"|---|-----------|-----------|--------------|------------------|----------|----------|----------|---------------|",
	);
	result.pairs.forEach((pair, i) => {
		lines.push(
			`| ${i + 1} | ${pair.studentA} | ${pair.studentB} | ${pct(pair.cellOverlap)} | ${pct(pair.notebookOverlap)} | ${pct(pair.semanticScore, 1)} | ${pct(combinedScore(pair), 1)} | ${classifyPair(pair)} | ${reviewStatusOf(pair)} |`,
		);
	});

	lines.push("");
	result.pairs.forEach((pair, i) => {
		lines.push(`### Pair ${i + 1}: ${pair.studentA} ↔ ${pair.studentB}`);
		lines.push("");
		lines.push(`- **Severity**: ${classifyPair(pair)}`);
		lines.push(
			`- **Cell overlap**: ${pct(pair.cellOverlap)} (${pair.matchedCells.length} matched cell(s))`,
		);
		lines.push(`- **Notebook overlap (Jaccard)**: ${pct(pair.notebookOverlap)}`);
		if (pair.semanticScore !== undefined) {
			lines.push(
				`- **Semantic score**: ${pct(pair.semanticScore, 1)}${
					pair.semanticVerdict ? ` — ${pair.semanticVerdict}` : ""
				}`,
			);
		} else {
			lines.push("- **Semantic score**: not run");
		}
		lines.push(`- **Combined score**: ${pct(combinedScore(pair), 1)}`);
		if (pair.flags.length > 0) {
			lines.push(`- **Flags**: ${pair.flags.join(", ")}`);
		}
		if (pair.details.sharedImports.length > 0) {
			lines.push(`- **Shared imports**: ${pair.details.sharedImports.join(", ")}`);
		}
		if (pair.details.sharedVariableNames.length > 0) {
			lines.push(
				`- **Shared variable names**: ${pair.details.sharedVariableNames.join(", ")}`,
			);
		}
		if (pair.details.sharedComments.length > 0) {
			lines.push(`- **Shared comments**: ${pair.details.sharedComments.join(", ")}`);
		}
		if (pair.matchedCells.length > 0) {
			lines.push(`- **Matched cells**: ${cellSummary(pair)}`);
		}
		lines.push(`- **Review status**: ${reviewStatusOf(pair)}`);
		lines.push("");
	});

	return lines.join("\n").trimEnd() + "\n";
}

/** Atomically write the human-readable assessment markdown. */
export async function writePlagiarismAssessmentMarkdown(result: PlagiarismResult): Promise<void> {
	const filePath = getPlagiarismAssessmentPath();
	await mkdir(path.dirname(filePath), { recursive: true });
	const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
	await writeFile(tmpPath, buildPlagiarismAssessmentMarkdown(result), "utf-8");
	await rename(tmpPath, filePath);
}

/**
 * Set the review status of one pair in the cached result (P3-1) and persist
 * the updated result atomically. The pair is matched by its canonical
 * (studentA, studentB) ordering; the reversed order is accepted too.
 *
 * Returns the updated result, or null when the assignment has no cache or
 * the pair does not exist.
 */
export async function updatePairReviewStatus(
	assignmentId: string,
	studentA: string,
	studentB: string,
	reviewStatus: PairReviewStatus,
): Promise<PlagiarismResult | null> {
	const result = await readPlagiarismResult(assignmentId);
	if (!result) return null;

	const pair = result.pairs.find(
		(p) =>
			(p.studentA === studentA && p.studentB === studentB) ||
			(p.studentA === studentB && p.studentB === studentA),
	);
	if (!pair) return null;

	pair.reviewStatus = reviewStatus;
	await writePlagiarismResult(assignmentId, result);
	return result;
}

/**
 * Set the review status of every pair involving a student (used when a
 * submission is archived: pairs become `ignored`; on restore they become
 * `unreviewed` again so the export guard works as before). Persists the
 * updated result; returns the updated result or null when no cache exists.
 */
export async function setStudentPairReviewStatus(
	assignmentId: string,
	studentId: string,
	reviewStatus: PairReviewStatus,
): Promise<PlagiarismResult | null> {
	const result = await readPlagiarismResult(assignmentId);
	if (!result) return null;

	let changed = false;
	for (const pair of result.pairs) {
		if (pair.studentA === studentId || pair.studentB === studentId) {
			if (pair.reviewStatus !== reviewStatus) {
				pair.reviewStatus = reviewStatus;
				changed = true;
			}
		}
	}
	if (changed) {
		await writePlagiarismResult(assignmentId, result);
	}
	return result;
}

/**
 * Remove every pair involving the given student from a cached result and
 * persist it. Returns the updated result, or null when the assignment has
 * no cache. Used when a submission is permanently deleted.
 */
export async function removeStudentFromPlagiarism(
	assignmentId: string,
	studentId: string,
): Promise<PlagiarismResult | null> {
	const result = await readPlagiarismResult(assignmentId);
	if (!result) return null;

	const before = result.pairs.length;
	result.pairs = result.pairs.filter((p) => p.studentA !== studentId && p.studentB !== studentId);
	if (result.pairs.length === before) {
		return result; // nothing changed — no write needed
	}
	result.comparedSubmissions = result.comparedSubmissions.filter((s) => s !== studentId);
	// Recompute the pair count over the remaining compared set (n choose 2).
	const n = result.comparedSubmissions.length;
	result.totalPairs = (n * (n - 1)) / 2;
	await writePlagiarismResult(assignmentId, result);
	return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
	return err instanceof Error && "code" in err;
}
