/**
 * @file Pre-evaluation service (Phase 4c) — one KI Connect call producing the
 * teacher-facing pre-evaluation envelope for a submission: per-cell markers
 * against the reference key, a grade suggestion, a feedback draft, and a
 * notebook summary.
 *
 * Contract (the {@link PreEvaluation} wire shape, Zod-validated):
 *   - `markers` — per-cell verdicts (`cell_index`, `marker`, `reason`) or
 *     `null`. Markers are NEVER fabricated: when no readable reference key
 *     notebook exists for the assignment the field is forced to `null`
 *     (even if the model hallucinated a list), so the UI keeps its
 *     "pending" state instead of showing invented comparisons.
 *   - `gradeSuggestion` — dimension id -> score plus a justification.
 *   - `feedbackDraft` — markdown feedback for the student.
 *   - `notebookSummary` — one-two sentence summary.
 *
 * Prompt budget mirrors the copilot context tools: per-cell source previews
 * are capped at SOURCE_PREVIEW_LINES lines, outputs at OUTPUT_PREVIEW_CHARS
 * chars, and the whole notebook at MAX_PREVIEW_CELLS cells. The reference
 * key is only ever summarized (bounded previews), never shipped in full.
 *
 * On KI Connect failure or invalid output this module throws a helpful
 * Error — it never returns a fabricated envelope (the agent loop surfaces
 * failures as tool-result ok:false).
 *
 * This module runs only on the SvelteKit server (`$lib/server/`).
 */

