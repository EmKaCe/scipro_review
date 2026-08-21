/**
 * @file Phase execution for the pre-evaluation pipeline (extracted from
 * pre-evaluation.ts — Wave 0, pure structural move; no behavior change).
 * Per-phase KI Connect calls (callPhase, callCategoryTurn), the Phase 1
 * marker-chunking loop, the turn-based rubric selection protocol (Phase 2b),
 * and the balanced-criteria diagnostics.
 */

import { getKiConnectClient } from "$lib/server/ki-connect";
import { getAssignmentById } from "$lib/server/assignments";
import { loadCriteriaFile, loadCriteriaForAssignment } from "$lib/server/criteria";
import { assertSafeSegment } from "$lib/server/metadata";
import { appendPreEvalLog } from "$lib/server/pre-eval-logs";
import { readResults, type StoredExecutionResult } from "$lib/server/results-store";
import { loadSettings } from "$lib/server/settings";
import type { ExecutedCell } from "$lib/server/executor-client";
import {
	generateWorksheet,
	MUTUAL_EXCLUSION_PAIRS,
	validateWorksheetSection,
	type MutualExclusionPair,
	type WorksheetValidationError,
} from "$lib/server/copilot/worksheet";
import { analyzeSubmission, type PreAnalysis } from "$lib/server/copilot/pre-analysis";
import type { Category, MergedRubric, Sentiment } from "$lib/types/criteria";
// Type-only import (erased at runtime) — the wire types stay defined in
// pre-evaluation.ts; this module only consumes them.
import type { PreEvaluationMarker } from "../pre-evaluation";
import { PHASE1_MARKERS_PROMPT, TURN_BASED_SYSTEM_PROMPT, modelHintBlock } from "./prompts";
import {
	MAX_PREVIEW_CELLS,
	SOURCE_PREVIEW_LINES,
	SOURCE_TRUNCATION_MARKER,
	buildPhase1UserPrompt,
	formatPreAnalysis,
	type Phase1Context,
} from "./context";

/**
 * Phase 1 chunk size: notebooks with more cells than this get their Phase 1
 * marker call split into sequential chunks of at most this many cells, so
 * each call stays within the token/time budget (large notebooks previously
 * timed out at the 60s default).
 */
export const CHUNK_SIZE = 20;
/**
 * Per-call LLM timeout for this pipeline. The generic `llm.timeout_ms`
 * setting (60s default) is too tight for whole-notebook analysis; this is
 * the fallback when the setting is not configured.
 */
export const PRE_EVALUATION_LLM_TIMEOUT_MS = 120_000;

/**
 * Normalize a chunk-returned marker's `cell_index` to the absolute notebook
 * index. The chunk prompt instructs ABSOLUTE indices, but some models still
 * answer relative to the chunk — values that fall inside the chunk's own
 * 0-based range are offset by the chunk start. Indices outside both ranges
 * are dropped (null) rather than corrupting the merged list.
 */
export function toAbsoluteMarker(
	marker: PreEvaluationMarker,
	chunkStart: number,
	chunkLength: number,
): PreEvaluationMarker | null {
	const idx = marker.cell_index;
	if (idx >= chunkStart && idx < chunkStart + chunkLength) {
		return marker; // already absolute
	}
	if (idx >= 0 && idx < chunkLength) {
		return { ...marker, cell_index: idx + chunkStart }; // relative to the chunk
	}
	console.warn(
		`[pre-eval] dropping Phase 1 marker with out-of-range cell_index ${idx} (chunk covers cells ${chunkStart}..${chunkStart + chunkLength - 1})`,
	);
	return null;
}

/**
 * Phase 1 marker call for one submission: a single call for notebooks at or
 * below CHUNK_SIZE, or sequential chunks for larger notebooks. Chunks run
 * SEQUENTIALLY (parallel calls would hammer the API and risk rate limits);
 * a chunk failure fails the entire Phase 1. Markers are merged with
 * absolute cell_index values.
 */
export async function runPhase1Markers(args: {
	phase1Context: Phase1Context;
	cells: ExecutedCell[];
	submissionId: string;
	assignmentId: string;
	llmTimeoutMs: number;
}): Promise<{ markers: PreEvaluationMarker[] | null }> {
	const { phase1Context, cells, submissionId, assignmentId, llmTimeoutMs } = args;

	if (cells.length <= CHUNK_SIZE) {
		// Small notebooks: single Phase 1 call (existing behavior).
		return callPhase<{ markers: PreEvaluationMarker[] | null }>(
			PHASE1_MARKERS_PROMPT + modelHintBlock(),
			buildPhase1UserPrompt(phase1Context, cells),
			submissionId,
			assignmentId,
			"Phase 1 (markers)",
			llmTimeoutMs,
		);
	}

	// Large notebooks: split Phase 1 into sequential chunks so each call
	// stays within the token/time budget. Chunks run SEQUENTIALLY
	// (parallel calls would hammer the API and risk rate limits); a
	// chunk failure fails the entire Phase 1. Markers are merged with
	// absolute cell_index values.
	const chunkCount = Math.ceil(cells.length / CHUNK_SIZE);
	const mergedMarkers: PreEvaluationMarker[] = [];
	for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex++) {
		const chunkStart = chunkIndex * CHUNK_SIZE;
		const chunkCells = cells.slice(chunkStart, chunkStart + CHUNK_SIZE);
		const chunkResult = await callPhase<{ markers: PreEvaluationMarker[] | null }>(
			PHASE1_MARKERS_PROMPT + modelHintBlock(),
			buildPhase1UserPrompt(phase1Context, chunkCells, {
				index: chunkIndex,
				count: chunkCount,
				start: chunkStart,
			}),
			submissionId,
			assignmentId,
			`Phase 1 (markers chunk ${chunkIndex + 1}/${chunkCount})`,
			llmTimeoutMs,
		);
		if (chunkResult.markers) {
			for (const marker of chunkResult.markers) {
				if (marker == null) continue;
				const absolute = toAbsoluteMarker(marker, chunkStart, chunkCells.length);
				if (absolute !== null) mergedMarkers.push(absolute);
			}
		}
	}
	return { markers: mergedMarkers };
}

