/**
 * @file Pre-evaluation worksheet — markdown generation and parsing.
 *
 * The worksheet is the human-in-the-loop artifact of pre-evaluation: a
 * markdown checklist with a `## Context` summary up front and one
 * `## Rubric: {categoryKey} — {categoryTitle}` section per rubric category
 * (positive / negative / neutral checkbox items plus an additional-notes
 * slot). The teacher fills it in — checking `- [x]` boxes and writing notes
 * — and `parseWorksheet` turns the filled document back into rubric
 * selections plus per-category notes.
 *
 * Sub-point texts are copied VERBATIM from the rubric in both directions:
 * the generator emits the exact rubric text, and the parser matches checked
 * texts exactly (after trimming) against the same rubric. When a checked
 * text does not match the section's stated category, the parser falls back
 * to searching ALL categories (an LLM may put coding_concept items under
 * code_formatting). Texts that match nowhere are surfaced in `unmatched` so
 * the caller can retry the category instead of silently dropping teacher
 * input.
 *
 * Standalone module — no server-only imports, safe to unit test directly.
 */

import {
	allSubPoints,
	type Category,
	type MergedRubric,
	type Sentiment,
	type SubPoint,
} from "$lib/types/criteria";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A rubric sub-point selected on the worksheet (resolved to a category). */
export interface WorksheetSelection {
	/** Category that owns the sub-point (resolved via stated + fallback). */
	categoryKey: string;
	/** The rubric sub-point text, verbatim. */
	optionKey: string;
}

/** Context data the worksheet generator summarizes in the `## Context` section. */
export interface WorksheetContext {
	submissionId: string;
	assignmentId: string;
	cellCount: number;
	codeCellCount: number;
	markdownCellCount: number;
	/** From PreAnalysis.issueSummary. */
	preAnalysisSummary: string;
	/** Per-cell comparison tallies; null when pre-evaluation has not run. */
	markerCounts: { same: number; different: number; questionable: number } | null;
	/** Dimension id -> suggested score (Phase 2a); optional. */
	dimensionScores?: Record<string, number>;
	/** All rubric categories. */
	rubric: MergedRubric;
}

/** Result of parsing ONE category section of the worksheet. */
export interface ParseResult {
	/** Checked items resolved to rubric sub-points (categoryKey = where the text was found). */
	selections: WorksheetSelection[];
	/** Additional-notes text for the category (null when absent or empty). */
	notes: string | null;
	/** Checked texts that matched no rubric sub-point anywhere — caller should retry. */
	unmatched: { categoryKey: string; text: string }[];
}

