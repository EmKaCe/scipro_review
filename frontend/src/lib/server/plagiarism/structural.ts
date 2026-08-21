/**
 * @file Structural plagiarism comparison engine (pure TypeScript).
 *
 * Deterministic, LLM-free pairwise comparison of Jupyter notebook submissions
 * using token n-gram / Jaccard overlap:
 *
 *   1. Each code cell is normalized (docstrings + comments stripped,
 *      whitespace collapsed) and tokenized (Python keywords, builtins and
 *      pure numbers removed — boilerplate resistance).
 *   2. Per-cell token n-grams (default 3, configurable 2–5) form the cell's
 *      fingerprint; cell similarity is the Jaccard index of two cells'
 *      n-gram sets. Cells with a similarity >= CELL_MATCH_THRESHOLD (0.5)
 *      are recorded in `matchedCells`.
 *   3. `cellOverlap` is the share of cells in the *smaller* notebook that
 *      have a structural match in the larger one (distinct cells).
 *   4. `notebookOverlap` is the Jaccard index of the two whole-notebook
 *      n-gram sets (all code cells combined).
 *   5. Per-pair `flags` and `details` capture import / variable / comment
 *      overlap and cell-structure similarity (plan 3d data model).
 *
 * The engine itself is pure: no I/O. Notebooks enter as `NotebookInput`
 * (see `loadAssignmentNotebooks()` at the bottom of this file for the
 * disk-backed loader used by the API routes).
 *
 * Markdown cells are intentionally excluded from n-gram comparison: in this
 * course the assignment sheet is embedded in the notebooks as markdown
 * template cells, so including them would inflate every pair's similarity.
 *
 * This module runs only on the SvelteKit server (`$lib/server/`).
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import { getDataDir, listSubmissions } from "../metadata";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One cell of a notebook as consumed by the engine (pure, no index needed). */
export interface NotebookCellInput {
	/** "code" or "markdown" (anything else is treated as code). */
	type?: string;
	/** Cell source as a single string (the loader joins line arrays). */
	source: string;
}

/** Minimal notebook shape the engine compares. */
export interface NotebookInput {
	studentId: string;
	cells: NotebookCellInput[];
}

/** Per-cell fingerprint derived by `fingerprintNotebook`. */
export interface CellFingerprint {
	/** 0-based position in the notebook. */
	index: number;
	type: "code" | "markdown";
	/** Normalized source (comments/docstrings stripped, whitespace collapsed). */
	normalizedSource: string;
	/** Sorted, de-duplicated token n-grams (code cells only). */
	ngrams: string[];
	ngramSet: Set<string>;
	/** Normalized comment strings extracted from the raw source. */
	comments: string[];
	/** Top-level package names from import/from statements. */
	imports: string[];
	/** Best-effort extracted variable/function/class names. */
	variables: string[];
}

/** Whole-notebook fingerprint. */
export interface NotebookFingerprint {
	studentId: string;
	cells: CellFingerprint[];
	cellCount: number;
	/** Union of all code-cell n-gram sets. */
	notebookNgrams: Set<string>;
	importSet: Set<string>;
	variableSet: Set<string>;
	commentSet: Set<string>;
}

/** One matched cell pair (similarity >= CELL_MATCH_THRESHOLD). */
export interface MatchedCell {
	cellIndexA: number;
	cellIndexB: number;
	/** Jaccard similarity of the two cells' n-gram sets, 0..1. */
	similarity: number;
}

export interface PlagiarismPairDetails {
	/** |cellCountA - cellCountB|. */
	cellCountDiff: number;
	sharedVariableNames: string[];
	sharedComments: string[];
	sharedImports: string[];
}

/**
 * One compared pair of submissions. `cellOverlap` / `notebookOverlap` are
 * the structural scores from this engine; `semanticScore` / `semanticVerdict`
 * are filled in by the semantic pass (absent when not run).
 */