/**
 * Call KI Connect for one pipeline phase. Returns the parsed JSON.
 * Throws a descriptive Error on failure.
 */
export async function callPhase<T>(
	systemPrompt: string,
	userPrompt: string,
	submissionId: string,
	assignmentId: string,
	phaseLabel: string,
	timeoutMs?: number,
	model?: string,
	temperature: number = 0.2,
): Promise<T> {
	const call = () =>
		getKiConnectClient().chatCompletion(
			systemPrompt,
			userPrompt,
			temperature,
			{ type: "json_object" },
			undefined,
			timeoutMs,
			model,
		);

	let raw: unknown;
	try {
		raw = await call();
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		const fail = () =>
			new Error(
				`${phaseLabel} KI Connect call failed for "${submissionId}" (assignment "${assignmentId}"): ${detail}`,
				{ cause: err },
			);
		// Timeouts are transient (60s HTTP budget) — one retry after 2s is
		// cheap insurance. Non-timeout errors (auth, empty responses, ...)
		// fail identically on retry, so they throw immediately.
		if (detail.includes("timed out")) {
			console.warn(
				`[pre-eval] ${phaseLabel} timed out for "${submissionId}", retrying once...`,
			);
			await new Promise((resolve) => setTimeout(resolve, 2000));
			try {
				raw = await call();
			} catch {
				// Retry failed too — surface the ORIGINAL error, not the retry's.
				throw fail();
			}
		} else {
			throw fail();
		}
	}
	if (raw === null || raw === undefined) {
		throw new Error(
			`${phaseLabel} returned nothing for "${submissionId}" (assignment "${assignmentId}")`,
		);
	}
	// Simple duck-type validation — the caller handles full Zod + semantic checks
	if (typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error(
			`${phaseLabel} returned non-object for "${submissionId}" (assignment "${assignmentId}"): ${typeof raw}`,
		);
	}
	return raw as T;
}

// ---------------------------------------------------------------------------
// Turn-based rubric selection (Phase 2b)
// ---------------------------------------------------------------------------

/** Escape a literal string for use inside a RegExp. */
function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Index of the first line whose `## Rubric:` header names `key`, or -1.
 * Tolerates the em-dash and hyphen title separators (and a dropped title).
 */
function findRubricSectionStart(lines: string[], key: string): number {
	const pattern = new RegExp(`^## Rubric:\\s*${escapeRegExp(key)}(?:\\s|$)`);
	return lines.findIndex((line) => pattern.test(line));
}

/** One rubric category's section (its `## Rubric: {key}` header + body). */
function extractCategorySection(markdown: string, key: string): string | null {
	const lines = markdown.split("\n");
	const start = findRubricSectionStart(lines, key);
	if (start === -1) return null;
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		if (/^## /.test(lines[i]!)) {
			end = i;
			break;
		}
	}
	const section = lines.slice(start, end).join("\n");
	return section.length > 0 ? section : null;
}

/**
 * Replace one category's section in the living worksheet with the edited
 * section the model returned. The old section is located by its `## Rubric:
 * {key}` header (the same boundary logic as {@link extractCategorySection})
 * and swapped for the new one, so the rest of the worksheet — the `## Context`
 * block and every other category's section — is preserved verbatim.
 */
function replaceCategorySection(markdown: string, key: string, newSection: string): string {
	const lines = markdown.split("\n");
	const start = findRubricSectionStart(lines, key);
	if (start === -1) return markdown;
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		if (/^## /.test(lines[i]!)) {
			end = i;
			break;
		}
	}
	const replacement = newSection.trimEnd();
	const before = lines.slice(0, start).join("\n");
	const after = lines.slice(end).join("\n");
	// Keep exactly one blank line between the replaced section and the next
	// section (the generator emits `section\n\n## ...`).
	return `${before.trimEnd()}\n\n${replacement}\n\n${after.trimStart()}`;
}

/**
 * Build the user prompt for one category turn: the full living worksheet as
 * context (so the model sees adjacent decisions), the deterministic
 * pre-analysis facts, a bounded preview of the notebook source (the
 * EVIDENCE the model must verify sub-points against), and a highlighted
 * instruction to fill ONLY the requested category's section.
 */
