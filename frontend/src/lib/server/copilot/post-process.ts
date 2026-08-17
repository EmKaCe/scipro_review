/**
 * @file Post-processing layer for pre-evaluation results — 7 deterministic
 * correction passes.
 *
 * Takes the pre-evaluation envelope (dimension scores + rubric selections +
 * additional notes) plus the deterministic pre-analysis and the execution
 * record, and applies pure-logic corrections distilled from the manual
 * subagent grading waves (grading-output/final_2 ground truth):
 *
 *   Pass 1 — fill-empty:        mandatory categories (GenAI, callingFunction,
 *                               general, followingInstructions) must have at
 *                               least one checkbox or a textarea.
 *   Pass 2 — checkbox-textarea-sync: textarea claims must be reflected in the
 *                               matching rubric checkboxes.
 *   Pass 3 — disallowed-library-scan: the "Disallowed libraries were not
 *                               used" positive is added/removed based on the
 *                               actual imports in the execution record.
 *   Pass 4 — strip-plagiarism:  sentences with plagiarism language are removed
 *                               from ALL textareas (plagiarism is a separate
 *                               instructor-only deliverable, never part of the
 *                               grading JSON).
 *   Pass 5 — strip-filler:      universally-true filler sentences are removed
 *                               from ALL textareas.
 *   Pass 6 — fill-textarea:     empty/short textareas are filled with 1-2
 *                               sentence notes citing execution-record facts.
 *   Pass 7 — evidence-grounded: rubric selections that contradict the
 *                               deterministic pre-analysis findings (import
 *                               ordering, naming, unused imports,
 *                               interpretation, citations) are corrected.
 *
 * The whole module is DETERMINISTIC — no model calls, no randomness. Every
 * change is recorded as a {@link PostProcessFix} in the returned
 * {@link PostProcessResult} so callers can show the teacher what was
 * corrected and why.
 *
 * This module runs only on the SvelteKit server (`$lib/server/`).
 */

import { weightedPercentage } from "./legacy-export";
import { LEGACY_CATEGORY_PREFIXES } from "$lib/server/criteria/legacy-catalog";
import type { PreAnalysis } from "$lib/server/copilot/pre-analysis";
import type { ExecutionResult, ExecutedCell } from "$lib/server/executor-client";

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

/** One checked rubric item (same shape as pre-evaluation's rubricSelections). */
export interface PostProcessSelection {
	/** Internal category key, e.g. "code_formatting". */
	categoryKey: string;
	/** Sub-point text as it appears verbatim in the criteria YAML. */
	optionKey: string;
}

/** Options for {@link postProcessSubmission}. */
export interface PostProcessOptions {
	/** Student ID, e.g. "2026SS_38" (echoed into the result). */
	submissionId: string;
	/** Dimension scores keyed by internal dimension key. */
	dimensions: Record<string, number>;
	/** Checked rubric items (may be empty). */
	rubricSelections: readonly PostProcessSelection[];
	/** Free-text notes per category key (may be empty). */
	additionalNotes: Record<string, string>;
	/** Deterministic pre-analysis findings (see pre-analysis.ts). */
	preAnalysis: PreAnalysis;
	/** Stored execution result whose cells carry the source/output evidence. */
	executionRecord: ExecutionResult;
}

/** The corrected pre-evaluation data, same shape as the input. */
export interface PostProcessData {
	dimensions: Record<string, number>;
	rubricSelections: PostProcessSelection[];
	additionalNotes: Record<string, string>;
}

/** One recorded correction. */
export interface PostProcessFix {
	/** Pass id, e.g. "fill-empty", "strip-plagiarism". */
	pass: string;
	/** What was changed, e.g. "GenAI-textarea" or "codeFormatting-negative:imports - not alphabetized". */
	field: string;
	/** The value before the fix (null when the field did not exist). */
	oldValue: string | null;
	/** The value after the fix ("(removed)" when a checkbox was removed). */
	newValue: string;
	/** Plain-language explanation. */
	reason: string;
}

/** What the post-processing pass recorded. */
export interface PostProcessResult {
	submissionId: string;
	fixes: PostProcessFix[];
}

// ---------------------------------------------------------------------------
// Rubric sub-point texts the passes add/remove (verbatim from the criteria
// YAMLs — rubricSelections optionKeys are validated against these exact texts)
// ---------------------------------------------------------------------------

const FOLLOWING_INSTRUCTIONS_NO_DISALLOWED = "Disallowed libraries were not used.";
const CODE_FORMATTING_IMPORTS_NOT_ALPHABETIZED = "imports - not alphabetized";
const CODE_FORMATTING_NAMING_DESCRIPTIVE =
	"naming - descriptive objects/variables (i.e., human readable)";
const CODE_FORMATTING_IMPORTS_ALPHABETIZED = "imports - libraries were alphabetized";
const CODE_FORMATTING_NAMING_NOT_DESCRIPTIVE =
	"naming - object/variable (e.g., df, data, x, y) is not descriptive enough";
const CODE_FORMATTING_BLANK_LINES_TOO_MANY = "blank lines - too many used (i.e., not concise)";
const CODE_FORMATTING_IMPORTS_NOT_AT_TOP = "imports - not listed together at the notebook's top";
const CODING_CONCEPT_IMPORTS_NOT_USED =
	"imports - libraries were imported, but not used (not concise coding)";
const GENERAL_FEEDBACK_NO_INTERPRETATION =
	"interpretation - there was no or little attempt to interpret or discuss the code's results";
const ACADEMIC_SCHOLARSHIP_NO_CITATIONS =
	"As a university student, you should be citing sources of knowledge. This is something that you will need to do for your thesis.";