export interface PlagiarismPair {
	/** Canonical ordering: studentA < studentB (localeCompare). */
	studentA: string;
	studentB: string;
	/** 0..1 — fraction of the smaller notebook's cells with a match. */
	cellOverlap: number;
	/** 0..1 — Jaccard of whole-notebook token n-gram sets. */
	notebookOverlap: number;
	/** Matched cell pairs, sorted by similarity desc (capped). */
	matchedCells: MatchedCell[];
	/** e.g. ["shared_imports", "shared_variables", "shared_comments", "same_cell_structure"]. */
	flags: string[];
	details: PlagiarismPairDetails;
	/** 0..1 — semantic score from the KI Connect pass (optional). */
	semanticScore?: number;
	/** Verdict text from the KI Connect pass (optional). */
	semanticVerdict?: string;
	/**
	 * Teacher review state (P3-1). Absent = "unreviewed". Persisted
	 * server-side with the cached result so reloads/export survive.
	 */
	reviewStatus?: PairReviewStatus;
}

/**
 * Teacher review state for a plagiarism pair (P3-1). Defaults to
 * "unreviewed" when absent (old caches have no field). Review is
 * per-pair, never per-submission — one submission can be flagged
 * against several others, and each pair resolves independently.
 */
export type PairReviewStatus = "unreviewed" | "accepted" | "dismissed" | "ignored";

/** Resolve a pair's review status, defaulting absent values to "unreviewed". */
export function reviewStatusOf(pair: PlagiarismPair): PairReviewStatus {
	return pair.reviewStatus ?? "unreviewed";
}

/** Severity classification for a pair (see `classifyPair`). */
export type PairSeverity = "high" | "medium" | "low" | "none";

export interface StructuralOptions {
	/**
	 * Token n-gram size, 2–5 (default 3). Lower n catches more (and more
	 * trivial) overlap; higher n only catches near-verbatim copying.
	 */
	ngramSize?: number;
	/** Cap on `matchedCells` per pair (default 50, safety for huge notebooks). */
	maxMatchedCells?: number;
}

// ---------------------------------------------------------------------------
// Threshold constants (documented policy — tune here, not in callers)
// ---------------------------------------------------------------------------

export const DEFAULT_NGRAM_SIZE = 3;
export const MIN_NGRAM_SIZE = 2;
export const MAX_NGRAM_SIZE = 5;

/** Per-cell similarity at/above which a cell pair counts as a match. */
export const CELL_MATCH_THRESHOLD = 0.5;
/** cellOverlap at/above which a pair is flagged (route returns these). */
export const FLAG_THRESHOLD = 0.35;
/** notebookOverlap at/above which a pair is flagged. */
export const NOTEBOOK_FLAG_THRESHOLD = 0.5;
/** cellOverlap at/above which a pair is classified "high". */
export const HIGH_THRESHOLD = 0.6;
/** cellOverlap at/above which a pair is classified "low" (below = noise). */
export const LOW_THRESHOLD = 0.15;
/** Import-set Jaccard at/above which the shared_imports flag fires. */
export const IMPORT_FLAG_THRESHOLD = 0.5;
/** Variable-set Jaccard at/above which the shared_variables flag fires. */
export const VARIABLE_FLAG_THRESHOLD = 0.5;
/** Comment-set Jaccard at/above which the shared_comments flag fires. */
export const COMMENT_FLAG_THRESHOLD = 0.5;
/** Matched-cell coverage at/above which same_cell_structure fires. */
export const STRUCTURE_MATCH_COVERAGE = 0.8;
/** Cap on shared-* arrays in `details`. */
export const MAX_SHARED_ITEMS = 20;
export const DEFAULT_MAX_MATCHED_CELLS = 50;
/** Weight of the semantic score in `combinedScore` (structural = 1 - weight). */
export const COMBINED_SEMANTIC_WEIGHT = 0.3;

// ---------------------------------------------------------------------------
// Tokenization & normalization (pure)
// ---------------------------------------------------------------------------

/** Python keywords — shared boilerplate that must not create matches. */
const PYTHON_KEYWORDS = new Set([
	"and",
	"as",
	"assert",
	"async",
	"await",
	"break",
	"class",
	"continue",
	"def",
	"del",
	"elif",
	"else",
	"except",
	"finally",
	"for",
	"from",
	"global",
	"if",
	"import",
	"in",
	"is",
	"lambda",
	"nonlocal",
	"not",
	"or",
	"pass",
	"raise",
	"return",
	"try",
	"while",
	"with",
	"yield",
	"True",
	"False",
	"None",
]);