function buildCategoryUserPrompt(args: {
	worksheet: string;
	categoryKey: string;
	categoryTitle: string;
	preAnalysis: PreAnalysis;
	cells: readonly ExecutedCell[];
	autofixBlock?: string | null;
}): string {
	const { worksheet, categoryKey, categoryTitle, preAnalysis, cells, autofixBlock } = args;
	// Deterministic import facts for code_formatting decisions: the whole-list
	// alphabetization verdict and any disallowed libraries found. These are
	// computed facts, not model guesses — the model must align its import
	// sub-point checks with them.
	const importFacts: string[] = [];
	if (categoryKey === "code_formatting") {
		importFacts.push(
			`- Imports alphabetized (whole-list check): ${preAnalysis.importsAlphabetized ? "yes" : "NO"}`,
		);
		if (preAnalysis.disallowedImports.length > 0) {
			importFacts.push(
				`- Disallowed imports found: ${preAnalysis.disallowedImports.join(", ")}`,
			);
		}
	}
	// Category-specific selection guidance. The universal block fights
	// over-ticking (checking every applicable-looking item instead of only
	// the items the submission visibly demonstrates); the plotting block
	// demands internal consistency between positives and their missing-
	// element negatives; the general_feedback block calibrates the overall
	// rating against the rest of the worksheet.
	const categoryGuidance: string[] = [];
	if (categoryKey === "plotting_visualization") {
		categoryGuidance.push(
			"- EVIDENCE SELECTIVITY: check a detail item ONLY when the notebook's plotting code or output visibly demonstrates it. Do not check every plot detail (color, line style, line thickness, point style, font size, ...) just because the submission contains plots — the professor checks only the details the plots actually get right, not the full list.",
			"- OVERALL-FIRST: check the OVERALL quality items first (General: choices behind the plot(s) were well done, Color palette: well chosen, matplotlib: good usage) when the plots are well-made; only then add detail items (axis labels, legend, title, units) with explicit evidence. Do not check color/line style/line thickness/point style unless the submission clearly varies them meaningfully.",
			"- INTERNAL CONSISTENCY: a negative like 'Axis Labels: One or two axis lables are missing or incomplete', 'Title: Plot title is missing', or 'Units: Missing on axis labels or title' must NOT be checked when the corresponding positive ('axis labels', 'title', 'including units') is checked — unless the source shows explicit, contradictory evidence (e.g. some plots labeled and others not). Pick the side the majority of plots support.",
		);
	} else if (categoryKey === "coding_concept") {
		categoryGuidance.push(
			"- BUILTIN SELECTIVITY: check a built-in function or data structure ONLY when it is used in a non-trivial way (e.g. sorted() with a key, zip() to iterate two lists). Do not check every builtin that appears once — a single passing mention or a trivial one-off use is not enough.",
		);
	} else if (["numpy", "pandas", "scipy", "sklearn"].includes(categoryKey)) {
		categoryGuidance.push(
			"- CORE USAGE: for this assignment-specific category, check the positive core items (abbreviation, vectorization, functions, types, data loading) when the code demonstrates them — do NOT skip them just because the submission is 'average'. A submission that uses the library at all deserves its core positives checked; the professor checks NumPy abbreviation/vectorization on most submissions that use NumPy.",
		);
	} else if (categoryKey === "general_feedback") {
		categoryGuidance.push(
			"- RATING CALIBRATION: the overall rating must reflect the dimension scores and the other rubric selections. 'excellent'/'very good'/'good' are for submissions whose other categories are checked mostly positive; if notable weaknesses are flagged elsewhere in the worksheet (negative selections, low dimension scores), choose 'okay  - there is notable room for improvement' instead of 'good'. Do not inflate the overall rating.",
		);
	}
	return [
		worksheet,
		"",
		"---",
		"",
		formatPreAnalysis(preAnalysis),
		...(importFacts.length > 0
			? [
					"",
					"Import facts (deterministic — verify against the source, do not contradict):",
					...importFacts,
				]
			: []),
		"",
		"---",
		"",
		"Notebook source (EVIDENCE — verify every checkbox against this):",
		...formatCellSourcePreview(cells),
		// Autofix note: when the pipeline produced a verified clean re-run the
		// cell-bearing phases grade downstream cells on the fixed output (the
		// same block the Phase 2a scorer sees — kept byte-consistent). Absent
		// for clean submissions, so the category-turn prompts are unchanged.
		...(autofixBlock ? ["", autofixBlock] : []),
		"",
		"---",
		"",
		"EVIDENCE SELECTIVITY: check an item ONLY when the notebook clearly demonstrates it. Do not check every applicable-looking item — every checked item must be visibly supported by the code/markdown. For detail lists (built-in functions, data structures, plot details), check only the items the submission actually uses; do not pad the list.",
		"CORE-FIRST: for each category, FIRST identify the 2-4 CORE items the submission clearly demonstrates (e.g. for NumPy: abbreviation `np`, vectorization, `np.exp` usage; for plotting: overall quality, axis labels, legend, title) and check those, THEN only add detail items with explicit evidence. A submission that clearly demonstrates a core item must have that core positive checked — never skip the core positives and pad the details instead. For assignment-specific categories (NumPy, Pandas, SciPy, sklearn), check the core usage items first — abbreviation, vectorization, built-in function usage, data loading — before any detail items. A submission that uses the library at all deserves its core positives checked.",
		...(categoryGuidance.length > 0 ? ["", ...categoryGuidance] : []),
		"",
		`Fill ONLY the \`## Rubric: ${categoryKey} — ${categoryTitle}\` section. Return the complete edited section for this category only, from \`## Rubric:\` through \`### Additional Notes\`. Preserve all un-checked items verbatim — only change \`[ ]\` to \`[x]\`.`,
	].join("\n");
}

/**
 * Format a bounded preview of the notebook source for the category-turn
 * prompt: one `[Cell N] type` block per cell, source lines capped at
 * {@link SOURCE_PREVIEW_LINES} per cell and {@link MAX_PREVIEW_CELLS} cells
 * total (the same bounds as the Phase 1 prompt). Markdown cells are shown
 * too — they carry the interpretation and citation evidence. Cells whose
 * source is empty are skipped.
 */
function formatCellSourcePreview(cells: readonly ExecutedCell[]): string[] {
	const lines: string[] = [];
	for (const cell of cells.slice(0, MAX_PREVIEW_CELLS)) {
		const source = cell.source ?? "";
		if (source.trim().length === 0) continue;
		const sourceLines = source.split("\n");
		const preview =
			sourceLines.length > SOURCE_PREVIEW_LINES
				? `${sourceLines.slice(0, SOURCE_PREVIEW_LINES).join("\n")}${SOURCE_TRUNCATION_MARKER}`
				: source;
		lines.push(`[Cell ${cell.index}] ${cell.type}`);
		lines.push("```python");
		lines.push(preview);
		lines.push("```");
	}
	return lines;
}

