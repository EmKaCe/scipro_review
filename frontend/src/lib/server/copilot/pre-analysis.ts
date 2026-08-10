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
	/** True when imports are not alphabetically ordered within groups. */
	importsNotAlphabetized: boolean;
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

/** Regex matching a Python variable assignment: name = ... */
const ASSIGN_RE = /(?:^|\n)\s*([a-zA-Z_]\w*)\s*=/g;

/** Regex matching a Python import statement: import X or from X import Y */
const IMPORT_STMT_RE = /(?:^|\n)(?:import\s+([\w.]+(?:\s*,\s*[\w.]+)*)|from\s+([\w.]+)\s+import\s+(.+))/g;

/** Words that indicate interpretation / analysis in markdown. */
const INTERPRETATION_WORDS = /\b(mean|median|std|standard deviation|correlation|trend|pattern|significant|outlier|cluster[sd]?|indicates?|shows? that|suggests?|implies?|therefore|because|due to|likely|observed|compare|higher|lower|increase|decrease)\b/i;

/** Citation patterns: [1], [1-3], (Author, 2020) */
const CITATION_RE = /\[[\d,\-\s]+\]|\(\w+,\s*\d{4}\)/g;

/**
 * Extract variable names from Python assignment statements.
 * Flags single/double-character names (except loop counters i, j, k, n, m, p).
 */
function extractNonDescriptiveNames(source: string): string[] {
	const found = new Set<string>();
	for (const match of source.matchAll(ASSIGN_RE)) {
		const name = match[1]!;
		if (name.length <= 2 && !CONTEXT_OK_SINGLE_LETTERS.has(name)) {
			found.add(name);
		}
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
			(allImports[i]!.startsWith("from") !== allImports[i - 1]!.startsWith("from"));
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
					line.match(/from\s+(\S+)/)?.[1] ??
					line.match(/import\s+(\S+)/)?.[1] ??
					"";
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
		if (!new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(codeWithoutImports)) {
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
 */
export function analyzeSubmission(cells: ExecutedCell[]): PreAnalysis {
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
	const unusedImports = findUnusedImports(codeSources);
	const markdown = analyzeMarkdown(mdSources);
	const errorCount = cells.filter((c) => c.error != null && c.error.length > 0).length;

	// Build summary
	const issues: string[] = [];
	if (nonDescriptiveNames.length > 0) {
		issues.push(`${nonDescriptiveNames.length} non-descriptive variable name(s): ${nonDescriptiveNames.join(", ")}`);
	}
	if (importsNotAlphabetized) {
		issues.push("imports are not alphabetically ordered");
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