/** Common builtins — same rationale as keywords. */
const PYTHON_BUILTINS = new Set([
	"abs",
	"all",
	"any",
	"bool",
	"dict",
	"enumerate",
	"filter",
	"float",
	"int",
	"isinstance",
	"len",
	"list",
	"map",
	"max",
	"min",
	"open",
	"print",
	"range",
	"reversed",
	"round",
	"set",
	"sorted",
	"str",
	"sum",
	"super",
	"tuple",
	"type",
	"zip",
]);

const TOKEN_RE = /[\p{L}\p{N}_]+/gu;
const INLINE_COMMENT_RE = /#[^\n]*/g;
const FULL_LINE_COMMENT_RE = /^[ \t]*#[^\n]*$/gm;
const TRIPLE_DOUBLE_QUOTE_RE = /"""[\s\S]*?"""/g;
const TRIPLE_SINGLE_QUOTE_RE = /'''[\s\S]*?'''/g;
const IMPORT_RE = /^\s*(?:import|from)\s+([A-Za-z_]\w*)/gm;
const ASSIGN_RE = /(?:^|[^.\w])([A-Za-z_]\w*)\s*=(?!=)/gm;
const FOR_RE = /\bfor\s+([A-Za-z_]\w*)\s+in\b/g;
const DEF_RE = /\b(?:def|class)\s+([A-Za-z_]\w*)/g;
const AS_RE = /\b(?:import|from)[^\n]*?\bas\s+([A-Za-z_]\w*)/g;

function collapseWhitespace(value: string): string {
	return value.replace(/\s+/g, " ");
}

/**
 * Best-effort docstring removal. Handles module/function/class docstrings;
 * a `#` or quote sequence inside a string literal is a documented limitation
 * (no Python parser here — this is a fingerprint, not an AST).
 */
export function stripDocstrings(source: string): string {
	return source.replace(TRIPLE_DOUBLE_QUOTE_RE, " ").replace(TRIPLE_SINGLE_QUOTE_RE, " ");
}

/**
 * Best-effort comment removal: full-line comments, then inline `# ...`.
 * Comments inside string literals are stripped too (documented limitation).
 */
export function stripComments(source: string): string {
	return source.replace(FULL_LINE_COMMENT_RE, "").replace(INLINE_COMMENT_RE, "");
}

/** Normalize a code cell: docstrings, comments, whitespace. */
export function normalizeCode(source: string): string {
	return collapseWhitespace(stripComments(stripDocstrings(source))).trim();
}

/**
 * Tokenize normalized source into comparison tokens: identifiers and
 * numbers, minus Python keywords/builtins and pure-numeric tokens.
 * Case is preserved (renaming a variable changes the tokens).
 */
export function tokenize(source: string): string[] {
	const tokens: string[] = [];
	for (const match of source.matchAll(TOKEN_RE)) {
		const token = match[0];
		if (/^\d+$/.test(token)) continue;
		if (PYTHON_KEYWORDS.has(token)) continue;
		if (PYTHON_BUILTINS.has(token)) continue;
		tokens.push(token);
	}
	return tokens;
}

/** Sliding-window n-grams over tokens (empty when fewer than n tokens). */
export function ngramsOf(tokens: string[], n: number): string[] {
	const out: string[] = [];
	for (let i = 0; i + n <= tokens.length; i++) {
		out.push(tokens.slice(i, i + n).join(" "));
	}
	return out;
}

/** Normalized comment strings (lowercased, whitespace collapsed). */
export function extractComments(source: string): string[] {
	const out = new Set<string>();
	for (const line of source.split("\n")) {
		const comment = commentTextOf(line);
		if (comment) out.add(comment);
	}
	return [...out].sort();
}

/**
 * Best-effort comment text of one source line: full-line comments
 * (`# foo`) and trailing inline comments (`x = 1  # foo`). A `#` inside
 * a quoted string is not a comment. Documented limitation: no awareness
 * of triple-quoted strings spanning lines.
 */
function commentTextOf(line: string): string {
	const trimmed = line.trim();
	if (!trimmed.includes("#")) return "";
	let inString: "'" | '"' | null = null;
	for (let i = 0; i < trimmed.length; i++) {
		const ch = trimmed[i]!;
		if (inString) {
			if (ch === "\\") {
				i++; // skip escaped char
			} else if (ch === inString) {
				inString = null;
			}
			continue;
		}
		if (ch === "'" || ch === '"') {
			inString = ch;
			continue;
		}
		if (ch === "#") {
			const comment = collapseWhitespace(trimmed.slice(i + 1))
				.toLowerCase()
				.trim();
			return comment;
		}
	}
	return "";
}