/**
 * Build the retry prompt for a failed category turn: the returned section
 * plus the exact validation error messages, with one concrete instruction
 * per error.
 */
function buildRetryPrompt(args: {
	returnedSection: string;
	errors: WorksheetValidationError[];
}): string {
	const { returnedSection, errors } = args;
	const mutualExclusionHints = errors
		.filter((error) => error.type === "mutual_exclusion")
		.map((error) => {
			const [a, b] = error.items ?? [];
			return `- ${error.message} Check the side the notebook source supports: if the imports are NOT alphabetized in the source, keep "${b}" and uncheck "${a}"; if they ARE alphabetized, keep "${a}" and uncheck "${b}".`;
		});
	return [
		"The section you returned did not pass validation. Fix the issues below and return the COMPLETE corrected section (from `## Rubric:` through `### Additional Notes`), preserving every un-checked item verbatim.",
		"",
		"Your previous section:",
		"```markdown",
		returnedSection,
		"```",
		"",
		"Validation errors:",
		...errors.map((error, index) => `- ${index + 1}. ${error.message}`),
		...(mutualExclusionHints.length > 0
			? ["", "How to fix the mutual-exclusion error(s):", ...mutualExclusionHints]
			: []),
		"",
		"Return ONLY the corrected markdown section.",
	].join("\n");
}

/**
 * Maximum validation retries per category. The retry loop IS the
 * verification — there is no separate verify/critique pass on rubric
 * selection.
 */
const MAX_RETRIES = 3;

/**
 * Whether the line is a real import statement (`import X` / `from X import
 * Y`). Markdown prose like "from a cluster centre" must not count.
 */
function isImportLine(line: string): boolean {
	return /^(import\s+\S|from\s+\S+\s+import\s+\S)/.test(line.trim());
}

/**
 * Whether the notebook's imports are alphabetized as ONE list (all `import`
 * and `from` lines together, case-insensitive). The pre-analysis heuristic
 * sorts from- and import-blocks separately, which hides the real ordering —
 * this is the ground-truth definition.
 */
function importsAreAlphabetized(cells: readonly ExecutedCell[]): boolean {
	const importLines: string[] = [];
	for (const cell of cells) {
		if (cell.type !== "code") continue;
		for (const line of (cell.source ?? "").split("\n")) {
			if (isImportLine(line)) importLines.push(line.trim());
		}
	}
	if (importLines.length <= 1) return true;
	const sorted = [...importLines].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
	return importLines.every((line, i) => line === sorted[i]);
}

/**
 * Whether all import statements are confined to the notebook's top —
 * specifically the first two code cells (the conventional import block).
 * Imports scattered into later cells fail the check.
 */
function importsListedAtTop(cells: readonly ExecutedCell[]): boolean {
	let codeCellRank = 0;
	let lastImportCodeCellRank = 0;
	let importCellCount = 0;
	for (const cell of cells) {
		if (cell.type !== "code") continue;
		codeCellRank++;
		const hasImport = (cell.source ?? "").split("\n").some((line) => isImportLine(line));
		if (hasImport) {
			importCellCount++;
			lastImportCodeCellRank = codeCellRank;
		}
	}
	if (importCellCount === 0) return true;
	return lastImportCodeCellRank <= 2;
}

/**
 * Whether any code cell contains a double blank line followed by indented
 * code — PEP8 E303 ("too many blank lines within a function body"). The
 * ground-truth note for 2026SS_00 cites exactly this defect in the plume
 * function.
 */
function hasE303DoubleBlankLine(cells: readonly ExecutedCell[]): boolean {
	const E303_RE = /\n\n\n[ \t]{4,}\S/;
	return cells.some((cell) => E303_RE.test(cell.source ?? ""));
}

/**
 * Decide which side of a mutual-exclusion pair the notebook evidence
 * supports when the model left BOTH sides unchecked. Returns "a" (the
 * positive side) or "b" (the negative side), or null when the evidence
 * actively contradicts the positive without supporting that particular
 * negative — in that case neither side is force-checked (the deterministic
 * E303 uncheck already settled the aspect).
 */
function decideMutualExclusionSide(
	pair: MutualExclusionPair,
	cells: readonly ExecutedCell[],
	preAnalysis: PreAnalysis,
): "a" | "b" | null {
	const { a, b } = pair;

	// Import ordering — whole-list alphabetization (ground-truth definition).
	if (
		a === "imports - libraries were alphabetized" ||
		b === "imports - libraries were alphabetized"
	) {
		return importsAreAlphabetized(cells) ? "a" : "b";
	}

	// Import placement — all imports in the first two code cells → positive.
	if (
		a === "imports - libraries were listed at the notebook's top" ||
		b === "imports - libraries were listed at the notebook's top"
	) {
		return importsListedAtTop(cells) ? "a" : "b";
	}

	// Blank lines — an E303 double blank line is a concrete counterexample
	// to the positive. It supports ONLY the "too many" negative; the other
	// negatives (missing two blank lines, not enough separation) are not
	// supported by that evidence, so those pairs stay undecided.
	if (b.startsWith("blank lines -")) {
		if (!hasE303DoubleBlankLine(cells)) return "a";
		return b === "blank lines - too many used (i.e., not concise)" ? "b" : null;
	}

	// Naming — non-descriptive names found in the source → negative.
	if (b.startsWith("naming -")) {
		return preAnalysis.nonDescriptiveNames.length > 0 ? "b" : "a";
	}

	// PEP8 — an E303 violation contradicts the positive, but the E303 rule
	// below already force-unchecks it and a single defect does not warrant
	// "PEP8 - not well followed", so neither side is force-checked.
	if (a === "PEP8 guidelines- followed") {
		return hasE303DoubleBlankLine(cells) ? null : "a";
	}

	// No dedicated evidence — prefer the positive side.
	return "a";
}

