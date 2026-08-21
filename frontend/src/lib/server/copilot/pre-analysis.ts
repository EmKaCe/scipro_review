/**
 * @file Deterministic pre-analysis of a student submission — no LLM calls.
 *
 * Produces structured findings that the LLM pipeline phases inject as
 * grounded context, replacing the "hope the model notices" approach with
 * concrete signals:
 *   - non-descriptive variable names (df, x, y, data, etc.)
 *   - import ordering violations
 *   - markdown density and citation count
 *   - unused imports
 *   - execution errors
 *
 * Every finding is a plain boolean or a string list — cheap to compute,
 * fast to serialize, and unambiguous for the LLM to act on.
 */

import type { ExecutedCell } from "$lib/server/executor-client";

// ---------------------------------------------------------------------------
// Wire shape
// ---------------------------------------------------------------------------

export interface PreAnalysis {
	/** Single/double-character variable names found in code cells. */
	nonDescriptiveNames: string[];
	/**
	 * @deprecated Split-block import-ordering heuristic (from- vs import-
	 * blocks sorted separately) — known to miss real ordering violations.
	 * Use {@link importsAlphabetized} (whole-list check) instead.
	 */
	importsNotAlphabetized: boolean;
	/**
	 * True when ALL import lines across ALL code cells are alphabetized as
	 * ONE list (case-insensitive sort of the full line text) — the
	 * ground-truth check. Replaces the deprecated split-block heuristic.
	 */
	importsAlphabetized: boolean;
	/** Libraries from the disallowed list that appear in import statements. */
	disallowedImports: string[];
	/** Imports that appear in import statements but are never used in code. */
	unusedImports: string[];
	/** Count of code cells. */
	codeCellCount: number;
	/** Count of markdown cells. */
	markdownCellCount: number;
	/** Count of [N] or (Author, Year) citation patterns in markdown. */
	citationCount: number;
	/** True when markdown cells contain interpretation language. */
	hasInterpretation: boolean;
	/** Count of cells with execution errors. */
	errorCount: number;
	/** Summary line for the pipeline prompt, e.g. "3 issues found". */
	issueSummary: string;
}

// ---------------------------------------------------------------------------
// Detectors
// ---------------------------------------------------------------------------

/** Names that are acceptable as single letters in specific contexts. */
const CONTEXT_OK_SINGLE_LETTERS = new Set(["i", "j", "k", "n", "m", "p"]);

/** Regex matching a Python import statement: import X or from X import Y */
const IMPORT_STMT_RE =
	/(?:^|\n)(?:import\s+([\w.]+(?:\s*,\s*[\w.]+)*)|from\s+([\w.]+)\s+import\s+(.+))/g;

/** Words that indicate interpretation / analysis in markdown. */
const INTERPRETATION_WORDS =
	/\b(mean|median|std|standard deviation|correlation|trend|pattern|significant|outlier|cluster[sd]?|indicates?|shows? that|suggests?|implies?|therefore|because|due to|likely|observed|compare|higher|lower|increase|decrease)\b/i;

/** Citation patterns: [1], [1-3], (Author, 2020) */
const CITATION_RE = /\[[\d,\-\s]+\]|\(\w+,\s*\d{4}\)/g;

/** Regex matching a Python variable assignment: name = ... (line-start only). */
const ASSIGN_RE = /^([a-zA-Z_]\w*)\s*=(?!=)/g;

/**
 * Extract variable names from Python assignment statements.
 * Flags single/double-character names (except loop counters i, j, k, n, m, p).
 *
 * Keyword arguments inside multi-line function calls (e.g. `f=plume_model`,
 * `s=28` on their own line) are NOT variable declarations — a line whose
 * preceding non-empty line ended with `(` or `,` is a call-argument
 * continuation, so its `name=value` pairs are skipped.
 */