const CALLING_FUNCTION_KEYWORD_ARGS =
	"keyword arguments calls - include the parameter that are being assigned the argument to (e.g., 'my_function(param1=arg1, param2=arg2)'. Doing so ensure that the arguments are passed correctly.";
const CALLING_FUNCTION_MULTILINE_FORMATTING =
	"formatting - placing each parameter being passed onto a new line is not necessary and makes the code less concise";
const GENERAL_EXCELLENT = "excellent";
const GENERAL_VERY_GOOD = "very good";
const GENERAL_GOOD = "good";
const GENERAL_OKAY = "okay  - there is notable room for improvement";

/**
 * Weighted-percentage bands for the general_feedback rating checkbox/note.
 *
 * Calibrated 2026-08-17 against the emailed ground truth
 * (grading-output/emailed-sources/2026SS_soil_contamination/): the professor
 * rated 79.0% weighted as "okay" (2026SS_23) and 86.5% as "good"
 * (2026SS_70), while 87.0% was "very good" (2026SS_17/43) — so "good" starts
 * at 80 (matching data/grading_config.yaml grade 2.0/B+) and "very good" at
 * 87. The old >=70/>=85 thresholds drifted into "good"/"very good" where the
 * professor sent "okay"/"good".
 */
function generalOptionForPercentage(weighted: number): string {
	if (weighted >= 95) return GENERAL_EXCELLENT;
	if (weighted >= 87) return GENERAL_VERY_GOOD;
	if (weighted >= 80) return GENERAL_GOOD;
	return GENERAL_OKAY;
}

/** Human-readable label for a weighted percentage (for generated notes). */
function overallLabel(weighted: number): string {
	if (weighted >= 95) return "excellent";
	if (weighted >= 87) return "very good";
	if (weighted >= 80) return "good";
	return "okay";
}

// ---------------------------------------------------------------------------
// Category registry (internal snake_case key <-> Karl form prefix)
// ---------------------------------------------------------------------------

interface CategoryInfo {
	/** Internal rubric category key, e.g. "code_formatting". */
	key: string;
	/** Karl form element-ID prefix, e.g. "codeFormatting". */
	legacy: string;
}

const CATEGORIES: readonly CategoryInfo[] = Object.entries(LEGACY_CATEGORY_PREFIXES).map(
	([key, legacy]) => ({ key, legacy }),
);

/** Normalize a category key for lookup: lowercase, strip non-alphanumerics. */
function normalizeCategoryKey(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Lookup table accepting BOTH internal keys ("genai") and Karl prefixes ("GenAI"). */
const CATEGORY_LOOKUP = new Map<string, CategoryInfo>();
for (const cat of CATEGORIES) {
	CATEGORY_LOOKUP.set(normalizeCategoryKey(cat.key), cat);
	CATEGORY_LOOKUP.set(normalizeCategoryKey(cat.legacy), cat);
}

/** Resolve a category from either its internal key or its Karl prefix. */
function resolveCategory(categoryKey: string): CategoryInfo | null {
	return CATEGORY_LOOKUP.get(normalizeCategoryKey(categoryKey)) ?? null;
}

/** Normalize an optionKey for comparison: trim, lowercase, drop trailing punctuation. */
function normalizeKey(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[.\s]+$/, "");
}

// ---------------------------------------------------------------------------
// Selection helpers (immutable — return new arrays)
// ---------------------------------------------------------------------------

/** Selections belonging to a category (matched by resolved canonical key). */
function categorySelections(
	selections: readonly PostProcessSelection[],
	categoryKey: string,
): PostProcessSelection[] {
	const cat = resolveCategory(categoryKey);
	if (!cat) return [];
	return selections.filter((s) => resolveCategory(s.categoryKey)?.key === cat.key);
}

/** True when the category already has the given option checked. */
function hasOption(
	selections: readonly PostProcessSelection[],
	categoryKey: string,
	optionKey: string,
): boolean {
	const cat = resolveCategory(categoryKey);
	if (!cat) return false;
	const norm = normalizeKey(optionKey);
	return categorySelections(selections, cat.key).some((s) => normalizeKey(s.optionKey) === norm);
}

/** Add a selection unless it is already present (dedupe on normalized optionKey). */
function withSelectionAdded(
	selections: readonly PostProcessSelection[],
	categoryKey: string,
	optionKey: string,
): PostProcessSelection[] {
	const cat = resolveCategory(categoryKey);
	if (!cat || hasOption(selections, cat.key, optionKey)) return [...selections];
	return [...selections, { categoryKey: cat.key, optionKey }];
}

/** Remove a selection (no-op when absent). */
function withSelectionRemoved(
	selections: readonly PostProcessSelection[],
	categoryKey: string,
	optionKey: string,
): PostProcessSelection[] {
	const cat = resolveCategory(categoryKey);
	if (!cat) return [...selections];
	const norm = normalizeKey(optionKey);
	return selections.filter(
		(s) =>
			!(
				resolveCategory(s.categoryKey)?.key === cat.key &&
				normalizeKey(s.optionKey) === norm
			),
	);
}

// ---------------------------------------------------------------------------
// Working state (mutated by the passes, cloned from the input)
// ---------------------------------------------------------------------------

interface WorkingState {
	selections: PostProcessSelection[];
	notes: Record<string, string>;
	dimensions: Record<string, number>;
	executionRecord: ExecutionResult;
	preAnalysis: PreAnalysis;
}

function hasNote(state: WorkingState, cat: CategoryInfo): boolean {
	const note = state.notes[cat.key];
	return note !== undefined && note.trim() !== "";
}

function setNote(
	state: WorkingState,
	cat: CategoryInfo,
	note: string,
	pass: string,
	reason: string,
	fixes: PostProcessFix[],
): void {
	const oldValue = state.notes[cat.key] ?? null;
	state.notes[cat.key] = note;
	fixes.push({ pass, field: `${cat.legacy}-textarea`, oldValue, newValue: note, reason });
}