/**
 * Deterministic post-validation correction for a category section, local to
 * the turn-based protocol (the brief's allowed correction step). After the
 * model's section validates cleanly, evidence-grounded rules fix the failure
 * modes qwen3-30b repeatedly exhibits:
 *
 * 1. E303 double blank line in the source (code_formatting only) →
 *    force-uncheck "blank lines - consistent and good usage" and "PEP8
 *    guidelines- followed" (a single clear counterexample disqualifies the
 *    positive).
 * 2. Any mutual-exclusion pair with NEITHER side checked → force-check the
 *    side the notebook evidence supports (imports ordering/placement,
 *    blank lines, naming; the positive side by default). Categories with
 *    no configured pairs are untouched.
 *
 * Only known rubric texts are touched; the section is re-validated by the
 * caller after correction.
 */
function applyDeterministicSectionCorrections(
	section: string,
	categoryKey: string,
	cells: readonly ExecutedCell[],
	preAnalysis: PreAnalysis,
): string {
	const uncheck = new Set<string>();
	const check = new Set<string>();

	// E303 rule — code_formatting only. A double blank line inside a
	// function body is a concrete PEP8 E303 violation: the blank-lines and
	// PEP8 positives must never stay checked in its presence.
	if (categoryKey === "code_formatting" && hasE303DoubleBlankLine(cells)) {
		uncheck.add("blank lines - consistent and good usage");
		uncheck.add("PEP8 guidelines- followed");
	}

	// Mutual-exclusion fallback — every configured pair of the category. A
	// pair the model left fully unchecked gets the side the evidence
	// supports.
	const checkedTexts = new Set<string>();
	for (const line of section.split("\n")) {
		const match = line.match(/^-\s*\[[xX]\]\s*(.+)$/);
		if (match) checkedTexts.add(match[1]!.trim());
	}
	for (const pair of MUTUAL_EXCLUSION_PAIRS[categoryKey] ?? []) {
		if (checkedTexts.has(pair.a) || checkedTexts.has(pair.b)) continue;
		const side = decideMutualExclusionSide(pair, cells, preAnalysis);
		if (side === null) continue;
		check.add(side === "a" ? pair.a : pair.b);
	}

	if (uncheck.size === 0 && check.size === 0) return section;

	const lines = section.split("\n");
	const corrected = lines.map((line) => {
		const checkedMatch = line.match(/^(-\s*\[)[xX](\]\s*)(.+)$/);
		if (checkedMatch && uncheck.has(checkedMatch[3]!.trim())) {
			return `${checkedMatch[1]} ${checkedMatch[2]}${checkedMatch[3]}`;
		}
		const uncheckedMatch = line.match(/^(-\s*\[) (\]\s*)(.+)$/);
		if (uncheckedMatch && check.has(uncheckedMatch[3]!.trim())) {
			return `${uncheckedMatch[1]}x${uncheckedMatch[2]}${uncheckedMatch[3]}`;
		}
		return line;
	});
	const correctedSection = corrected.join("\n");
	if (correctedSection === section) return section;

	const details: string[] = [];
	if (check.size > 0) details.push(`checked: ${[...check].join("; ")}`);
	if (uncheck.size > 0) details.push(`unchecked: ${[...uncheck].join("; ")}`);
	console.warn(
		`[pre-eval] Rubric category "${categoryKey}" corrected deterministically (${details.join(", ")}).`,
	);
	return correctedSection;
}

/**
 * Run the turn-based rubric selection protocol: one category per LLM call,
 * each returning the EDITED markdown section for that category, validated
 * against the rubric. On validation failure the returned section plus the
 * exact errors are sent back to the same model (up to {@link MAX_RETRIES});
 * only a section that parses cleanly is merged into the living worksheet.
 *
 * A category that still fails after all retries is flagged in
 * `additionalNotes` with a "[needs review]" marker and the selections the
 * last attempt produced that are valid are kept — the envelope is always
 * assembled, never thrown.
 */
export async function runTurnBasedRubricSelection(args: {
	worksheet: string;
	rubric: MergedRubric;
	submissionId: string;
	assignmentId: string;
	llmTimeoutMs: number;
	preAnalysis: PreAnalysis;
	cells: readonly ExecutedCell[];
	model?: string;
	temperature?: number;
	/** Autofix note injected into every category-turn prompt (optional). */
	autofixBlock?: string | null;
}): Promise<{
	rubricSelections: { categoryKey: string; optionKey: string }[];
	additionalNotes: Record<string, string>;
}> {
	const { rubricSelections, additionalNotes } = await runTurnBasedCategoryTurns(args);
	return { rubricSelections, additionalNotes };
}

/**
 * The per-category turn loop shared by {@link runTurnBasedRubricSelection}
 * (all categories) and {@link runTurnBasedCategoryMilestone} (one category).
 * Returns the LIVING worksheet (with every clean section merged) alongside
 * the accumulated selections and notes, so the milestone can hand back the
 * final section for its single category.
 */