/** Top-level package names from import/from statements (sorted, unique). */
export function extractImports(source: string): string[] {
	const out = new Set<string>();
	for (const match of source.matchAll(IMPORT_RE)) {
		out.add(match[1]!);
	}
	return [...out].sort();
}

/**
 * Best-effort identifier extraction: assignment targets, for-loop variables,
 * def/class names and import aliases. Not an AST — documented limitation.
 */
export function extractVariables(source: string): string[] {
	const out = new Set<string>();
	const add = (name: string) => {
		if (!PYTHON_KEYWORDS.has(name) && !PYTHON_BUILTINS.has(name)) out.add(name);
	};
	for (const re of [ASSIGN_RE, FOR_RE, DEF_RE, AS_RE]) {
		for (const match of source.matchAll(re)) {
			add(match[1]!);
		}
	}
	return [...out].sort();
}

// ---------------------------------------------------------------------------
// Fingerprinting (pure)
// ---------------------------------------------------------------------------

function resolveNgramSize(n: number | undefined): number {
	if (n === undefined) return DEFAULT_NGRAM_SIZE;
	if (!Number.isInteger(n) || n < MIN_NGRAM_SIZE || n > MAX_NGRAM_SIZE) {
		throw new RangeError(
			`ngramSize must be an integer between ${MIN_NGRAM_SIZE} and ${MAX_NGRAM_SIZE}, got ${n}`,
		);
	}
	return n;
}

function round4(value: number): number {
	return Math.round(value * 10_000) / 10_000;
}

/** Derive the per-cell + whole-notebook fingerprint of a submission. */
export function fingerprintNotebook(
	input: NotebookInput,
	opts: StructuralOptions = {},
): NotebookFingerprint {
	const n = resolveNgramSize(opts.ngramSize);
	const cells: CellFingerprint[] = [];
	const notebookNgrams = new Set<string>();
	const importSet = new Set<string>();
	const variableSet = new Set<string>();
	const commentSet = new Set<string>();

	for (let i = 0; i < input.cells.length; i++) {
		const cell = input.cells[i]!;
		const type: "code" | "markdown" = cell.type === "markdown" ? "markdown" : "code";
		const source = cell.source ?? "";

		const comments = type === "code" ? extractComments(source) : [];
		const imports = type === "code" ? extractImports(source) : [];
		const variables = type === "code" ? extractVariables(source) : [];
		const normalizedSource = type === "code" ? normalizeCode(source) : "";
		const ngramList =
			type === "code" ? [...new Set(ngramsOf(tokenize(normalizedSource), n))] : [];
		const ngramSet = new Set(ngramList);

		for (const gram of ngramSet) notebookNgrams.add(gram);
		for (const comment of comments) commentSet.add(comment);
		for (const imp of imports) importSet.add(imp);
		for (const variable of variables) variableSet.add(variable);

		cells.push({
			index: i,
			type,
			normalizedSource,
			ngrams: ngramList,
			ngramSet,
			comments,
			imports,
			variables,
		});
	}

	return {
		studentId: input.studentId,
		cells,
		cellCount: cells.length,
		notebookNgrams,
		importSet,
		variableSet,
		commentSet,
	};
}

// ---------------------------------------------------------------------------
// Pairwise comparison (pure)
// ---------------------------------------------------------------------------

/** Jaccard index of two sets; both empty => 0 (no evidence of similarity). */
export function jaccard(x: Set<string>, y: Set<string>): number {
	if (x.size === 0 && y.size === 0) return 0;
	let shared = 0;
	for (const value of x) {
		if (y.has(value)) shared++;
	}
	return round4(shared / (x.size + y.size - shared));
}

function intersection(x: Set<string>, y: Set<string>, cap: number): string[] {
	const out: string[] = [];
	for (const value of x) {
		if (y.has(value)) out.push(value);
		if (out.length >= cap) break;
	}
	return out;
}