import { readFile, readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";

import * as yaml from "js-yaml";
import { z } from "zod";

import { getAssignmentById } from "$lib/server/assignments";
import { loadCriteriaForAssignment } from "$lib/server/criteria";
import { getKiConnectClient } from "$lib/server/ki-connect";
import { assertSafeSegment, getDataDir } from "$lib/server/metadata";
import { readResults, type StoredExecutionResult } from "$lib/server/results-store";
import type { ExecutedCell } from "$lib/server/executor-client";
import type { MergedRubric } from "$lib/types/criteria";

// ---------------------------------------------------------------------------
// Wire contract
// ---------------------------------------------------------------------------

/** Per-cell comparison verdict against the reference key. */
export type PreEvaluationMarkerValue = "same" | "different" | "questionable";

/** One cell verdict: how the student's cell compares to the key, and why. */
export interface PreEvaluationMarker {
	/** 0-based index within the notebook (matches the executed cells). */
	cell_index: number;
	marker: PreEvaluationMarkerValue;
	/** Plain-language justification for the verdict. */
	reason: string;
}

/**
 * The pre-evaluation envelope (wire contract, camelCase). `markers` is null
 * when no reference key is available — the UI keeps the pending state and
 * never shows invented comparisons.
 */
export interface PreEvaluation {
	markers: PreEvaluationMarker[] | null;
	gradeSuggestion: {
		/** Dimension id -> suggested score (within 0..max_points). */
		dimensions: Record<string, number>;
		justification: string;
	};
	/** Rubric sub-points the LLM selected per category (categoryKey + optionKey). */
	rubricSelections?: { categoryKey: string; optionKey: string }[];
	feedbackDraft: string;
	notebookSummary: string;
}

export interface PreEvaluateInput {
	submissionId: string;
	assignmentId: string;
}

// ---------------------------------------------------------------------------
// Zod validation (markers nullable — never fabricated)
// ---------------------------------------------------------------------------

const PRE_EVALUATION_MARKER_SCHEMA = z.object({
	cell_index: z.number().int().nonnegative(),
	marker: z.enum(["same", "different", "questionable"]),
	reason: z.string(),
});

const PRE_EVALUATION_SCHEMA = z.object({
	markers: z.array(PRE_EVALUATION_MARKER_SCHEMA).nullable(),
	gradeSuggestion: z.object({
		dimensions: z.record(z.string(), z.number()),
		justification: z.string(),
	}),
	rubricSelections: z
		.array(
			z.object({
				categoryKey: z.string(),
				optionKey: z.string(),
			}),
		)
		.optional(),
	feedbackDraft: z.string(),
	notebookSummary: z.string(),
});

type ValidatedPreEvaluation = z.infer<typeof PRE_EVALUATION_SCHEMA>;

// ---------------------------------------------------------------------------
// Prompt bounds (mirror tools/context-tools.ts preview limits)
// ---------------------------------------------------------------------------

const SOURCE_PREVIEW_LINES = 40;
const OUTPUT_PREVIEW_CHARS = 500;
/** Cap on cells shown in the submission preview (token budget). */
const MAX_PREVIEW_CELLS = 60;
/** Cap on cells shown in the reference key summary. */
const KEY_PREVIEW_CELLS = 25;
const SOURCE_TRUNCATION_MARKER = `\n… [source truncated after ${SOURCE_PREVIEW_LINES} lines]`;
const OUTPUT_TRUNCATION_MARKER = "… [output truncated]";

const PRE_EVALUATION_SYSTEM_PROMPT = `You are an expert teaching assistant for a Scientific Programming course. You produce a pre-evaluation of ONE student's Jupyter notebook submission for the teacher: per-cell comparison markers against the reference key, a suggested grade, rubric criteria selections, a feedback draft, and a notebook summary.

Return ONLY a JSON object with EXACTLY this shape:
{
  "markers": [
    { "cell_index": 0, "marker": "same" | "different" | "questionable", "reason": "..." }
  ] | null,
  "gradeSuggestion": {
    "dimensions": { "<dimension id>": <score 0..max_points> },
    "justification": "..."
  },
  "rubricSelections": [
    { "categoryKey": "<rubric category key>", "optionKey": "<exact sub-point text>" }
  ],
  "feedbackDraft": "...",
  "notebookSummary": "..."
}

Marker semantics, per executed cell compared to the reference key summary:
- "same": the student used essentially the same method/approach as the reference.
- "different": a different but valid way of solving the task — neutral and expected.
- "questionable": the approach is incorrect, suboptimal, or likely to lose points; the reason must say why.
Only judge cells you can actually compare against the key summary. When no reference key summary is provided, "markers" MUST be null.

gradeSuggestion.dimensions: one score per dimension id listed under "Grading dimensions", within 0..max_points. Never invent dimension ids.

IMPORTANT — use the FULL range. Most student submissions are NOT perfect. Calibrate strictly:
- 0-20% of max_points: requirement is entirely unmet, missing, or non-functional.
- 30-50%: substantial gaps — the student attempted but major parts are wrong, broken, or absent.
- 60-75%: mostly complete with notable issues — partial errors, mediocre structure, weak analysis, missing validation. This is the TYPICAL expected range for a correctly-working but unpolished submission.
- 80-90%: solid — correct results, good structure, reasonable analysis, minor issues only.
- max_points: EXCEPTIONAL only. Flawless implementation, elegant code, insightful analysis, proactive validation, clear communication. RARELY awarded — fewer than 10% of submissions should reach this tier.

Do NOT give max_points as default. A submission that produces correct output but has mediocre code structure, lacks validation, or has weak analysis should score 60-75%. Reserve high scores for work that genuinely stands out. Scoring variance across submissions is EXPECTED and healthy.

justification: 2-4 sentences with SPECIFIC strengths and weaknesses that justify the scores. Cite concrete examples from the student's notebook.

rubricSelections: for each rubric category, pick ONLY the 1-3 MOST RELEVANT sub-points (the lines starting with "•") that best describe the student's work. Use the EXACT categoryKey from the category header and the EXACT sub-point text as optionKey — copy-paste verbatim. Do NOT select more than 3 per category, and do NOT select contradictory sub-points (e.g. both positive and negative about the same aspect). Select negative sub-points ONLY when the student made clear mistakes. Be selective — prefer fewer, more accurate selections over exhaustive lists. Do not invent categoryKeys or sub-point texts.

feedbackDraft: concise, encouraging markdown feedback for the student (a few sentences; bullet points allowed).

notebookSummary: 1-2 sentences describing what the notebook does.`;

// ---------------------------------------------------------------------------
// Context helpers
// ---------------------------------------------------------------------------

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
	return err instanceof Error && "code" in err;
}