async function runTurnBasedCategoryTurns(args: {
	worksheet: string;
	rubric: MergedRubric;
	submissionId: string;
	assignmentId: string;
	llmTimeoutMs: number;
	preAnalysis: PreAnalysis;
	cells: readonly ExecutedCell[];
	model?: string;
	temperature?: number;
	categoryKeys?: readonly string[];
	/** Autofix note injected into every category-turn prompt (optional). */
	autofixBlock?: string | null;
}): Promise<{
	worksheet: string;
	rubricSelections: { categoryKey: string; optionKey: string }[];
	additionalNotes: Record<string, string>;
}> {
	const {
		worksheet: initialWorksheet,
		rubric,
		submissionId,
		assignmentId,
		llmTimeoutMs,
		preAnalysis,
		cells,
		model,
		temperature = 0.2,
		categoryKeys,
		autofixBlock,
	} = args;

	const rubricSelections: { categoryKey: string; optionKey: string }[] = [];
	const additionalNotes: Record<string, string> = {};
	let worksheet = initialWorksheet;

	const systemPrompt = TURN_BASED_SYSTEM_PROMPT + modelHintBlock(model);

	const keys = categoryKeys ?? rubric.categories.map((entry) => entry.key);
	for (const categoryKey of keys) {
		const entry = rubric.categories.find((candidate) => candidate.key === categoryKey);
		if (!entry) continue;
		const categoryTitle = entry.category.title;

		const userPrompt = buildCategoryUserPrompt({
			worksheet,
			categoryKey,
			categoryTitle,
			preAnalysis,
			cells,
			autofixBlock,
		});

		let returnedSection = await callCategoryTurn({
			systemPrompt,
			userPrompt,
			submissionId,
			assignmentId,
			phaseLabel: `Rubric category "${categoryKey}"`,
			llmTimeoutMs,
			model,
			temperature,
		});

		let validation = validateWorksheetSection(returnedSection, categoryKey, rubric);

		let attempt = 0;
		while (!validation.ok && attempt < MAX_RETRIES) {
			attempt++;
			console.warn(
				`[pre-eval] Rubric category "${categoryKey}" failed validation (attempt ${attempt}/${MAX_RETRIES}) for "${submissionId}" — retrying with ${validation.errors.length} error(s).`,
			);
			returnedSection = await callCategoryTurn({
				systemPrompt,
				userPrompt: buildRetryPrompt({
					returnedSection,
					errors: validation.errors,
				}),
				submissionId,
				assignmentId,
				phaseLabel: `Rubric category "${categoryKey}" retry ${attempt}`,
				llmTimeoutMs,
				model,
				temperature,
			});
			validation = validateWorksheetSection(returnedSection, categoryKey, rubric);
		}

		if (!validation.ok) {
			// Flag the category for the teacher and keep whatever the last
			// attempt produced that IS valid. Never throw — the envelope must
			// still be assembled.
			const errorSummary = validation.errors.map((error) => error.message).join("; ");
			additionalNotes[categoryKey] = `[needs review] validation failed: ${errorSummary}`;
			console.warn(
				`[pre-eval] Rubric category "${categoryKey}" still invalid after ${MAX_RETRIES} retries for "${submissionId}" (assignment "${assignmentId}") — flagged for review.`,
			);
		} else {
			// Evidence-grounded deterministic correction (see
			// applyDeterministicSectionCorrections): fixes the two failure
			// modes qwen3-30b repeatedly exhibits even on clean sections —
			// checking blank-lines/PEP8 positives despite an E303 double
			// blank line, and leaving a mutual-exclusion pair unchecked.
			// The corrected section is re-validated before merging; if the
			// correction itself ever produced an invalid section (it
			// cannot — it only toggles known rubric texts), the original
			// clean section is kept.
			const correctedSection = applyDeterministicSectionCorrections(
				returnedSection,
				categoryKey,
				cells,
				preAnalysis,
			);
			if (correctedSection !== returnedSection) {
				const correctedValidation = validateWorksheetSection(
					correctedSection,
					categoryKey,
					rubric,
				);
				if (correctedValidation.ok) {
					returnedSection = correctedSection;
					validation = correctedValidation;
					console.warn(
						`[pre-eval] Rubric category "${categoryKey}" corrected deterministically for "${submissionId}" (deterministic evidence).`,
					);
				}
			}
			// Merge the clean section into the living worksheet and accumulate.
			worksheet = replaceCategorySection(worksheet, categoryKey, returnedSection);
		}

		// Accumulate whatever selections/notes the final attempt produced that
		// are valid (empty on a fully failed category).
		rubricSelections.push(...validation.selections);
		if (validation.notes !== null && !(categoryKey in additionalNotes)) {
			additionalNotes[categoryKey] = validation.notes;
		}
	}

	return { worksheet, rubricSelections, additionalNotes };
}

/**
 * Call KI Connect for ONE category turn. The response is free-form markdown
 * (the edited worksheet section), so this helper uses the client's raw-text
 * path (`chatCompletionText`) — the JSON path would mangle markdown. Shares
 * the same timeout-retry semantics as {@link callPhase}.
 */
async function callCategoryTurn(args: {
	systemPrompt: string;
	userPrompt: string;
	submissionId: string;
	assignmentId: string;
	phaseLabel: string;
	llmTimeoutMs: number;
	model?: string;
	temperature?: number;
}): Promise<string> {
	const {
		systemPrompt,
		userPrompt,
		submissionId,
		assignmentId,
		phaseLabel,
		llmTimeoutMs,
		model,
		temperature = 0.2,
	} = args;

	const call = () =>
		getKiConnectClient().chatCompletionText(
			systemPrompt,
			userPrompt,
			temperature,
			llmTimeoutMs,
			model,
		);

	let raw: string;
	try {
		raw = await call();
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		const fail = () =>
			new Error(
				`${phaseLabel} KI Connect call failed for "${submissionId}" (assignment "${assignmentId}"): ${detail}`,
				{ cause: err },
			);
		// Timeouts are transient (60s HTTP budget) — one retry after 2s is
		// cheap insurance. Non-timeout errors (auth, empty responses, ...)
		// fail identically on retry, so they throw immediately.
		if (detail.includes("timed out")) {
			console.warn(
				`[pre-eval] ${phaseLabel} timed out for "${submissionId}", retrying once...`,
			);
			await new Promise((resolve) => setTimeout(resolve, 2000));
			try {
				raw = await call();
			} catch {
				// Retry failed too — surface the ORIGINAL error, not the retry's.
				throw fail();
			}
		} else {
			throw fail();
		}
	}
	if (raw === null || raw === undefined || raw.trim() === "") {
		throw new Error(
			`${phaseLabel} returned nothing for "${submissionId}" (assignment "${assignmentId}")`,
		);
	}
	return raw;
}

