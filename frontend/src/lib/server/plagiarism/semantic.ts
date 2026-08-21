/**
 * @file KI Connect semantic plagiarism comparison.
 *
 * Thin wrapper around the existing `$lib/server/ki-connect.ts` client for
 * the LLM pass of the plagiarism check: for pairs flagged by the structural
 * pass, ask the model whether the two submissions solve the assignment the
 * same way, and get a similarity score + verdict.
 *
 * Graceful degradation is the contract: every failure path (no API key,
 * network error, malformed response) returns `null` / `[]` — the structural
 * result stands on its own and the check route never fails because the LLM
 * is unavailable.
 *
 * This module runs only on the SvelteKit server (`$lib/server/`).
 */

import { getKiConnectClient } from "$lib/server/ki-connect";
import { screenStudentContent } from "$lib/server/copilot/screening";

import type { NotebookInput, PlagiarismPair } from "./structural";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of one semantic pair comparison. */
export interface SemanticPairResult {
	studentA: string;
	studentB: string;
	/** 0..1 similarity from the LLM (clamped). */
	semanticScore: number;
	/** Free-text assessment from the LLM. */
	verdict: string;
}

export interface SemanticOptions {
	/** Cap on pairs processed per run (default MAX_SEMANTIC_PAIRS). */
	maxPairs?: number;
	/** Per-notebook character budget for the prompt (default 4000). */
	maxCharsPerNotebook?: number;
	/** Optional assignment description/context for the prompt. */
	assignmentContext?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Pairs are processed in cellOverlap-descending order; this caps LLM cost. */
export const MAX_SEMANTIC_PAIRS = 20;
export const MAX_CHARS_PER_NOTEBOOK = 4000;

const SEMANTIC_SYSTEM_PROMPT = `You are an experienced plagiarism detection assistant for a Scientific Programming course. You are given two student Jupyter notebook submissions for the same assignment. Determine whether the two students solved the assignment in essentially the same way — same approach, same code structure, unusually similar variable names or comments.

This course provides a shared assignment template and code examples, so ignore code that is identical only because it was provided as part of the assignment template. Independently written submissions converging on standard library calls (e.g. numpy, pandas, matplotlib idioms) should NOT be flagged — flag only evidence of copying beyond what the shared template and ordinary standard library usage would naturally produce.

Respond with JSON only, exactly matching this structure:
{
  "similarity": 0.0,
  "verdict": "one or two sentences explaining the assessment",
  "same_approach": true
}

"similarity" must be a number between 0 and 1: how similar the submissions are in approach and structure.`;

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

/** True when a KI Connect API key is configured (the semantic pass is usable). */
export function isSemanticComparisonAvailable(): boolean {
	return (
		typeof process !== "undefined" &&
		typeof process.env.KI_CONNECT_API_KEY === "string" &&
		process.env.KI_CONNECT_API_KEY.length > 0
	);
}

// ---------------------------------------------------------------------------
// Prompt building
// ---------------------------------------------------------------------------

function formatNotebookForPrompt(notebook: NotebookInput, maxChars: number): string {
	const code = notebook.cells
		.filter((cell) => cell.type !== "markdown")
		.map((cell) => cell.source)
		.join("\n# --- cell ---\n");
	if (code.length <= maxChars) return code || "(no code cells)";
	return `${code.slice(0, maxChars)}\n# ... [truncated]`;
}

function buildSemanticPrompt(a: NotebookInput, b: NotebookInput, opts: SemanticOptions): string {
	const context = opts.assignmentContext
		? `Assignment context: ${opts.assignmentContext}\n\n`
		: "";
	const maxChars = opts.maxCharsPerNotebook ?? MAX_CHARS_PER_NOTEBOOK;
	return (
		`${context}Compare the two student submissions below.\n\n` +
		`--- Submission A (${a.studentId}) ---\n${formatNotebookForPrompt(a, maxChars)}\n\n` +
		`--- Submission B (${b.studentId}) ---\n${formatNotebookForPrompt(b, maxChars)}`
	);
}

/**
 * Screen one notebook's prompt payload for instruction-smuggling (injection)
 * BEFORE it enters the semantic LLM prompt. Student notebook content is
 * untrusted input; reusing {@link screenStudentContent} here mirrors the
 * cell-screening the pre-evaluation pipeline already applies.
 *
 * FAIL-OPEN is the contract (same as the rest of this module): a positive
 * "injection" verdict returns true (skip the pair); a screening API error
 * OR an unexpected throw returns false so the semantic pass still proceeds.
 * A guard failure must never block the comparison — only a positive verdict
 * skips the pair.
 */
async function screensAsInjection(nb: NotebookInput, maxChars: number): Promise<boolean> {
	try {
		const verdict = await screenStudentContent(formatNotebookForPrompt(nb, maxChars));
		return verdict === "injection";
	} catch (err) {
		console.warn(
			`[plagiarism] semantic screening failed — failing open for ${nb.studentId}`,
			err instanceof Error ? err.message : err,
		);
		return false;
	}
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

function parseSemanticResponse(
	response: Record<string, unknown>,
	studentA: string,
	studentB: string,
): SemanticPairResult | null {
	const raw = response.similarity;
	if (typeof raw !== "number" || Number.isNaN(raw)) {
		console.warn("[plagiarism] semantic response missing numeric similarity");
		return null;
	}
	const clamped = Math.min(1, Math.max(0, raw));
	return {
		studentA,
		studentB,
		semanticScore: Math.round(clamped * 10_000) / 10_000,
		verdict: typeof response.verdict === "string" ? response.verdict : "",
	};
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compare two submissions semantically via KI Connect.
 * Returns null when the API key is unset, the request fails, the
 * response is malformed (graceful degradation), or when either notebook's
 * content screens as an injection attempt (skip the pair).
 */
export async function compareNotebooks(
	a: NotebookInput,
	b: NotebookInput,
	opts: SemanticOptions = {},
): Promise<SemanticPairResult | null> {
	if (!isSemanticComparisonAvailable()) {
		console.debug("[plagiarism] semantic comparison skipped (no KI_CONNECT_API_KEY)");
		return null;
	}

	try {
		const maxChars = opts.maxCharsPerNotebook ?? MAX_CHARS_PER_NOTEBOOK;
		// Screen each notebook's content before it enters the LLM. Untrusted
		// student input must not reach the semantic prompt unscreened. A
		// positive injection verdict on EITHER notebook skips the pair (the
		// structural result stands); screening failures degrade to proceeding.
		if (await screensAsInjection(a, maxChars)) {
			console.warn(`[plagiarism] semantic pair skipped: injection detected in ${a.studentId}`);
			return null;
		}
		if (await screensAsInjection(b, maxChars)) {
			console.warn(`[plagiarism] semantic pair skipped: injection detected in ${b.studentId}`);
			return null;
		}

		const response = await getKiConnectClient().chatCompletion(
			SEMANTIC_SYSTEM_PROMPT,
			buildSemanticPrompt(a, b, opts),
			0.0,
			{ type: "json_object" },
		);
		return parseSemanticResponse(response, a.studentId, b.studentId);
	} catch (err) {
		console.error("[plagiarism] semantic comparison failed:", err);
		return null;
	}
}

/**
 * Run the semantic pass over flagged pairs (top `maxPairs`, in the given
 * order — callers pass the cellOverlap-descending flagged list). Returns
 * results only for pairs that were actually compared; pairs are skipped
 * (not failed) when their notebook cannot be found in `notebooks`.
 */
export async function runSemanticPass(
	pairs: PlagiarismPair[],
	notebooks: Map<string, NotebookInput>,
	opts: SemanticOptions = {},
): Promise<SemanticPairResult[]> {
	if (!isSemanticComparisonAvailable() || pairs.length === 0) return [];

	const maxPairs = opts.maxPairs ?? MAX_SEMANTIC_PAIRS;
	const results: SemanticPairResult[] = [];
	for (const pair of pairs.slice(0, maxPairs)) {
		const a = notebooks.get(pair.studentA);
		const b = notebooks.get(pair.studentB);
		if (!a || !b) continue;
		const result = await compareNotebooks(a, b, opts);
		if (result) results.push(result);
	}
	return results;
}

/**
 * Merge semantic results back into structural pairs (new objects; the
 * input pairs are not mutated). Pairs without a semantic result are
 * returned unchanged.
 */
export function mergeSemanticResults(
	pairs: PlagiarismPair[],
	results: SemanticPairResult[],
): PlagiarismPair[] {
	if (results.length === 0) return pairs;
	const byKey = new Map(results.map((r) => [`${r.studentA}\u0000${r.studentB}`, r]));
	return pairs.map((pair) => {
		const result = byKey.get(`${pair.studentA}\u0000${pair.studentB}`);
		return result
			? { ...pair, semanticScore: result.semanticScore, semanticVerdict: result.verdict }
			: pair;
	});
}