function addCheckbox(
	state: WorkingState,
	cat: CategoryInfo,
	sentiment: "positive" | "neutral" | "negative",
	optionKey: string,
	pass: string,
	reason: string,
	fixes: PostProcessFix[],
): void {
	if (hasOption(state.selections, cat.key, optionKey)) return;
	state.selections = withSelectionAdded(state.selections, cat.key, optionKey);
	fixes.push({
		pass,
		field: `${cat.legacy}-${sentiment}:${optionKey}`,
		oldValue: null,
		newValue: "checked",
		reason,
	});
}

// ---------------------------------------------------------------------------
// Pass 1 — Fill empty mandatory categories
// ---------------------------------------------------------------------------

/**
 * Categories that MUST end up with at least one checkbox or a textarea.
 * The fill only touches categories that are COMPLETELY empty (no checkboxes,
 * no note) — existing content is never overwritten.
 */
function passFillEmpty(state: WorkingState, fixes: PostProcessFix[]): void {
	// GenAI: no selections -> add the default no-concerns textarea.
	const genai = resolveCategory("genai");
	if (
		genai &&
		categorySelections(state.selections, genai.key).length === 0 &&
		!hasNote(state, genai)
	) {
		setNote(
			state,
			genai,
			"No GenAI concerns were flagged from the execution record.",
			"fill-empty",
			"GenAI is a mandatory category but had no checkbox selections and no note; added the default no-concerns note.",
			fixes,
		);
	}

	// callingFunction: no selections -> check the two standard negatives
	// (keyword arguments + multi-line formatting — almost universally
	// applicable to curve_fit calls in this assignment) and add a note.
	const calling = resolveCategory("function_calling");
	if (
		calling &&
		categorySelections(state.selections, calling.key).length === 0 &&
		!hasNote(state, calling)
	) {
		addCheckbox(
			state,
			calling,
			"negative",
			CALLING_FUNCTION_KEYWORD_ARGS,
			"fill-empty",
			"callingFunction is a mandatory category but was left empty; checked the keyword-arguments negative (standard for curve_fit calls).",
			fixes,
		);
		addCheckbox(
			state,
			calling,
			"negative",
			CALLING_FUNCTION_MULTILINE_FORMATTING,
			"fill-empty",
			"callingFunction is a mandatory category but was left empty; checked the multi-line formatting negative.",
			fixes,
		);
		setNote(
			state,
			calling,
			generateFunctionCallingNote(buildEvidence(state)),
			"fill-empty",
			"callingFunction is a mandatory category but had no note; generated one from execution-record evidence.",
			fixes,
		);
	}

	// general (general_feedback): no selections -> derive the overall rating
	// from the weighted percentage and check the matching positive.
	const general = resolveCategory("general_feedback");
	if (
		general &&
		categorySelections(state.selections, general.key).length === 0 &&
		!hasNote(state, general)
	) {
		if (Object.keys(state.dimensions).length > 0) {
			const weighted = weightedPercentage(state.dimensions);
			const option = generalOptionForPercentage(weighted);
			const sentiment = option === GENERAL_OKAY ? "neutral" : "positive";
			addCheckbox(
				state,
				general,
				sentiment,
				option,
				"fill-empty",
				`general is a mandatory category but was left empty; checked the "${option}" rating for ${weighted}% weighted.`,
				fixes,
			);
		}
	}

	// followingInstructions: no selections -> check the no-disallowed-libraries
	// positive (Pass 3 re-verifies the imports and removes it when a
	// disallowed library is actually found).
	const following = resolveCategory("following_instructions");
	if (
		following &&
		categorySelections(state.selections, following.key).length === 0 &&
		!hasNote(state, following)
	) {
		addCheckbox(
			state,
			following,
			"positive",
			FOLLOWING_INSTRUCTIONS_NO_DISALLOWED,
			"fill-empty",
			"followingInstructions is a mandatory category but was left empty; checked the no-disallowed-libraries positive (Pass 3 verifies the imports).",
			fixes,
		);
	}
}

// ---------------------------------------------------------------------------
// Pass 2 — Checkbox-textarea sync
// ---------------------------------------------------------------------------

/**
 * Textarea claims that have a corresponding rubric checkbox. When a category's
 * textarea asserts one of these claims and the matching checkbox is NOT
 * checked, the checkbox is added. Only additions — existing checkboxes are
 * never removed here.
 */