/** True for key.ipynb or the <name>_key.ipynb convention used in sample data. */
function isKeyNotebookName(name: string): boolean {
	const lower = name.toLowerCase();
	return lower === "key.ipynb" || lower.endsWith("_key.ipynb");
}

/** First SOURCE_PREVIEW_LINES lines of a cell source, with a truncation marker. */
function previewSource(source: string): string {
	const lines = source.split("\n");
	if (lines.length <= SOURCE_PREVIEW_LINES) {
		return source;
	}
	return `${lines.slice(0, SOURCE_PREVIEW_LINES).join("\n")}${SOURCE_TRUNCATION_MARKER}`;
}

/** First OUTPUT_PREVIEW_CHARS chars of output/error text, with a marker. */
function previewOutput(output: string): string {
	if (output.length <= OUTPUT_PREVIEW_CHARS) {
		return output;
	}
	return `${output.slice(0, OUTPUT_PREVIEW_CHARS)}${OUTPUT_TRUNCATION_MARKER}`;
}

/**
 * Bounded per-cell previews of the executed cells: what the student wrote
 * (original_source when present, like the teacher view), the output or
 * error, and a truncation note when cells were omitted.
 */
function formatCellsForPrompt(cells: ExecutedCell[]): string {
	const shown = cells.slice(0, MAX_PREVIEW_CELLS);
	const lines: string[] = [];
	for (const cell of shown) {
		const source = cell.original_source?.trim() ? cell.original_source : cell.source;
		lines.push(`[Cell ${cell.index}] ${cell.type}`);
		lines.push(previewSource(source));
		if (cell.error) {
			lines.push(`error: ${previewOutput(cell.error)}`);
		} else {
			lines.push(`output: ${previewOutput(cell.output ?? "") || "(no output)"}`);
		}
		lines.push("---");
	}
	if (cells.length > shown.length) {
		lines.push(`… ${cells.length - shown.length} more cell(s) omitted`);
	}
	return lines.join("\n");
}

/**
 * Compact rubric summary for the prompt: category key + title + the
 * main-point headings per sentiment (sub-points are too verbose for a
 * bounded prompt and add little signal).
 */
function formatRubricForPrompt(rubric: MergedRubric): string {
	const lines: string[] = [];
	for (const entry of rubric.categories) {
		lines.push(`- ${entry.key}: ${entry.category.title}`);
		for (const sentiment of ["positive", "neutral", "negative"] as const) {
			const items = entry.category[sentiment];
			for (const main of items) {
				// Include the main-point heading + each sub-point so the
				// LLM can pick exact sub-point texts as optionKeys. The
				// rubric checkbox model keys on sub-point text, not
				// main-point text — pre-evaluation must emit the sub-point
				// text verbatim for the apply path to match.
				const subs = main.sub_points
					.map((sp) => sp.text.trim())
					.filter((t) => t.length > 0);
				if (subs.length === 0) continue;
				lines.push(`  ${sentiment} — ${main.main_point.trim()}`);
				for (const sub of subs) {
					lines.push(`    • ${sub}`);
				}
			}
		}
	}
	return lines.join("\n") || "(no rubric categories configured)";
}

interface DimensionBrief {
	key: string;
	title: string;
	max_points: number;
	weight: number;
}

/**
 * Read grading_config.yaml dimensions for the prompt. Returns null when the
 * file is absent (the prompt then falls back to the assignment's declared
 * dimension ids); throws on a corrupt config — a server misconfig should
 * surface instead of silently producing an ungrounded grade suggestion.
 */