/**
 * Run the turn-based rubric selection protocol for ONE category, standalone.
 * Loads the stored execution result, runs pre-analysis, loads the rubric,
 * generates the worksheet, and runs the per-category protocol for the single
 * requested category. Returns the final worksheet section plus metadata —
 * used by the standalone milestone runner (Wave 2).
 */
export async function runTurnBasedCategoryMilestone(args: {
	submissionId: string;
	assignmentId: string;
	categoryKey: string;
	llmTimeoutMs?: number;
	model?: string;
	temperature?: number;
}): Promise<{
	worksheetSection: string;
	rubricSelections: { categoryKey: string; optionKey: string }[];
	additionalNotes: Record<string, string>;
	preAnalysis: PreAnalysis;
}> {
	const { submissionId, assignmentId, categoryKey, llmTimeoutMs, model, temperature } = args;
	assertSafeSegment(assignmentId, "assignmentId");
	assertSafeSegment(submissionId, "submissionId");

	const results = await readResults(assignmentId);
	const stored: StoredExecutionResult | undefined = results[submissionId];
	if (!stored) {
		throw new Error(
			`No stored execution result for submission "${submissionId}" in assignment "${assignmentId}" — execute the notebook first`,
		);
	}
	const cells = Array.isArray(stored.cells) ? stored.cells : [];
	if (cells.length === 0) {
		throw new Error(
			`Submission "${submissionId}" in assignment "${assignmentId}" has no stored executed cell data — re-execute the notebook (single execution) before pre-evaluating`,
		);
	}

	const assignment = await getAssignmentById(assignmentId);
	const rubric = assignment ? await loadCriteriaForAssignment(assignment.criteria_files) : null;
	if (!rubric || rubric.categories.length === 0) {
		throw new Error(
			`Assignment "${assignmentId}" has no rubric configured — cannot run the category milestone`,
		);
	}
	const categoryEntry = rubric.categories.find((entry) => entry.key === categoryKey);
	if (!categoryEntry) {
		throw new Error(
			`Category "${categoryKey}" does not exist in the rubric for assignment "${assignmentId}"`,
		);
	}

	const preAnalysis = analyzeSubmission(cells);

	const settings = await loadSettings();
	const effectiveTimeoutMs =
		llmTimeoutMs ??
		(settings.llm.timeoutMs > 0 ? settings.llm.timeoutMs : PRE_EVALUATION_LLM_TIMEOUT_MS);

	const worksheet = generateWorksheet({
		submissionId,
		assignmentId,
		cellCount: cells.length,
		codeCellCount: preAnalysis.codeCellCount,
		markdownCellCount: preAnalysis.markdownCellCount,
		preAnalysisSummary: preAnalysis.issueSummary,
		markerCounts: null,
		rubric,
	});

	const result = await runTurnBasedCategoryTurns({
		worksheet,
		rubric,
		submissionId,
		assignmentId,
		llmTimeoutMs: effectiveTimeoutMs,
		preAnalysis,
		cells,
		model,
		temperature,
		categoryKeys: [categoryKey],
	});

	// The FINAL worksheet section — the model's edited section merged into
	// the living worksheet (or the untouched original when the category
	// failed validation after all retries).
	const worksheetSection = extractCategorySection(result.worksheet, categoryKey) ?? "";

	return {
		worksheetSection,
		rubricSelections: result.rubricSelections,
		additionalNotes: result.additionalNotes,
		preAnalysis,
	};
}

// Balanced criteria diagnostics (9.1)
// ---------------------------------------------------------------------------

/**
 * General-rubric categories whose verdict ALWAYS applies — a submission's
 * notebook structure (Jupyter Notebooks) and its scholarship (Academic
 * Scholarship) always warrant at least one checked sub-point, so the
 * worksheet must never come back empty for them. Assignment-specific
 * categories are added at runtime (see {@link mandatoryCategoryKeys}).
 */
const MANDATORY_GENERAL_CATEGORY_KEYS = new Set(["jupyter_notebooks", "academic_scholarship"]);

/**
 * Categories where zero selections are ALWAYS legitimate — never warned about.
 * `genai` has only neutral/negative items; a submission with no GenAI usage
 * correctly selects nothing. `following_instructions` positive "Disallowed
 * libraries were not used" is handled by post-processing Pass 3.
 */
const SILENT_EMPTY_CATEGORY_KEYS = new Set(["genai", "following_instructions"]);

/** The three sentiment sections of the worksheet. */
const SENTIMENT_SECTIONS = ["positive", "neutral", "negative"] as const;

/** Whether the category offers at least one selectable sub-point in the section. */
function sentimentHasOptions(category: Category, sentiment: Sentiment): boolean {
	return category[sentiment].some((mp) => mp.sub_points.length > 0);
}

/** Whether the given sub-point text belongs to the category's sentiment section. */
function sentimentContains(category: Category, sentiment: Sentiment, optionKey: string): boolean {
	return category[sentiment].some((mp) => mp.sub_points.some((sp) => sp.text === optionKey));
}