/** Result of parsing a complete worksheet. */
export interface FullParseResult {
	rubricSelections: WorksheetSelection[];
	/** categoryKey -> notes, only for categories that carry notes. */
	additionalNotes: Record<string, string>;
	/** Items that could not be matched — caller should retry. */
	unmatched: { categoryKey: string; text: string }[];
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

/** Level-2 section header introducing a rubric category section. */
function rubricSectionHeader(key: string, title: string): string {
	return `## Rubric: ${key} — ${title}`;
}

/** All sub-points of one sentiment in a category (empty when the list is empty). */
function subPointsFor(category: Category, sentiment: Sentiment): readonly SubPoint[] {
	return category[sentiment].flatMap((mp) => mp.sub_points);
}

/**
 * Generate the markdown pre-evaluation worksheet for a submission.
 *
 * Structure: `# Pre-Evaluation Worksheet: {submissionId}` → `## Context`
 * (assignment, cell counts, pre-analysis summary, marker counts, dimension
 * scores) → one `## Rubric: {key} — {title}` section per category with
 * `### Positive`, `### Negative`, `### Neutral` (only when the category has
 * neutral sub-points), and `### Additional Notes` (placeholder `_(to be
 * filled)_`). Sub-point texts are emitted VERBATIM — the parser matches the
 * same rubric texts.
 */
export function generateWorksheet(ctx: WorksheetContext): string {
	const lines: string[] = [];

	lines.push(`# Pre-Evaluation Worksheet: ${ctx.submissionId}`);
	lines.push("");
	lines.push("## Context");
	lines.push(`- Assignment: ${ctx.assignmentId}`);
	lines.push(
		`- Cells: ${ctx.cellCount} (${ctx.codeCellCount} code, ${ctx.markdownCellCount} markdown)`,
	);
	lines.push(`- Pre-analysis: ${ctx.preAnalysisSummary}`);
	if (ctx.markerCounts) {
		lines.push(
			`- Cell markers: ${ctx.markerCounts.same} same, ${ctx.markerCounts.different} different, ${ctx.markerCounts.questionable} questionable`,
		);
	} else {
		lines.push("- Cell markers: none (pre-evaluation has not run)");
	}
	if (ctx.dimensionScores && Object.keys(ctx.dimensionScores).length > 0) {
		const scores = Object.entries(ctx.dimensionScores)
			.map(([key, value]) => `${key}: ${value}`)
			.join(", ");
		lines.push(`- Dimension scores: ${scores}`);
	}
	lines.push("");

	for (const entry of ctx.rubric.categories) {
		lines.push(rubricSectionHeader(entry.key, entry.category.title));
		lines.push("");
		lines.push("### Positive");
		for (const sp of subPointsFor(entry.category, "positive")) {
			lines.push(`- [ ] ${sp.text}`);
		}
		lines.push("");
		lines.push("### Negative");
		for (const sp of subPointsFor(entry.category, "negative")) {
			lines.push(`- [ ] ${sp.text}`);
		}
		const neutral = subPointsFor(entry.category, "neutral");
		if (neutral.length > 0) {
			lines.push("");
			lines.push("### Neutral");
			for (const sp of neutral) {
				lines.push(`- [ ] ${sp.text}`);
			}
		}
		lines.push("");
		lines.push("### Additional Notes");
		lines.push("");
		lines.push("_(to be filled)_");
		lines.push("");
	}

	return lines.join("\n").trimEnd() + "\n";
}

// ---------------------------------------------------------------------------
// Turn-based validation configuration
// ---------------------------------------------------------------------------

/** One mutual-exclusion pair within a single category. */
export interface MutualExclusionPair {
	/** Sub-point text of the first logical opposite. */
	a: string;
	/** Sub-point text of the second logical opposite. */
	b: string;
	/** Human-readable label for error messages. */
	label?: string;
}

/**
 * Hard-coded mutual-exclusion pairs per category. These are logical opposites:
 * checking both makes the rubric contradictory. The retry loop uses this
 * configuration to demand the model remove one side.
 *
 * Pairs are defined as sub-point texts (verbatim from the rubric). A category
 * MAY contain both positive and negative selections as long as they are not
 * logical opposites of the same aspect — only the pairs below are banned.
 * Multi-way exclusion (e.g. the three blank-lines negatives) is expressed as
 * one pair per negative against the shared positive.
 */
export const MUTUAL_EXCLUSION_PAIRS: Readonly<Record<string, readonly MutualExclusionPair[]>> = {
	code_formatting: [
		{
			a: "imports - libraries were alphabetized",
			b: "imports - not alphabetized",
			label: "import ordering",
		},
		{
			a: "imports - libraries were listed at the notebook's top",
			b: "imports - not listed together at the notebook's top",
			label: "import placement",
		},
		{
			a: "blank lines - consistent and good usage",
			b: "blank lines - missing the required two blank lines after imports and/or around user-defined functions (PEP8)",
			label: "blank lines (PEP8)",
		},
		{
			a: "blank lines - consistent and good usage",
			b: "blank lines - not enough used (e.g., separating ideas and improving readability)",
			label: "blank lines",
		},
		{
			a: "blank lines - consistent and good usage",
			b: "blank lines - too many used (i.e., not concise)",
			label: "blank lines",
		},
		{
			a: "naming - descriptive objects/variables (i.e., human readable)",
			b: "naming - object/variable (e.g., df, data, x, y) is not descriptive enough",
			label: "naming descriptiveness",
		},
		{
			a: "PEP8 guidelines- followed",
			b: "PEP8 - not well followed",
			label: "PEP8 compliance",
		},
		{
			a: "spacing - consistent and correct usage",
			b: "spacing - inconsistent and/or improperly used",
			label: "spacing",
		},
		{
			a: "indentation - consistent and done with 4 spaces",
			b: "indentation - improperly done (i.e., 4 spaces)",
			label: "indentation",
		},
		{
			a: "line length - properly done (e.g., no scrolling is needed)",
			b: "line length - too long (i.e., requiring scrolling)",
			label: "line length",
		},
		{
			a: "commenting - appropriate amount provided (i.e., not excessive or insufficient)",
			b: "commenting - excessive amounts done (e.g., for obvious points), or not relevant (i.e. significantly distracts from the solution's main focus)",
			label: "commenting amount",
		},
		{
			a: "f-string - properly used",
			b: "f-string - not used (e.g., print statements)",
			label: "f-string usage",
		},
	],
	coding_concept: [
		{
			a: "set",
			b: "using 'set' - unique elements",
			label: "set usage",
		},
		{
			a: "tuple",
			b: "using 'tuple' - immutable elements",
			label: "tuple usage",
		},
		{
			a: "looping - 'zip' usage to iterate over two lists",
			b: "looping - use 'zip' to loop over two lists of equal length",
			label: "zip looping",
		},
	],
	jupyter_notebooks: [
		{
			a: "cell structure - good usage to separate ideas (e.g., thoughts, tasks/subtasks, user-defined functions)",
			b: "cell structure - separatation of the tasks, subtasks, or ideas needs to be better",
			label: "cell separation",
		},
		{
			a: "cell structure - good usage to separate ideas (e.g., thoughts, tasks/subtasks, user-defined functions)",
			b: "cell structure - some additional separation of ideas (both code and markdown cells)",
			label: "cell separation",
		},
		{
			a: "code cells - good separation of encode ideas",
			b: "code cells - some additional encoded ideas into separate cells would have been logical",
			label: "code cell separation",
		},
		{
			a: "markdown cells - good usage to communicate ideas, thoughts or workflow",
			b: "markdown cells - are not used, or there is a significant lack of good, informative communication",
			label: "markdown communication",
		},
		{
			a: "markdown cells - good usage to communicate ideas, thoughts or workflow",
			b: "markdown cells - some additional communication would have been more informative",
			label: "markdown communication",
		},
	],
	academic_scholarship: [
		{
			a: "citing - source of information and knowledge",
			b: "citing - missing references for knowledge (e.g., datasets, equations, libraries)",
			label: "citing sources",
		},
		{
			a: "citing - proper ordering within the written text (e.g., ...[1-2]...[3] and not ...[3-4]...[1]...)",
			b: "citing - done out-of-order (e.g., the first citation in your text is not to Reference 1)",
			label: "citation ordering",
		},
		{
			a: "units - input and output numbers have units (e.g., N, kJ, m/s, Hz)",
			b: "units - were not provided when needed",
			label: "units",
		},
		{
			a: "sentences - clear, concise and provides good context (i.e., C^3)",
			b: "sentences - not clean, concise and/or context provided (C^3)",
			label: "sentence clarity",
		},
		{
			a: "sentences - complete written when appropriate (e.g., within markdown cells, docstrings)",
			b: "sentences - incomplete sentences (e.g., capitalization, subject, verb) when needed (including in f-strings)",
			label: "sentence completeness",
		},
	],
	plotting_visualization: [
		{
			a: "axis labels",
			b: "Axis Labels: One or two axis lables are missing or incomplete",
			label: "axis labels",
		},
		{
			a: "title",
			b: "Title: Plot title is missing.",
			label: "plot title",
		},
		{
			a: "including units",
			b: "Units: Missing on axis labels or title.",
			label: "units in plots",
		},
	],
};

/** Validation error kinds surfaced by {@link validateWorksheetSection}. */
export type WorksheetValidationErrorType =
	"unknown" | "mutual_exclusion" | "empty" | "header_mismatch";

/** One validation failure for a worksheet section. */
export interface WorksheetValidationError {
	type: WorksheetValidationErrorType;
	/** Human-readable message for the retry prompt. */
	message: string;
	/** Optional offending checked text(s). */
	items?: string[];
}

/** Result of validating a single category section. */
export interface WorksheetValidationResult {
	/** True when no validation errors were found. */
	ok: boolean;
	/** Errors to send back to the model on a retry. */
	errors: WorksheetValidationError[];
	/** Resolved selections (only meaningful when ok). */
	selections: WorksheetSelection[];
	/** Additional notes text (null when absent or placeholder). */
	notes: string | null;
}

/**
 * Classify a rubric sub-point text by sentiment. Returns null when the text
 * is not a sub-point of the given category.
 */
export function sentimentOfOption(
	category: Category,
	text: string,
): "positive" | "negative" | "neutral" | null {
	if (category.positive.some((mp) => mp.sub_points.some((sp) => sp.text === text))) {
		return "positive";
	}
	if (category.negative.some((mp) => mp.sub_points.some((sp) => sp.text === text))) {
		return "negative";
	}
	if (category.neutral.some((mp) => mp.sub_points.some((sp) => sp.text === text))) {
		return "neutral";
	}
	return null;
}

/**
 * Validate ONE category section of the worksheet — the markdown the model
 * returns for a single category, from its `## Rubric:` header through
 * `### Additional Notes`. The retry loop calls this after every model turn
 * and sends the returned errors back verbatim for repair.
 *
 * Checks, in order:
 *   - `header_mismatch` — the section does not start with `## Rubric: {categoryKey}`.
 *   - `empty` — no checked items at all AND no non-empty additional note.
 *   - `unknown` — a checked text matches no rubric sub-point anywhere.
 *   - `mutual_exclusion` — both texts of a configured pair are checked.
 *
 * Mixed positive + negative selections are NOT an error: a category may
 * contain both as long as the items are not logical opposites (a configured
 * mutual-exclusion pair).
 *
 * The model returns the section WITH its header, while
 * {@link parseWorksheetSection} expects the body only — the header is
 * validated and stripped before delegating.
 */
export function validateWorksheetSection(
	sectionMarkdown: string,
	categoryKey: string,
	rubric: MergedRubric,
): WorksheetValidationResult {
	const errors: WorksheetValidationError[] = [];

	const lines = sectionMarkdown.split("\n");
	const firstLine = lines[0] ?? "";
	const headerMatch = firstLine.match(RUBRIC_SECTION_PATTERN);
	const headerKey = headerMatch ? splitSectionHeader(headerMatch[1]!).key : null;
	if (headerKey !== categoryKey) {
		errors.push({
			type: "header_mismatch",
			message: `Section must start with "## Rubric: ${categoryKey}".`,
		});
	}
	const body = headerMatch ? lines.slice(1).join("\n") : sectionMarkdown;

	const parsed = parseWorksheetSection(body, categoryKey, rubric);

	// b. empty — zero checked items (matched or not) and no non-empty note.
	const checkedCount = parsed.selections.length + parsed.unmatched.length;
	if (checkedCount === 0 && parsed.notes === null) {
		errors.push({
			type: "empty",
			message: `No items are checked and no additional note is written for "${categoryKey}". Choose the single best-matching sub-point and explain why in the notes.`,
		});
	}

	// c. unknown — a checked text matches no rubric sub-point anywhere.
	for (const item of parsed.unmatched) {
		errors.push({
			type: "unknown",
			message: `Checked text "${item.text}" matches no rubric sub-point. Use the exact rubric text.`,
			items: [item.text],
		});
	}

	// d. mutual_exclusion — both sides of a configured pair are checked.
	const checkedTexts = new Set<string>([
		...parsed.selections.map((s) => s.optionKey),
		...parsed.unmatched.map((u) => u.text),
	]);
	for (const pair of MUTUAL_EXCLUSION_PAIRS[categoryKey] ?? []) {
		if (checkedTexts.has(pair.a) && checkedTexts.has(pair.b)) {
			errors.push({
				type: "mutual_exclusion",
				message: `Mutually exclusive items are both checked${pair.label ? ` (${pair.label})` : ""}: "${pair.a}" and "${pair.b}". Remove one.`,
				items: [pair.a, pair.b],
			});
		}
	}

	// e. (removed) — mixed positive + negative sentiment is allowed as long as
	// the items are not logical opposites (handled by the mutual-exclusion
	// pairs above).

	return {
		ok: errors.length === 0,
		errors,
		selections: parsed.selections,
		notes: parsed.notes,
	};
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/** A checked checkbox line: `- [x] text` (also `- [X] text`). */
const CHECKED_ITEM_PATTERN = /^-\s*\[([xX])\]\s*(.+)$/;

/** Any level-2 header — the boundary between worksheet sections. */
const LEVEL2_HEADER_PATTERN = /^## /m;

/** Level-2 header introducing a rubric category section. */
const RUBRIC_SECTION_PATTERN = /^## Rubric:\s*(.+)$/;

const ADDITIONAL_NOTES_HEADER = "### Additional Notes";

/** The generator's unfilled notes placeholder — treated as \"no notes\". */
const NOTES_PLACEHOLDER = "_(to be filled)_";

/** Whether the category contains the given sub-point text (exact match). */
function hasSubPoint(category: Category, text: string): boolean {
	return allSubPoints(category).some((sp) => sp.text === text);
}

/**
 * Resolve a checked text to a rubric sub-point. Tries the section's stated
 * category first (exact match), then falls back to ALL categories — an LLM
 * filling the worksheet may place items under the wrong section. Returns
 * null when the text matches nowhere.
 */
function resolveSubPoint(
	rubric: MergedRubric,
	statedCategoryKey: string,
	text: string,
): WorksheetSelection | null {
	const stated = rubric.categories.find((entry) => entry.key === statedCategoryKey);
	if (stated && hasSubPoint(stated.category, text)) {
		return { categoryKey: statedCategoryKey, optionKey: text };
	}
	for (const entry of rubric.categories) {
		if (hasSubPoint(entry.category, text)) {
			return { categoryKey: entry.key, optionKey: text };
		}
	}
	return null;
}

/**
 * Extract the additional-notes text: everything after `### Additional Notes`
 * up to the next level-2 header (or the end of the section). Returns null
 * when the section has no notes header, the notes are empty, or they still
 * hold the unfilled placeholder.
 */
function extractNotes(sectionBody: string): string | null {
	const headerIndex = sectionBody.indexOf(ADDITIONAL_NOTES_HEADER);
	if (headerIndex === -1) return null;

	const rest = sectionBody.slice(headerIndex + ADDITIONAL_NOTES_HEADER.length);
	const nextHeader = rest.search(LEVEL2_HEADER_PATTERN);
	const notes = (nextHeader === -1 ? rest : rest.slice(0, nextHeader)).trim();

	if (notes === "" || notes === NOTES_PLACEHOLDER) return null;
	return notes;
}

/**
 * Parse ONE category section of the worksheet (the content under a
 * `## Rubric:` header, without the header itself).
 *
 * Extracts every `- [x]` item, validates the text against the stated
 * category (exact match after trim), and falls back to all categories when
 * the stated one does not contain the text. Checked texts that match
 * nowhere land in `unmatched` for the caller to retry. Also extracts the
 * additional-notes text (everything after `### Additional Notes` until the
 * next level-2 header or the end).
 */
export function parseWorksheetSection(
	sectionMarkdown: string,
	categoryKey: string,
	rubric: MergedRubric,
): ParseResult {
	const selections: WorksheetSelection[] = [];
	const unmatched: { categoryKey: string; text: string }[] = [];

	// The section body ends at the next level-2 header — content after it
	// (e.g. the next `## Rubric:` section) belongs to another section.
	const nextHeader = sectionMarkdown.search(LEVEL2_HEADER_PATTERN);
	const body = nextHeader === -1 ? sectionMarkdown : sectionMarkdown.slice(0, nextHeader);

	const notes = extractNotes(body);

	for (const line of body.split("\n")) {
		const match = line.match(CHECKED_ITEM_PATTERN);
		if (!match) continue;
		const text = match[2]!.trim();
		const resolved = resolveSubPoint(rubric, categoryKey, text);
		if (resolved) {
			selections.push(resolved);
		} else {
			unmatched.push({ categoryKey, text });
		}
	}

	return { selections, notes, unmatched };
}

/**
 * Split a `## Rubric:` header line into category key and title. The
 * generator writes `{key} — {title}` (em dash); a plain hyphen separator is
 * tolerated for LLM-written worksheets.
 */
function splitSectionHeader(header: string): { key: string; title: string } {
	const emDash = header.indexOf(" — ");
	if (emDash !== -1) {
		return { key: header.slice(0, emDash).trim(), title: header.slice(emDash + 3).trim() };
	}
	const hyphen = header.indexOf(" - ");
	if (hyphen !== -1) {
		return { key: header.slice(0, hyphen).trim(), title: header.slice(hyphen + 3).trim() };
	}
	// No separator — the whole header must be the category key.
	return { key: header.trim(), title: header.trim() };
}

/**
 * Resolve the category a section header refers to. Matches the header's key
 * against rubric category keys; when the key is unknown, falls back to
 * matching the header's title against category titles (the LLM may drop the
 * key). Returns null when neither matches — the section is skipped.
 */
function resolveCategoryKey(rubric: MergedRubric, key: string, title: string): string | null {
	if (rubric.categories.some((entry) => entry.key === key)) return key;
	const byTitle = rubric.categories.find((entry) => entry.category.title === title);
	return byTitle ? byTitle.key : null;
}

/**
 * Parse a complete worksheet: split it into per-category sections at
 * `## Rubric:` headers, delegate each to {@link parseWorksheetSection}, and
 * accumulate selections, per-category notes, and unmatched items. Content
 * before the first rubric section (the `## Context` block) is ignored.
 */
export function parseWorksheet(fullMarkdown: string, rubric: MergedRubric): FullParseResult {
	const rubricSelections: WorksheetSelection[] = [];
	const additionalNotes: Record<string, string> = {};
	const unmatched: { categoryKey: string; text: string }[] = [];

	const sections: { key: string; title: string; markdown: string }[] = [];
	let current: { key: string; title: string; lines: string[] } | null = null;

	const flush = (): void => {
		if (current) {
			sections.push({
				key: current.key,
				title: current.title,
				markdown: current.lines.join("\n"),
			});
			current = null;
		}
	};

	for (const line of fullMarkdown.split("\n")) {
		const header = line.match(RUBRIC_SECTION_PATTERN);
		if (header) {
			flush();
			const { key, title } = splitSectionHeader(header[1]!);
			current = { key, title, lines: [] };
		} else if (current) {
			current.lines.push(line);
		}
	}
	flush();

	for (const section of sections) {
		const categoryKey = resolveCategoryKey(rubric, section.key, section.title);
		// A section whose header names no known category cannot be matched
		// against the rubric — skip it entirely (nothing to retry against).
		if (!categoryKey) continue;

		const result = parseWorksheetSection(section.markdown, categoryKey, rubric);
		rubricSelections.push(...result.selections);
		unmatched.push(...result.unmatched);
		if (result.notes !== null) {
			additionalNotes[categoryKey] = result.notes;
		}
	}

	return { rubricSelections, additionalNotes, unmatched };
}