async function loadGradingDimensions(): Promise<DimensionBrief[] | null> {
	const filePath = path.join(getDataDir(), "grading_config.yaml");
	let raw: string;
	try {
		raw = await readFile(filePath, "utf-8");
	} catch (err) {
		if (isNodeError(err) && err.code === "ENOENT") {
			return null;
		}
		throw err;
	}
	let parsed: unknown;
	try {
		parsed = yaml.load(raw);
	} catch (err) {
		throw new Error(`grading_config.yaml is not valid YAML: ${(err as Error).message}`, {
			cause: err,
		});
	}
	const record = parsed as { dimensions?: unknown };
	if (!record || typeof record !== "object" || !Array.isArray(record.dimensions)) {
		throw new Error("grading_config.yaml is missing the 'dimensions' array");
	}
	return (record.dimensions as Record<string, unknown>[]).map((d) => ({
		key: typeof d.key === "string" ? d.key : String(d.key ?? ""),
		title: typeof d.title === "string" ? d.title : "",
		max_points: typeof d.max_points === "number" ? d.max_points : 0,
		weight: typeof d.weight === "number" ? d.weight : 0,
	}));
}

/** File names under materials/<assignmentId>/input_data/ (available_paths style). */
async function listInputDataFiles(assignmentId: string): Promise<string[]> {
	const dir = path.join(getDataDir(), "materials", assignmentId, "input_data");
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		return entries
			.filter((entry) => entry.isFile())
			.map((entry) => entry.name)
			.sort();
	} catch (err) {
		if (isNodeError(err) && err.code === "ENOENT") {
			return [];
		}
		throw err;
	}
}

interface KeyCellSummary {
	index: number;
	type: "code" | "markdown";
	sourcePreview: string;
}

/** Bounded summary of the reference key notebook (never the raw file). */
interface KeySummary {
	fileName: string;
	cellCount: number;
	cells: KeyCellSummary[];
	/** True when cells were omitted from the summary. */
	truncated: boolean;
}

/** Normalize a Jupyter cell source (string or array of lines) to one string. */
function cellSourceOf(source: unknown): string {
	if (Array.isArray(source)) return source.join("");
	if (typeof source === "string") return source;
	return "";
}

/**
 * Locate + summarize the assignment's reference key notebook
 * (<DATA_DIR>/materials/<assignmentId>/key.ipynb or <name>_key.ipynb).
 * Returns null when the key is missing OR unreadable — in both cases the
 * caller must keep markers null rather than inventing comparisons.
 */
async function loadKeySummary(assignmentId: string): Promise<KeySummary | null> {
	assertSafeSegment(assignmentId, "assignmentId");
	const materialsRoot = path.join(getDataDir(), "materials", assignmentId);
	let entries: Dirent[];
	try {
		entries = await readdir(materialsRoot, { withFileTypes: true });
	} catch {
		return null; // no materials directory
	}
	const keyEntry = entries.find((entry) => !entry.isDirectory() && isKeyNotebookName(entry.name));
	if (!keyEntry) {
		return null;
	}
	try {
		const raw = await readFile(path.join(materialsRoot, keyEntry.name), "utf-8");
		const notebook = JSON.parse(raw) as { cells?: unknown };
		if (!notebook || !Array.isArray(notebook.cells)) {
			return null;
		}
		const rawCells = notebook.cells as Array<{ cell_type?: unknown; source?: unknown }>;
		const cells = rawCells.map((cell, index): KeyCellSummary => {
			const type = cell.cell_type === "markdown" ? "markdown" : "code";
			return {
				index,
				type,
				sourcePreview: previewSource(cellSourceOf(cell.source)),
			};
		});
		const truncated = cells.length > KEY_PREVIEW_CELLS;
		return {
			fileName: keyEntry.name,
			cellCount: cells.length,
			cells: cells.slice(0, KEY_PREVIEW_CELLS),
			truncated,
		};
	} catch {
		return null; // unreadable / invalid key notebook — treat as unavailable
	}
}