const TEXTAREA_SYNC_RULES: readonly {
	categoryKey: string;
	sentiment: "positive" | "negative";
	pattern: RegExp;
	optionKey: string;
}[] = [
	{
		categoryKey: "code_formatting",
		sentiment: "negative",
		pattern: /imports?\s+(?:are\s+)?not\s+alphabeti[sz]ed/i,
		optionKey: CODE_FORMATTING_IMPORTS_NOT_ALPHABETIZED,
	},
	{
		categoryKey: "code_formatting",
		sentiment: "positive",
		pattern:
			/naming\s+is\s+descriptive|names?\s+(?:are\s+)?descriptive|(?<!non[- ])descriptive\s+(?:object|variable|name)/i,
		optionKey: CODE_FORMATTING_NAMING_DESCRIPTIVE,
	},
	{
		categoryKey: "code_formatting",
		sentiment: "negative",
		pattern: /non[- ]descriptive|not\s+descriptive/i,
		optionKey: CODE_FORMATTING_NAMING_NOT_DESCRIPTIVE,
	},
	{
		categoryKey: "code_formatting",
		sentiment: "negative",
		pattern: /double\s+blank\s+line/i,
		optionKey: CODE_FORMATTING_BLANK_LINES_TOO_MANY,
	},
	{
		categoryKey: "code_formatting",
		sentiment: "negative",
		pattern:
			/imports?\s+(?:are\s+)?not\s+(?:listed\s+(?:together\s+)?)?at\s+(?:the\s+)?(?:notebook'?s\s+)?top/i,
		optionKey: CODE_FORMATTING_IMPORTS_NOT_AT_TOP,
	},
];

function passCheckboxTextareaSync(state: WorkingState, fixes: PostProcessFix[]): void {
	for (const rule of TEXTAREA_SYNC_RULES) {
		const cat = resolveCategory(rule.categoryKey);
		if (!cat) continue;
		const note = state.notes[cat.key];
		if (!note || note.trim() === "") continue;
		if (!rule.pattern.test(note)) continue;
		if (hasOption(state.selections, cat.key, rule.optionKey)) continue;
		state.selections = withSelectionAdded(state.selections, cat.key, rule.optionKey);
		fixes.push({
			pass: "checkbox-textarea-sync",
			field: `${cat.legacy}-${rule.sentiment}:${rule.optionKey}`,
			oldValue: null,
			newValue: "checked",
			reason: `The ${cat.legacy} textarea claims "${rule.optionKey}"; checked the matching rubric item.`,
		});
	}
}

// ---------------------------------------------------------------------------
// Pass 3 — Disallowed-library scan
// ---------------------------------------------------------------------------

/**
 * Libraries allowed for the soil_contamination assignment (top-level module
 * names, lowercased). Anything else imported in a code cell is disallowed
 * (seaborn, plotly, tensorflow, torch, ...).
 */
const ALLOWED_IMPORTS: ReadonlySet<string> = new Set([
	"numpy",
	"pandas",
	"scipy",
	"sklearn",
	"matplotlib",
	"pathlib",
	"typing",
]);

/** Extract the top-level module names imported by code cells. */
function extractImports(cells: readonly ExecutedCell[]): string[] {
	const modules = new Set<string>();
	for (const cell of cells) {
		if (cell.type !== "code") continue;
		for (const line of cell.source.split("\n")) {
			const trimmed = line.trim();
			const importMatch = trimmed.match(/^import\s+([\w.]+)/);
			if (importMatch) {
				modules.add(importMatch[1]!.split(".")[0]!.toLowerCase());
				continue;
			}
			const fromMatch = trimmed.match(/^from\s+([\w.]+)\s+import\b/);
			if (fromMatch) {
				modules.add(fromMatch[1]!.split(".")[0]!.toLowerCase());
			}
		}
	}
	return [...modules].sort();
}

function passDisallowedLibraryScan(state: WorkingState, fixes: PostProcessFix[]): void {
	const imports = extractImports(state.executionRecord.cells);
	const disallowed = imports.filter((module) => !ALLOWED_IMPORTS.has(module));
	const cat = resolveCategory("following_instructions");
	if (!cat) return;
	const field = `${cat.legacy}-positive:${FOLLOWING_INSTRUCTIONS_NO_DISALLOWED}`;

	if (disallowed.length > 0) {
		if (hasOption(state.selections, cat.key, FOLLOWING_INSTRUCTIONS_NO_DISALLOWED)) {
			state.selections = withSelectionRemoved(
				state.selections,
				cat.key,
				FOLLOWING_INSTRUCTIONS_NO_DISALLOWED,
			);
			fixes.push({
				pass: "disallowed-library-scan",
				field,
				oldValue: "checked",
				newValue: "(removed)",
				reason: `Disallowed import(s) found in the execution record: ${disallowed.join(", ")}.`,
			});
		}
	} else if (!hasOption(state.selections, cat.key, FOLLOWING_INSTRUCTIONS_NO_DISALLOWED)) {
		state.selections = withSelectionAdded(
			state.selections,
			cat.key,
			FOLLOWING_INSTRUCTIONS_NO_DISALLOWED,
		);
		fixes.push({
			pass: "disallowed-library-scan",
			field,
			oldValue: null,
			newValue: "checked",
			reason: "No disallowed imports found in the execution record; checked the positive.",
		});
	}
}

// ---------------------------------------------------------------------------
// Pass 4 — Strip plagiarism language / Pass 5 — Strip filler notes
// ---------------------------------------------------------------------------

/** Split a note into sentences (period/question/exclamation or newline boundaries). */
function splitSentences(text: string): string[] {
	return text.split(/(?<=[.!?])\s+|\n+/);
}

/** Remove every sentence matching any pattern; return the cleaned text + count. */
function stripMatchingSentences(
	text: string,
	patterns: readonly RegExp[],
): { text: string; removed: number } {
	const kept: string[] = [];
	let removed = 0;
	for (const sentence of splitSentences(text)) {
		if (patterns.some((pattern) => pattern.test(sentence))) {
			removed++;
		} else {
			kept.push(sentence);
		}
	}
	return {
		text: kept
			.join(" ")
			.replace(/\s{2,}/g, " ")
			.trim(),
		removed,
	};
}

/**
 * Plagiarism language must never appear in a grading JSON — plagiarism is a
 * separate instructor-only deliverable. Sentences matching any pattern are
 * removed from ALL textareas.
 */
const PLAGIARISM_PATTERNS: readonly RegExp[] = [
	/plagiaris/i,
	/similar to (another|other) student/i,
	/shared (template|code|pattern)/i,
	/classmate/i,
	/identical\s+(?:to|with)\s+[^\s.]*\d{4}\s*SS/i,
	/copied\s+(?:from|code|solution)/i,
];

function passStripPlagiarism(state: WorkingState, fixes: PostProcessFix[]): void {
	for (const cat of CATEGORIES) {
		const note = state.notes[cat.key];
		if (!note || note.trim() === "") continue;
		const { text, removed } = stripMatchingSentences(note, PLAGIARISM_PATTERNS);
		if (removed === 0) continue;
		state.notes[cat.key] = text;
		fixes.push({
			pass: "strip-plagiarism",
			field: `${cat.legacy}-textarea`,
			oldValue: note,
			newValue: text,
			reason: `Stripped ${removed} sentence(s) containing plagiarism language (plagiarism is a separate deliverable, never part of the grading JSON).`,
		});
	}
}

/**
 * Universally-true filler sentences provide zero differential feedback. When
 * a textarea contains ONLY filler, it is replaced with the neutral default;
 * otherwise the filler sentences are removed and the rest is kept.
 */
const FILLER_PATTERNS: readonly RegExp[] = [
	/student added their scipro id to the top of the notebook/i,
	/all five tasks are addressed in order/i,
	/only allowed libraries were imported/i,
	/the submission is a jupyter notebook/i,
	/the notebook is (well[- ])?structured/i,
	/the solution is (well[- ])?organized/i,
	/all (required |)tasks (were|are) (completed|attempted)/i,
	/the student( clearly)? demonstrates understanding/i,
	/the (code|solution|notebook) (generally |)follows/i,
	/the submission meets (the |)(all |)requirements/i,
];

function passStripFiller(state: WorkingState, fixes: PostProcessFix[]): void {
	for (const cat of CATEGORIES) {
		const note = state.notes[cat.key];
		if (!note || note.trim() === "") continue;
		const sentences = splitSentences(note);
		const kept = sentences.filter(
			(sentence) => !FILLER_PATTERNS.some((pattern) => pattern.test(sentence)),
		);
		if (kept.length === sentences.length) continue;
		const replacement =
			kept.length === 0
				? "No significant issues found."
				: kept
						.join(" ")
						.replace(/\s{2,}/g, " ")
						.trim();
		state.notes[cat.key] = replacement;
		fixes.push({
			pass: "strip-filler",
			field: `${cat.legacy}-textarea`,
			oldValue: note,
			newValue: replacement,
			reason:
				kept.length === 0
					? "Textarea contained only universally-true filler sentences; replaced with the neutral default."
					: `Removed ${sentences.length - kept.length} filler sentence(s).`,
		});
	}
}

// ---------------------------------------------------------------------------
// Pass 6 — Fill missing textareas from execution evidence
// ---------------------------------------------------------------------------

/** Facts deterministically extracted from the execution record + pre-analysis. */
interface EvidenceFacts {
	/** All code-cell source joined. */
	codeSource: string;
	/** All code-cell output text joined. */
	outputText: string;
	/** All markdown-cell source joined. */
	markdownSource: string;
	pre: PreAnalysis;
}

function buildEvidence(state: WorkingState): EvidenceFacts {
	const codeCells = state.executionRecord.cells.filter((c) => c.type === "code");
	const markdownCells = state.executionRecord.cells.filter((c) => c.type === "markdown");
	return {
		codeSource: codeCells.map((c) => c.source).join("\n"),
		outputText: codeCells.map((c) => c.output ?? "").join("\n"),
		markdownSource: markdownCells.map((c) => c.source).join("\n"),
		pre: state.preAnalysis,
	};
}

function generatePandasNote(ev: EvidenceFacts): string {
	const parts: string[] = [];
	if (/pd\.read_csv\s*\(/.test(ev.codeSource))
		parts.push("`pd.read_csv` is used to load the data");
	if (/\.head\s*\(/.test(ev.codeSource)) parts.push("`head()` previews the DataFrame");
	if (/\.describe\s*\(/.test(ev.codeSource)) parts.push("`describe()` summarizes the data");
	if (/\.groupby\s*\(/.test(ev.codeSource)) parts.push("`groupby` operations aggregate the data");
	if (parts.length === 0) {
		return "No Pandas-specific calls (read_csv/head/describe/groupby) were found in the execution record.";
	}
	return `Pandas usage: ${parts.join("; ")}.`;
}

function generateNumpyNote(ev: EvidenceFacts): string {
	const calls: string[] = [];
	if (/np\.exp\s*\(/.test(ev.codeSource)) calls.push("`np.exp`");
	if (/np\.sqrt\s*\(/.test(ev.codeSource)) calls.push("`np.sqrt`");
	if (
		/np\.(?:add|subtract|multiply|divide|dot|mean|std|sum|min|max|abs|log)\s*\(/.test(
			ev.codeSource,
		)
	) {
		calls.push("vectorized NumPy arithmetic");
	}
	if (calls.length === 0) {
		return "No NumPy-specific calls (np.exp/np.sqrt/vectorized arithmetic) were found in the execution record.";
	}
	return `NumPy is used with ${calls.join(" and ")}.`;
}

/** R^2 value (e.g. "R^2 = 0.941", "R2: 0.94", "R²=0.941") from output text. */
function matchR2(outputText: string): string | null {
	return outputText.match(/\bR\s*(?:\^2|²|2)\s*[=:]\s*([\d.]+)/i)?.[1] ?? null;
}

/** RMSE value (e.g. "RMSE = 42.58", "RMSE (42.58 mg/kg)") from output text. */
function matchRmse(outputText: string): string | null {
	return (
		outputText.match(/\bRMSE\s*[=:]\s*([\d.]+)/i)?.[1] ??
		outputText.match(/\bRMSE\s*\(\s*([\d.]+)/i)?.[1] ??
		null
	);
}

function generateScipyNote(ev: EvidenceFacts): string {
	const sentences: string[] = [];
	if (/curve_fit\s*\(/.test(ev.codeSource)) {
		sentences.push("`curve_fit` is used to fit the model.");
	} else {
		sentences.push("No `curve_fit` call was found in the execution record.");
	}
	const r2 = matchR2(ev.outputText);
	const rmse = matchRmse(ev.outputText);
	if (r2 && rmse) {
		sentences.push(`R^2 = ${r2} and RMSE = ${rmse} are reported in the fit output.`);
	} else if (r2) {
		sentences.push(`R^2 = ${r2} is reported in the fit output.`);
	} else if (rmse) {
		sentences.push(`RMSE = ${rmse} is reported in the fit output.`);
	} else {
		sentences.push("No R^2 or RMSE values were found in the execution output.");
	}
	return sentences.join(" ");
}

function generateSklearnNote(ev: EvidenceFacts): string {
	if (!/KMeans\s*\(/.test(ev.codeSource)) {
		return "No `KMeans` call was found in the execution record.";
	}
	const nClusters = ev.codeSource.match(/n_clusters\s*=\s*(\d+)/)?.[1];
	return nClusters
		? `KMeans is called with n_clusters=${nClusters}.`
		: "KMeans is called; no explicit n_clusters value was found in the execution record.";
}

const PLOT_TYPES = [
	"plot",
	"scatter",
	"bar",
	"barh",
	"hist",
	"imshow",
	"contourf",
	"pcolormesh",
	"boxplot",
	"errorbar",
] as const;

function generatePlottingNote(ev: EvidenceFacts): string {
	const used = PLOT_TYPES.find((type) =>
		new RegExp(`plt\\.${type}\\s*\\(|\\.${type}\\s*\\(`).test(ev.codeSource),
	);
	if (!used) {
		return "No plotting calls (plt.plot/plt.scatter/plt.bar/...) were found in the execution record.";
	}
	const details: string[] = [];
	if (/plt\.(?:xlabel|ylabel)\s*\(|\.set_(?:xlabel|ylabel)\s*\(/.test(ev.codeSource)) {
		details.push("axis labels");
	}
	if (/\.legend\s*\(/.test(ev.codeSource)) details.push("a legend");
	if (/plt\.title\s*\(|plt\.suptitle\s*\(|\.set_title\s*\(/.test(ev.codeSource)) {
		details.push("a title");
	}
	const suffix = details.length > 0 ? ` with ${details.join(", ")}` : "";
	return `The submission contains a ${used} plot${suffix}.`;
}

function generateCodeFormattingNote(ev: EvidenceFacts): string {
	const sentences: string[] = [];
	sentences.push(
		!ev.pre.importsAlphabetized
			? "Imports are not alphabetized."
			: "Imports are alphabetized.",
	);
	if (ev.pre.nonDescriptiveNames.length > 0) {
		sentences.push(
			`Non-descriptive variable name(s): ${ev.pre.nonDescriptiveNames.join(", ")}.`,
		);
	} else {
		sentences.push("Variable names are descriptive.");
	}
	return sentences.join(" ");
}

function generateAcademicScholarshipNote(ev: EvidenceFacts): string {
	if (ev.pre.citationCount > 0) {
		return `${ev.pre.citationCount} in-text citation(s) were found in the markdown cells; reference formatting was not verified from the execution record.`;
	}
	return "No in-text citations were found in the markdown cells.";
}

function generateJupyterNotebooksNote(ev: EvidenceFacts): string {
	return `The notebook contains ${ev.pre.codeCellCount} code cell(s) and ${ev.pre.markdownCellCount} markdown cell(s).`;
}

function generateCodingConceptNote(ev: EvidenceFacts): string {
	const used: string[] = [];
	if (/=\s*\{[^}]*\}|\bdict\s*\(/.test(ev.codeSource)) used.push("dictionaries");
	if (/=\s*\[[^\]]*\]|\blist\s*\(/.test(ev.codeSource)) used.push("lists");
	if (/=\s*\([^)]*\)|\btuple\s*\(/.test(ev.codeSource)) used.push("tuples");
	if (/\bset\s*\(/.test(ev.codeSource)) used.push("sets");
	if (used.length === 0) {
		return "No data-structure usage (dictionary/list/tuple/set) could be confirmed from the execution record.";
	}
	return `The solution uses ${used.join(", ")}.`;
}

function generateUserDefinedFunctionsNote(ev: EvidenceFacts): string {
	const defs = [...ev.codeSource.matchAll(/def\s+(\w+)/g)].map((m) => m[1]!);
	if (defs.length === 0) {
		return "No user-defined functions were found in the execution record.";
	}
	const sentences: string[] = [];
	sentences.push(`${defs.length} user-defined function(s) found: ${defs.join(", ")}.`);
	if (defs.includes("plume_model")) {
		sentences.push("`plume_model` is defined.");
	}
	sentences.push(
		/"""/.test(ev.codeSource) ? "Docstrings are present." : "No docstrings were found.",
	);
	return sentences.join(" ");
}

function generateFollowingInstructionsNote(ev: EvidenceFacts): string {
	const total = ev.pre.codeCellCount + ev.pre.markdownCellCount;
	if (ev.pre.errorCount > 0) {
		return `The submission follows the required Jupyter notebook format (${total} cells); ${ev.pre.errorCount} cell(s) had execution errors.`;
	}
	return `The submission follows the required Jupyter notebook format (${total} cells) and executed without errors.`;
}

function generateGenaiNote(_ev: EvidenceFacts): string {
	return "No GenAI concerns were flagged.";
}

function generateFunctionCallingNote(ev: EvidenceFacts): string {
	const fitCall = ev.codeSource.match(/curve_fit\s*\(([^)]*)\)/);
	if (!fitCall) {
		return "No `curve_fit` call was found in the execution record.";
	}
	const kwargs = [...fitCall[1]!.matchAll(/(\w+)\s*=/g)].map((m) => m[1]!);
	if (kwargs.length === 0) {
		return "The `curve_fit` call uses positional arguments.";
	}
	return `The \`curve_fit\` call passes arguments as keyword arguments (${kwargs.map((k) => `${k}=`).join(", ")}).`;
}

function generateGeneralNote(ev: EvidenceFacts, dimensions: Record<string, number> = {}): string {
	if (Object.keys(dimensions).length === 0) {
		return "No dimension scores were available to derive an overall rating.";
	}
	const weighted = weightedPercentage(dimensions);
	return `Overall the work is ${overallLabel(weighted)} (${weighted}% weighted).`;
}

/** Per-category note generators — each cites only execution-record facts. */
const TEXTAREA_GENERATORS: Readonly<
	Record<string, (ev: EvidenceFacts, dimensions?: Record<string, number>) => string>
> = {
	pandas: generatePandasNote,
	numpy: generateNumpyNote,
	scipy: generateScipyNote,
	sklearn: generateSklearnNote,
	plotting_visualization: generatePlottingNote,
	code_formatting: generateCodeFormattingNote,
	academic_scholarship: generateAcademicScholarshipNote,
	jupyter_notebooks: generateJupyterNotebooksNote,
	coding_concept: generateCodingConceptNote,
	user_defined_functions: generateUserDefinedFunctionsNote,
	following_instructions: generateFollowingInstructionsNote,
	genai: generateGenaiNote,
	function_calling: generateFunctionCallingNote,
	general_feedback: generateGeneralNote,
};

/** Minimum textarea length before it counts as "filled" (brief: 20 chars). */
const TEXTAREA_MIN_CHARS = 20;

function passFillTextareas(
	state: WorkingState,
	dimensions: Record<string, number>,
	fixes: PostProcessFix[],
): void {
	const evidence = buildEvidence(state);
	for (const cat of CATEGORIES) {
		const current = state.notes[cat.key];
		if (current && current.trim().length >= TEXTAREA_MIN_CHARS) continue;
		const generator = TEXTAREA_GENERATORS[cat.key];
		if (!generator) continue;
		const note = generator(evidence, dimensions);
		if (!note || note.trim() === "") continue;
		state.notes[cat.key] = note;
		fixes.push({
			pass: "fill-textarea",
			field: `${cat.legacy}-textarea`,
			oldValue: current ?? null,
			newValue: note,
			reason: `Textarea was empty or shorter than ${TEXTAREA_MIN_CHARS} characters; generated a note from execution-record evidence.`,
		});
	}
}

// ---------------------------------------------------------------------------
// Pass 7 — Evidence-grounded selection corrections
// ---------------------------------------------------------------------------

/**
 * Correct rubric selections that contradict the deterministic pre-analysis.
 * Runs AFTER all other passes so hard evidence is the final authority: a
 * checkbox added by Pass 2's textarea sync or Pass 6's note generation cannot
 * override a direct finding from pre-analysis.
 *
 * Corrections applied:
 *   - import ordering: the alphabetized positive / not-alphabetized negative
 *     is flipped to match {@link PreAnalysis#importsAlphabetized}
 *   - naming: the descriptive-naming positive is unchecked when
 *     non-descriptive names were detected
 *   - unused imports: the coding_concept "imported, but not used" negative is
 *     added when unused imports were detected
 *   - interpretation: the general_feedback no-interpretation negative is
 *     added when markdown cells exist but contain no interpretation language
 *   - citations: the academic_scholarship no-citations negative is added when
 *     markdown cells exist but contain no citations
 */
function passEvidenceGroundedCorrections(
	state: WorkingState,
	fixes: PostProcessFix[],
): void {
	const pre = state.preAnalysis;

	// (a) Import alphabetization — flip the mutual-exclusion pair to the side
	// the whole-list check supports.
	const codeFormatting = resolveCategory("code_formatting");
	if (codeFormatting && !pre.importsAlphabetized) {
		if (
			hasOption(
				state.selections,
				codeFormatting.key,
				CODE_FORMATTING_IMPORTS_ALPHABETIZED,
			)
		) {
			state.selections = withSelectionRemoved(
				state.selections,
				codeFormatting.key,
				CODE_FORMATTING_IMPORTS_ALPHABETIZED,
			);
			state.selections = withSelectionAdded(
				state.selections,
				codeFormatting.key,
				CODE_FORMATTING_IMPORTS_NOT_ALPHABETIZED,
			);
			fixes.push(
				{
					pass: "evidence-grounded",
					field: `codeFormatting-positive:${CODE_FORMATTING_IMPORTS_ALPHABETIZED}`,
					oldValue: "checked",
					newValue: "(removed)",
					reason: "preAnalysis.importsAlphabetized is false (whole-list check); the alphabetized positive contradicts the execution evidence.",
				},
				{
					pass: "evidence-grounded",
					field: `codeFormatting-negative:${CODE_FORMATTING_IMPORTS_NOT_ALPHABETIZED}`,
					oldValue: null,
					newValue: "checked",
					reason: "preAnalysis.importsAlphabetized is false; checked the not-alphabetized negative instead.",
				},
			);
		}
	} else if (codeFormatting && pre.importsAlphabetized) {
		if (
			hasOption(
				state.selections,
				codeFormatting.key,
				CODE_FORMATTING_IMPORTS_NOT_ALPHABETIZED,
			)
		) {
			state.selections = withSelectionRemoved(
				state.selections,
				codeFormatting.key,
				CODE_FORMATTING_IMPORTS_NOT_ALPHABETIZED,
			);
			state.selections = withSelectionAdded(
				state.selections,
				codeFormatting.key,
				CODE_FORMATTING_IMPORTS_ALPHABETIZED,
			);
			fixes.push(
				{
					pass: "evidence-grounded",
					field: `codeFormatting-negative:${CODE_FORMATTING_IMPORTS_NOT_ALPHABETIZED}`,
					oldValue: "checked",
					newValue: "(removed)",
					reason: "preAnalysis.importsAlphabetized is true (whole-list check); the not-alphabetized negative contradicts the execution evidence.",
				},
				{
					pass: "evidence-grounded",
					field: `codeFormatting-positive:${CODE_FORMATTING_IMPORTS_ALPHABETIZED}`,
					oldValue: null,
					newValue: "checked",
					reason: "preAnalysis.importsAlphabetized is true; checked the alphabetized positive instead.",
				},
			);
		}
	}

	// (b) Non-descriptive names — uncheck the descriptive-naming positive.
	if (
		codeFormatting &&
		pre.nonDescriptiveNames.length > 0 &&
		hasOption(
			state.selections,
			codeFormatting.key,
			CODE_FORMATTING_NAMING_DESCRIPTIVE,
		)
	) {
		state.selections = withSelectionRemoved(
			state.selections,
			codeFormatting.key,
			CODE_FORMATTING_NAMING_DESCRIPTIVE,
		);
		fixes.push({
			pass: "evidence-grounded",
			field: `codeFormatting-positive:${CODE_FORMATTING_NAMING_DESCRIPTIVE}`,
			oldValue: "checked",
			newValue: "(removed)",
			reason: `preAnalysis found non-descriptive name(s): ${pre.nonDescriptiveNames.join(", ")}; the descriptive-naming positive contradicts the execution evidence.`,
		});
	}

	// (c) Unused imports — add the coding_concept negative.
	const codingConcept = resolveCategory("coding_concept");
	if (
		codingConcept &&
		pre.unusedImports.length > 0 &&
		!hasOption(
			state.selections,
			codingConcept.key,
			CODING_CONCEPT_IMPORTS_NOT_USED,
		)
	) {
		state.selections = withSelectionAdded(
			state.selections,
			codingConcept.key,
			CODING_CONCEPT_IMPORTS_NOT_USED,
		);
		fixes.push({
			pass: "evidence-grounded",
			field: `codingConcept-negative:${CODING_CONCEPT_IMPORTS_NOT_USED}`,
			oldValue: null,
			newValue: "checked",
			reason: `preAnalysis found unused import(s): ${pre.unusedImports.join(", ")}; checked the imports-not-used negative.`,
		});
	}

	// (d) No interpretation — add the general_feedback negative when markdown
	// cells exist but contain no interpretation language.
	const general = resolveCategory("general_feedback");
	if (
		general &&
		!pre.hasInterpretation &&
		pre.markdownCellCount > 0 &&
		!hasOption(state.selections, general.key, GENERAL_FEEDBACK_NO_INTERPRETATION)
	) {
		state.selections = withSelectionAdded(
			state.selections,
			general.key,
			GENERAL_FEEDBACK_NO_INTERPRETATION,
		);
		fixes.push({
			pass: "evidence-grounded",
			field: `general-negative:${GENERAL_FEEDBACK_NO_INTERPRETATION}`,
			oldValue: null,
			newValue: "checked",
			reason: "preAnalysis found no interpretation language in the markdown cells; checked the no-interpretation negative.",
		});
	}

	// (e) No citations — add the academic_scholarship negative when markdown
	// cells exist but contain no citations.
	const academic = resolveCategory("academic_scholarship");
	if (
		academic &&
		pre.citationCount === 0 &&
		pre.markdownCellCount > 0 &&
		!hasOption(
			state.selections,
			academic.key,
			ACADEMIC_SCHOLARSHIP_NO_CITATIONS,
		)
	) {
		state.selections = withSelectionAdded(
			state.selections,
			academic.key,
			ACADEMIC_SCHOLARSHIP_NO_CITATIONS,
		);
		fixes.push({
			pass: "evidence-grounded",
			field: `academicScholarship-negative:${ACADEMIC_SCHOLARSHIP_NO_CITATIONS}`,
			oldValue: null,
			newValue: "checked",
			reason: "preAnalysis found no citations in the markdown cells; checked the no-citations negative.",
		});
	}
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Apply the 7 deterministic correction passes to a pre-evaluation result.
 *
 * Pure logic — no model calls, no randomness. The input is not mutated; the
 * returned data is a corrected copy, and every change is recorded in the
 * returned result's `fixes` array.
 */
export function postProcessSubmission(opts: PostProcessOptions): {
	data: PostProcessData;
	result: PostProcessResult;
} {
	const state: WorkingState = {
		selections: opts.rubricSelections.map((s) => ({
			categoryKey: s.categoryKey,
			optionKey: s.optionKey,
		})),
		notes: { ...opts.additionalNotes },
		dimensions: opts.dimensions,
		executionRecord: opts.executionRecord,
		preAnalysis: opts.preAnalysis,
	};
	const fixes: PostProcessFix[] = [];

	passFillEmpty(state, fixes); // Pass 1
	passCheckboxTextareaSync(state, fixes); // Pass 2
	passDisallowedLibraryScan(state, fixes); // Pass 3
	passStripPlagiarism(state, fixes); // Pass 4
	passStripFiller(state, fixes); // Pass 5
	passFillTextareas(state, opts.dimensions, fixes); // Pass 6
	passEvidenceGroundedCorrections(state, fixes); // Pass 7

	return {
		data: {
			dimensions: { ...opts.dimensions },
			rubricSelections: state.selections,
			additionalNotes: state.notes,
		},
		result: { submissionId: opts.submissionId, fixes },
	};
}