function extractNonDescriptiveNames(source: string): string[] {
	const found = new Set<string>();
	const lines = source.split("\n");
	let inCallContinuation = false;
	for (const line of lines) {
		const trimmed = line.trim();
		if (inCallContinuation && trimmed.length > 0) {
			// Inside a multi-line call argument list — these are kwargs, not
			// declarations. Still update continuation state below.
		} else {
			for (const match of trimmed.matchAll(ASSIGN_RE)) {
				const name = match[1]!;
				if (name.length <= 2 && !CONTEXT_OK_SINGLE_LETTERS.has(name)) {
					found.add(name);
				}
			}
		}
		// A line ending with `(`, `,`, or `\` continues a call/expression on
		// the next line. `def`/`class`/`if`/`for`/`while` headers ending in
		// `(` are blocks, not calls — but their params are declarations, so
		// treat the first line after as a call-continuation too (the params
		// are never assignments anyway, and skipping them is safe).
		inCallContinuation =
			/[,(]\s*(?:#.*)?$/.test(trimmed) ||
			(/\\\s*$/.test(trimmed) && !/^\s*(?:def|class|if|for|while|with)\b/.test(line));
	}
	return [...found].sort();
}

/** Extract the imported-symbol names from an import statement line. */
function extractImportedNames(line: string): string[] {
	const names: string[] = [];
	// "from X import a, b, c"
	const fromMatch = line.match(/from\s+\S+\s+import\s+(.+)/);
	if (fromMatch) {
		const parts = fromMatch[1]!.split(",");
		for (const p of parts) {
			const cleaned = p.replace(/as\s+\w+/i, "").trim();
			if (cleaned) names.push(cleaned);
		}
		return names;
	}
	// "import a, b, c"
	const impMatch = line.match(/import\s+(.+)/);
	if (impMatch) {
		const parts = impMatch[1]!.split(",");
		for (const p of parts) {
			const cleaned = p.replace(/as\s+\w+/i, "").trim();
			if (cleaned) names.push(cleaned);
		}
	}
	return names;
}

/**
 * Check whether imports in code cells are alphabetically ordered within
 * their groups (stdlib / third-party / local). Simple heuristic: split
 * by blank line, check each group is sorted.
 */
function checkImportOrder(codeSources: string[]): boolean {
	const allImports: string[] = [];
	for (const src of codeSources) {
		for (const line of src.split("\n")) {
			const trimmed = line.trim();
			if (trimmed.startsWith("import ") || trimmed.startsWith("from ")) {
				allImports.push(trimmed);
			}
		}
	}
	if (allImports.length <= 1) return true;

	// Check each contiguous import block is sorted
	let blockStart = 0;
	for (let i = 1; i <= allImports.length; i++) {
		const isNewBlock =
			i === allImports.length ||
			allImports[i]!.startsWith("from") !== allImports[i - 1]!.startsWith("from");
		if (isNewBlock) {
			const block = allImports.slice(blockStart, i);
			const sorted = [...block].sort((a, b) =>
				a.toLowerCase().localeCompare(b.toLowerCase()),
			);
			for (let j = 0; j < block.length; j++) {
				if (block[j] !== sorted[j]) return false;
			}
			blockStart = i;
		}
	}
	return true;
}

/**
 * Whether ALL import lines across ALL code cells are alphabetized as ONE
 * list — `import` and `from` lines collected together, sorted
 * case-insensitively by the full line text. This is the ground-truth
 * definition (the deprecated split-block heuristic in
 * {@link checkImportOrder} sorts from- and import-blocks separately, which
 * hides real ordering violations).
 */
export function checkImportsAlphabetizedWholeList(cells: ExecutedCell[]): boolean {
	const importLines: string[] = [];
	for (const cell of cells) {
		if (cell.type !== "code") continue;
		for (const line of (cell.source ?? "").split("\n")) {
			const trimmed = line.trim();
			// Real import statements only — markdown prose like "from a
			// cluster centre" must not count.
			if (/^(import\s+\S|from\s+\S+\s+import\s+\S)/.test(trimmed)) {
				importLines.push(trimmed);
			}
		}
	}
	if (importLines.length <= 1) return true;
	const sorted = [...importLines].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
	return importLines.every((line, i) => line === sorted[i]);
}

/**
 * Find imports that match a list of disallowed libraries. Extracts the
 * top-level module name from each import line across all code cells
 * (`import sklearn` → `sklearn`, `from sklearn.cluster import KMeans` →
 * `sklearn`) and returns the matching modules, deduplicated and sorted.
 * Returns an empty list when the disallowed list is empty.
 */
export function detectDisallowedImports(
	cells: ExecutedCell[],
	disallowedLibraries: string[],
): string[] {
	if (disallowedLibraries.length === 0) return [];
	const disallowed = new Set(disallowedLibraries);
	const found = new Set<string>();
	for (const cell of cells) {
		if (cell.type !== "code") continue;
		for (const line of (cell.source ?? "").split("\n")) {
			const trimmed = line.trim();
			const moduleName =
				trimmed.match(/^from\s+([\w.]+)\s+import/)?.[1] ??
				trimmed.match(/^import\s+([\w.]+)/)?.[1];
			if (!moduleName) continue;
			const topLevel = moduleName.split(".")[0]!;
			if (disallowed.has(topLevel) || disallowed.has(moduleName)) {
				found.add(topLevel);
			}
		}
	}
	return [...found].sort();
}

/**
 * Find imported symbols that are never used in the rest of the code.
 * Checks each imported name against the full source (all code cells).
 */
function findUnusedImports(codeSources: string[]): string[] {
	const imported: Map<string, string> = new Map(); // symbol -> module
	const allSource = codeSources.join("\n");

	for (const src of codeSources) {
		for (const line of src.split("\n")) {
			if (line.trim().startsWith("import ") || line.trim().startsWith("from ")) {
				const moduleName =
					line.match(/from\s+(\S+)/)?.[1] ?? line.match(/import\s+(\S+)/)?.[1] ?? "";
				for (const name of extractImportedNames(line)) {
					imported.set(name, moduleName);
				}
			}
		}
	}

	const unused: string[] = [];
	for (const [symbol, module] of imported) {
		// Remove the import lines themselves from the search corpus
		const codeWithoutImports = codeSources
			.map((s) =>
				s
					.split("\n")
					.filter((l) => !l.trim().startsWith("import ") && !l.trim().startsWith("from "))
					.join("\n"),
			)
			.join("\n");
		// Check if symbol appears anywhere outside import statements
		if (
			!new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(
				codeWithoutImports,
			)
		) {
			unused.push(symbol);
		}
	}
	return unused;
}

/** Count citations and check for interpretation language in markdown cells. */
function analyzeMarkdown(mdSources: string[]): {
	citationCount: number;
	hasInterpretation: boolean;
} {
	let citationCount = 0;
	let hasInterpretation = false;

	for (const src of mdSources) {
		const matches = src.match(CITATION_RE);
		if (matches) citationCount += matches.length;
		if (!hasInterpretation && INTERPRETATION_WORDS.test(src)) {
			hasInterpretation = true;
		}
	}

	return { citationCount, hasInterpretation };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Analyze a submission's executed cells and produce deterministic findings.
 * Zero LLM calls — pure regex + string analysis.
 *
 * `disallowedLibraries` is optional (defaults to none): when provided, any
 * import matching one of those libraries is recorded in `disallowedImports`.
 */
export function analyzeSubmission(
	cells: ExecutedCell[],
	disallowedLibraries: string[] = [],
): PreAnalysis {
	const codeCells = cells.filter((c) => c.type === "code");
	const mdCells = cells.filter((c) => c.type === "markdown");

	const codeSources = codeCells.map((c) => c.source);
	const mdSources = mdCells.map((c) => c.source);

	// Variable names: scan all code cells
	const allNonDescriptive = new Set<string>();
	for (const src of codeSources) {
		for (const name of extractNonDescriptiveNames(src)) {
			allNonDescriptive.add(name);
		}
	}

	const nonDescriptiveNames = [...allNonDescriptive].sort();
	const importsNotAlphabetized = !checkImportOrder(codeSources);
	const importsAlphabetized = checkImportsAlphabetizedWholeList(cells);
	const disallowedImports = detectDisallowedImports(cells, disallowedLibraries);
	const unusedImports = findUnusedImports(codeSources);
	const markdown = analyzeMarkdown(mdSources);
	const errorCount = cells.filter((c) => c.error != null && c.error.length > 0).length;

	// Build summary
	const issues: string[] = [];
	if (nonDescriptiveNames.length > 0) {
		issues.push(
			`${nonDescriptiveNames.length} non-descriptive variable name(s): ${nonDescriptiveNames.join(", ")}`,
		);
	}
	if (importsNotAlphabetized) {
		issues.push("imports are not alphabetically ordered");
	}
	if (disallowedImports.length > 0) {
		issues.push(
			`${disallowedImports.length} disallowed import(s): ${disallowedImports.join(", ")}`,
		);
	}
	if (unusedImports.length > 0) {
		issues.push(`${unusedImports.length} unused import(s): ${unusedImports.join(", ")}`);
	}
	if (markdown.citationCount === 0 && mdCells.length > 0) {
		issues.push("no citations found in markdown cells");
	}
	if (mdCells.length > 0 && !markdown.hasInterpretation) {
		issues.push("no interpretation language detected in markdown");
	}
	if (errorCount > 0) {
		issues.push(`${errorCount} cell(s) with execution errors`);
	}

	return {
		nonDescriptiveNames,
		importsNotAlphabetized,
		importsAlphabetized,
		disallowedImports,
		unusedImports,
		codeCellCount: codeCells.length,
		markdownCellCount: mdCells.length,
		citationCount: markdown.citationCount,
		hasInterpretation: markdown.hasInterpretation,
		errorCount,
		issueSummary:
			issues.length > 0
				? `${issues.length} issue(s) found: ${issues.join("; ")}`
				: "no deterministic issues detected",
	};
}