function formatKeySummary(key: KeySummary): string {
	const lines: string[] = [];
	for (const cell of key.cells) {
		lines.push(`[Cell ${cell.index}] ${cell.type}`);
		lines.push(cell.sourcePreview);
		lines.push("---");
	}
	if (key.truncated) {
		lines.push(`… ${key.cellCount - key.cells.length} more key cell(s) omitted`);
	}
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Pre-evaluate one submission: build the bounded context (assignment rubric,
 * grading dimensions, input-data file names, reference key summary when
 * available, executed-cell previews) and make ONE KI Connect chatCompletion
 * call producing the validated {@link PreEvaluation} envelope.
 *
 * Throws a helpful Error when the submission has no stored executed cells,
 * when KI Connect fails, or when the model output fails Zod validation.
 * Markers are forced to null when no reference key is available.
 */
export async function preEvaluateSubmission(input: PreEvaluateInput): Promise<PreEvaluation> {
	const { submissionId, assignmentId } = input;
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

	// Assignment context: rubric + grading dimensions + input-data file names.
	const assignment = await getAssignmentById(assignmentId);
	const rubric = assignment ? await loadCriteriaForAssignment(assignment.criteria_files) : null;
	const gradingDimensions = await loadGradingDimensions();
	const inputDataFiles = await listInputDataFiles(assignmentId);

	// Reference key — optional. A missing/unreadable key forces markers null.
	const key = await loadKeySummary(assignmentId);

	const userParts: string[] = [
		`Assignment: ${assignmentId}${assignment?.title ? ` (${assignment.title})` : ""}`,
		"",
		"Rubric categories (criteria files):",
		formatRubricForPrompt(rubric ?? { categories: [] }),
		"",
		"Grading dimensions:",
		formatDimensionsForPrompt(gradingDimensions, assignment?.dimensions),
		"",
		`Available input data files (materials/${assignmentId}/input_data/): ${
			inputDataFiles.length > 0 ? inputDataFiles.join(", ") : "(none)"
		}`,
		"",
		key
			? `Reference key notebook (${key.fileName}, ${key.cellCount} cells):\n${formatKeySummary(key)}`
			: 'Reference key notebook: none available — set "markers" to null.',
		"",
		`Submission "${submissionId}" — ${cells.length} executed cell(s), ${stored.errorCells ?? 0} error(s):`,
		formatCellsForPrompt(cells),
	];
	const userPrompt = userParts.join("\n");

	let raw: unknown;
	try {
		raw = await getKiConnectClient().chatCompletion(
			PRE_EVALUATION_SYSTEM_PROMPT,
			userPrompt,
			0.2,
			{ type: "json_object" },
		);
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		throw new Error(
			`KI Connect call failed for pre-evaluation of submission "${submissionId}" (assignment "${assignmentId}"): ${detail}`,
			{ cause: err },
		);
	}

	const parsed = PRE_EVALUATION_SCHEMA.safeParse(raw);
	if (!parsed.success) {
		const issues = parsed.error.issues
			.slice(0, 3)
			.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
			.join("; ");
		throw new Error(
			`Pre-evaluation of submission "${submissionId}" (assignment "${assignmentId}") returned invalid output (${issues})`,
		);
	}

	const envelope: ValidatedPreEvaluation = parsed.data;
	// Hard rule: without a reference key there is nothing to compare against —
	// never trust (or fabricate) markers. The UI keeps the pending state.
	if (!key) {
		envelope.markers = null;
	}
	return envelope;
}

/** Dimensions section of the user prompt; falls back to registry ids. */
function formatDimensionsForPrompt(
	dimensions: DimensionBrief[] | null,
	assignmentDimensions: readonly string[] | undefined,
): string {
	if (dimensions && dimensions.length > 0) {
		return dimensions
			.map((d) => `- ${d.key} | ${d.title} | max ${d.max_points} | weight ${d.weight}`)
			.join("\n");
	}
	if (assignmentDimensions && assignmentDimensions.length > 0) {
		return `(grading_config.yaml unavailable; the assignment declares: ${[...assignmentDimensions].join(", ")})`;
	}
	return "(no grading dimensions configured)";
}