/**
 * The categories that must carry at least one rubric selection after the
 * worksheet pipeline: the always-applicable general categories
 * (`jupyter_notebooks`, `academic_scholarship`) plus every assignment-
 * specific category — each assignment-specific section covers a technique
 * the assignment requires, so leaving it untouched is a gap the teacher
 * should know about. Assignment-specific keys are those NOT defined in the
 * assignment's general criteria file (registry entry ending in
 * `general.yaml`). Falls back to just the known general keys when the
 * general file is missing or unreadable — never throws.
 */
async function mandatoryCategoryKeys(
	rubric: MergedRubric,
	criteriaFiles: readonly string[] | undefined,
): Promise<Set<string>> {
	const keys = new Set<string>();
	for (const entry of rubric.categories) {
		if (MANDATORY_GENERAL_CATEGORY_KEYS.has(entry.key)) keys.add(entry.key);
	}

	const generalPath = criteriaFiles?.find((file) => file.endsWith("general.yaml"));
	if (!generalPath) return keys;

	try {
		const general = await loadCriteriaFile(generalPath);
		if (general) {
			for (const entry of rubric.categories) {
				// Assignment-specific categories are NOT per-section mandatory —
				// a clean submission legitimately has no negatives. Only warn
				// about total-zero for these (and skip silent-empty categories).
				if (
					!(entry.key in general.categories) &&
					!SILENT_EMPTY_CATEGORY_KEYS.has(entry.key)
				) {
					keys.add(entry.key);
				}
			}
		}
	} catch (err) {
		console.warn(
			`[pre-eval] could not load the general criteria file (${generalPath}) for mandatory-category diagnostics:`,
			err instanceof Error ? err.message : err,
		);
	}
	return keys;
}

/** Whether a category is a general mandatory (per-section checks apply). */
function isGeneralMandatory(key: string): boolean {
	return MANDATORY_GENERAL_CATEGORY_KEYS.has(key);
}

/**
 * Post-worksheet diagnostic (9.1): warn about mandatory categories with
 * selection gaps.
 *
 * For every mandatory category the filled worksheet should have checked at
 * least one sub-point per sentiment section that HAS selectable options —
 * and at least one selection overall. Gaps are surfaced as warnings in the
 * server console AND as a single `warning` entry in the pre-eval log (the
 * dashboard's pipeline-log panel renders the `warning` level), but the
 * result is ACCEPTED either way: no retry, no throw. The pre-evaluation
 * succeeded — the teacher just needs to know where to look before
 * finalizing the review.
 */
export async function logBalancedCriteriaWarnings(opts: {
	submissionId: string;
	assignmentId: string;
	rubric: MergedRubric;
	criteriaFiles: readonly string[] | undefined;
	rubricSelections: { categoryKey: string; optionKey: string }[];
}): Promise<void> {
	const { submissionId, assignmentId, rubric, criteriaFiles, rubricSelections } = opts;

	const mandatoryKeys = await mandatoryCategoryKeys(rubric, criteriaFiles);
	if (mandatoryKeys.size === 0) return;

	// Index selections by category and by the sentiment section their
	// option belongs to. A selection the parse fallback resolved to a
	// different category counts for ITS OWN category.
	const selectedSentiments = new Map<string, Set<Sentiment>>();
	const selectionCounts = new Map<string, number>();
	for (const selection of rubricSelections) {
		const entry = rubric.categories.find((e) => e.key === selection.categoryKey);
		if (!entry) continue;
		selectionCounts.set(entry.key, (selectionCounts.get(entry.key) ?? 0) + 1);
		for (const sentiment of SENTIMENT_SECTIONS) {
			if (sentimentContains(entry.category, sentiment, selection.optionKey)) {
				let set = selectedSentiments.get(entry.key);
				if (!set) {
					set = new Set();
					selectedSentiments.set(entry.key, set);
				}
				set.add(sentiment);
			}
		}
	}

	const warnings: string[] = [];
	for (const entry of rubric.categories) {
		if (!mandatoryKeys.has(entry.key)) continue;
		const title = entry.category.title;

		// Per-section balance: only for general-mandatory categories
		// (jupyter_notebooks, academic_scholarship) where every sentiment
		// section that HAS options should carry at least one selection.
		// Assignment-specific categories legitimately vary — a clean
		// submission has no negatives for pandas/numpy/scipy/sklearn.
		if (isGeneralMandatory(entry.key)) {
			for (const sentiment of SENTIMENT_SECTIONS) {
				if (!sentimentHasOptions(entry.category, sentiment)) continue;
				if (!selectedSentiments.get(entry.key)?.has(sentiment)) {
					warnings.push(
						`Category '${title}' has no rubric selections in its ${sentiment} section — may need manual review`,
					);
				}
			}
		}

		// Total gap: the category came back entirely empty across all
		// sentiments — the strongest signal that the model skipped it.
		if ((selectionCounts.get(entry.key) ?? 0) === 0) {
			warnings.push(
				`Category '${title}' has zero rubric selections — may need manual review`,
			);
		}
	}
	if (warnings.length === 0) return;

	for (const warning of warnings) {
		console.warn(
			`[pre-eval] ${warning} (submission "${submissionId}", assignment "${assignmentId}")`,
		);
	}

	// One aggregate entry per submission — the panel's one-entry-per-row
	// rhythm stays intact, and the teacher sees the gaps in the same log
	// stream as the row's ok:true settlement line. ok stays true: the
	// pre-evaluation succeeded, it just has gaps the teacher should review.
	appendPreEvalLog({
		level: "warning",
		logger: "pre-eval",
		submissionId,
		message: `Balanced-criteria check: ${warnings.length} gap(s) for "${submissionId}" — ${warnings.join("; ")}`,
		grades: {},
		markerCount: 0,
		selectionCount: rubricSelections.length,
		ok: true,
	});
}