/** Compare two submissions; returns the full pair (never filters). */
export function compareNotebooks(
	a: NotebookInput,
	b: NotebookInput,
	opts: StructuralOptions = {},
): PlagiarismPair {
	// Canonical ordering: matchedCells cellIndexA always refers to studentA.
	const [first, second] = a.studentId <= b.studentId ? [a, b] : [b, a];
	const fa = fingerprintNotebook(first, opts);
	const fb = fingerprintNotebook(second, opts);
	const maxMatched = opts.maxMatchedCells ?? DEFAULT_MAX_MATCHED_CELLS;

	const notebookOverlap = jaccard(fa.notebookNgrams, fb.notebookNgrams);

	// Inverted index over the second notebook: n-gram -> cell indices.
	const index = new Map<string, number[]>();
	for (const cell of fb.cells) {
		if (cell.type !== "code" || cell.ngramSet.size === 0) continue;
		for (const gram of cell.ngramSet) {
			const list = index.get(gram);
			if (list) list.push(cell.index);
			else index.set(gram, [cell.index]);
		}
	}

	// For each cell of the first notebook, count shared n-grams with every
	// candidate cell of the second (only candidates sharing >= 1 n-gram are
	// visited — near-linear in the shared content).
	const matchedCells: MatchedCell[] = [];
	const matchedA = new Set<number>();
	for (const cellA of fa.cells) {
		if (cellA.type !== "code" || cellA.ngramSet.size === 0) continue;

		const counts = new Map<number, number>();
		for (const gram of cellA.ngramSet) {
			for (const idxB of index.get(gram) ?? []) {
				counts.set(idxB, (counts.get(idxB) ?? 0) + 1);
			}
		}

		let best: MatchedCell | null = null;
		for (const [idxB, shared] of counts) {
			const cellB = fb.cells[idxB]!;
			const union = cellA.ngramSet.size + cellB.ngramSet.size - shared;
			const similarity = union > 0 ? shared / union : 0;
			if (similarity >= CELL_MATCH_THRESHOLD) {
				const candidate: MatchedCell = {
					cellIndexA: cellA.index,
					cellIndexB: idxB,
					similarity: round4(similarity),
				};
				if (!best || candidate.similarity > best.similarity) best = candidate;
			}
		}
		if (best) {
			matchedCells.push(best);
			matchedA.add(cellA.index);
		}
	}
	matchedCells.sort(
		(x, y) =>
			y.similarity - x.similarity ||
			x.cellIndexA - y.cellIndexA ||
			x.cellIndexB - y.cellIndexB,
	);
	const cappedMatched = matchedCells.slice(0, maxMatched);

	const smaller = Math.min(fa.cellCount, fb.cellCount);
	const cellOverlap = smaller > 0 ? round4(matchedA.size / smaller) : 0;

	const flags: string[] = [];
	if (jaccard(fa.importSet, fb.importSet) >= IMPORT_FLAG_THRESHOLD) {
		flags.push("shared_imports");
	}
	if (
		fa.commentSet.size > 0 &&
		fb.commentSet.size > 0 &&
		jaccard(fa.commentSet, fb.commentSet) >= COMMENT_FLAG_THRESHOLD
	) {
		flags.push("shared_comments");
	}
	if (jaccard(fa.variableSet, fb.variableSet) >= VARIABLE_FLAG_THRESHOLD) {
		flags.push("shared_variables");
	}
	if (
		fa.cellCount === fb.cellCount &&
		smaller > 0 &&
		matchedA.size / smaller >= STRUCTURE_MATCH_COVERAGE
	) {
		flags.push("same_cell_structure");
	}

	return {
		studentA: fa.studentId,
		studentB: fb.studentId,
		cellOverlap,
		notebookOverlap,
		matchedCells: cappedMatched,
		flags,
		details: {
			cellCountDiff: Math.abs(fa.cellCount - fb.cellCount),
			sharedVariableNames: intersection(fa.variableSet, fb.variableSet, MAX_SHARED_ITEMS),
			sharedComments: intersection(fa.commentSet, fb.commentSet, MAX_SHARED_ITEMS),
			sharedImports: intersection(fa.importSet, fb.importSet, MAX_SHARED_ITEMS),
		},
	};
}

/**
 * Compare every unique pair of submissions.
 *
 * Returns the complete pairwise matrix sorted by cellOverlap descending
 * (ties: notebookOverlap, then student ids). Use `isFlaggedPair()` /
 * `flagPairs()` to obtain the flagged subset the API returns.
 */
export function compareAll(
	notebooks: NotebookInput[],
	opts: StructuralOptions = {},
): PlagiarismPair[] {
	const pairs: PlagiarismPair[] = [];
	for (let i = 0; i < notebooks.length; i++) {
		for (let j = i + 1; j < notebooks.length; j++) {
			const a = notebooks[i]!;
			const b = notebooks[j]!;
			if (a.studentId === b.studentId) continue;
			pairs.push(compareNotebooks(a, b, opts));
		}
	}
	pairs.sort(
		(x, y) =>
			y.cellOverlap - x.cellOverlap ||
			y.notebookOverlap - x.notebookOverlap ||
			x.studentA.localeCompare(y.studentA) ||
			x.studentB.localeCompare(y.studentB),
	);
	return pairs;
}

/** True when a pair is above the flag thresholds (see constants). */
export function isFlaggedPair(pair: PlagiarismPair): boolean {
	return pair.cellOverlap >= FLAG_THRESHOLD || pair.notebookOverlap >= NOTEBOOK_FLAG_THRESHOLD;
}

/** The flagged subset of a pairwise matrix, preserving order. */
export function flagPairs(pairs: PlagiarismPair[]): PlagiarismPair[] {
	return pairs.filter(isFlaggedPair);
}

/**
 * Severity classification for a pair:
 *   high   — cellOverlap >= HIGH_THRESHOLD (0.6)
 *   medium — flagged but below high
 *   low    — below the flag threshold but >= LOW_THRESHOLD (0.15)
 *   none   — effectively noise
 */
export function classifyPair(pair: PlagiarismPair): PairSeverity {
	if (pair.cellOverlap >= HIGH_THRESHOLD) return "high";
	if (isFlaggedPair(pair)) return "medium";
	if (pair.cellOverlap >= LOW_THRESHOLD) return "low";
	return "none";
}

/**
 * Combined score: structural cellOverlap weighted with the semantic score
 * when present (COMBINED_SEMANTIC_WEIGHT = 0.3), plain cellOverlap otherwise.
 */
export function combinedScore(pair: PlagiarismPair): number {
	if (pair.semanticScore === undefined) return pair.cellOverlap;
	return round4(
		(1 - COMBINED_SEMANTIC_WEIGHT) * pair.cellOverlap +
			COMBINED_SEMANTIC_WEIGHT * pair.semanticScore,
	);
}

// ---------------------------------------------------------------------------
// Loader (the only I/O in this module)
// ---------------------------------------------------------------------------

function parseNotebookCells(parsed: unknown): NotebookCellInput[] {
	if (
		!parsed ||
		typeof parsed !== "object" ||
		!Array.isArray((parsed as { cells?: unknown }).cells)
	) {
		throw new Error("not a Jupyter notebook (missing cells array)");
	}
	const cells = (parsed as { cells: Array<{ cell_type?: unknown; source?: unknown }> }).cells;
	return cells.map((cell) => {
		const source = Array.isArray(cell.source)
			? cell.source.join("")
			: typeof cell.source === "string"
				? cell.source
				: "";
		return { type: cell.cell_type === "markdown" ? "markdown" : "code", source };
	});
}

/**
 * Load every submission notebook of an assignment from disk
 * (`<DATA_DIR>/submissions/<assignment>/<studentId>.ipynb`, via the
 * metadata registry). Unreadable / corrupt notebooks are skipped with a
 * warning — a broken file must not fail the whole comparison.
 */
export async function loadAssignmentNotebooks(assignmentId: string): Promise<NotebookInput[]> {
	const records = (await listSubmissions(assignmentId)).filter((r) => r.status !== "archived");
	const notebooks: NotebookInput[] = [];
	for (const record of records) {
		try {
			const raw = await readFile(path.join(getDataDir(), record.notebookPath), "utf-8");
			notebooks.push({
				studentId: record.studentId,
				cells: parseNotebookCells(JSON.parse(raw) as unknown),
			});
		} catch (err) {
			console.warn(
				`[plagiarism] skipping unreadable notebook for "${record.studentId}": ${(err as Error).message}`,
			);
		}
	}
	return notebooks;
}
