/**
 * @file Session persistence — serialization, deserialization, and file export/import.
 *
 * Handles converting ReviewSession to/from JSON and YAML formats,
 * generating YAML and Markdown exports, and parsing imported files.
 *
 * @see .github/references/schemas/evaluation-output-schema.md
 * @see .github/references/schemas/evaluation-md-schema.md
 */

import * as yaml from "js-yaml";
import type { ReviewSession, CategorySelections } from "../types/session.js";
import type { MergedRubric, SubPoint } from "../types/criteria.js";
import type { GradeResult } from "../types/grading.js";
import type { Evaluation } from "../types/evaluation.js";
import type { ExportFormat } from "../types/persistence.js";
import { jsonSerialize } from "../utils/json-serialize.js";
import { generateEvaluationMarkdown, generateEvaluation } from "./text-generator.js";
import { validateEvaluation, validateReviewSession, formatValidationErrors } from "./validation.js";

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/**
 * Serialize a ReviewSession to a JSON string.
 *
 * Converts Set → Array for JSON compatibility.
 */
export function serializeSession(session: ReviewSession): string {
	const clone = deepCloneForJSON(session);
	return JSON.stringify(clone, null, 2);
}

/**
 * Deserialize a JSON string to a ReviewSession.
 *
 * Converts Array → Set for runtime use.
 * Returns null if parsing fails.
 */
export function deserializeSession(json: string): ReviewSession | null {
	try {
		const data = JSON.parse(json) as Record<string, unknown>;
		return reviveSession(data);
	} catch (error) {
		console.error("[session-persistence] Failed to deserialize session:", error);
		return null;
	}
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * Export a review session as a YAML file following the v2 evaluation-output schema.
 *
 * @param session - The review session
 * @param rubric - The merged rubric
 * @param result - The computed grade result
 * @param reviewer - The reviewer name
 * @returns YAML string
 */
export function exportAsYaml(
	session: ReviewSession,
	rubric: MergedRubric,
	result: GradeResult,
	reviewer: string,
): string {
	const evaluation = generateEvaluation(session, rubric, result, reviewer);
	return yaml.dump(evaluation, {
		indent: 2,
		lineWidth: 120,
		noRefs: true,
		sortKeys: false,
	});
}

/**
 * Export a review session as a Markdown file following the evaluation-md schema.
 *
 * @param session - The review session
 * @param rubric - The merged rubric
 * @param result - The computed grade result
 * @returns Markdown string
 */
export function exportAsMarkdown(
	session: ReviewSession,
	rubric: MergedRubric,
	result: GradeResult,
): string {
	return generateEvaluationMarkdown(session, rubric, result);
}

/**
 * Export a review session in the specified format.
 *
 * @param session - The review session
 * @param rubric - The merged rubric
 * @param result - The computed grade result
 * @param format - Export format (yaml, md, json)
 * @param reviewer - The reviewer name
 * @returns Formatted string
 */
export function exportSession(
	session: ReviewSession,
	rubric: MergedRubric,
	result: GradeResult,
	format: ExportFormat,
	reviewer: string,
): string {
	switch (format) {
		case "yaml":
			return exportAsYaml(session, rubric, result, reviewer);
		case "md":
			return exportAsMarkdown(session, rubric, result);
		case "json":
			return serializeSession(session);
		default:
			throw new Error(`Unknown export format: ${format}`);
	}
}

/**
 * Trigger a browser download of the exported file.
 *
 * @param content - The file content
 * @param filename - The download filename
 * @param mimeType - The MIME type
 */
export function downloadFile(
	content: string,
	filename: string,
	mimeType: string = "text/plain",
): void {
	const blob = new Blob([content], { type: mimeType });
	const url = URL.createObjectURL(blob);
	const link = document.createElement("a");
	link.href = url;
	link.download = filename;
	document.body.appendChild(link);
	link.click();
	document.body.removeChild(link);
	URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/**
 * Parse an imported YAML file (v2 evaluation-output schema) into a ReviewSession.
 *
 * Returns null if parsing fails or the format is unrecognized.
 * Validates against the v2 Evaluation schema using Zod.
 */
export function parseYamlImport(yamlText: string): ReviewSession | null {
	try {
		const data = yaml.load(yamlText) as Record<string, unknown>;
		if (!data) return null;

		// Check for v2 format (has 'feedback' key)
		if (data.feedback && typeof data.feedback === "object") {
			// Validate against Zod schema
			const validation = validateEvaluation(data);
			if (!validation.success) {
				console.error(
					"[session-persistence] YAML validation failed:",
					validation.errors ? formatValidationErrors(validation.errors) : "unknown error",
				);
				return null;
			}
			return evaluationToSession(data as unknown as Evaluation);
		}

		console.error("[session-persistence] Unrecognized YAML format: missing 'feedback' key");
		return null;
	} catch (error) {
		console.error("[session-persistence] Failed to parse YAML import:", error);
		return null;
	}
}

/**
 * Parse an imported JSON file into a ReviewSession.
 *
 * Handles both v2 format (with 'feedback' key) and legacy v1 format
 * (with 'category_selections' using scoped keys).
 *
 * Validates against Zod schemas before returning.
 * Returns null if parsing fails.
 */
export function parseJsonImport(jsonText: string): ReviewSession | null {
	try {
		const data = JSON.parse(jsonText) as Record<string, unknown>;
		if (!data) return null;

		// Check for v2 format (has 'feedback' key)
		if (data.feedback && typeof data.feedback === "object") {
			const validation = validateEvaluation(data);
			if (!validation.success) {
				console.error(
					"[session-persistence] JSON (v2) validation failed:",
					validation.errors ? formatValidationErrors(validation.errors) : "unknown error",
				);
				return null;
			}
			return evaluationToSession(data as unknown as Evaluation);
		}

		// Legacy v1 format (has 'category_selections' with scoped keys)
		if (data.category_selections && typeof data.category_selections === "object") {
			const validation = validateReviewSession(data);
			if (!validation.success) {
				console.error(
					"[session-persistence] JSON (v1) validation failed:",
					validation.errors ? formatValidationErrors(validation.errors) : "unknown error",
				);
				return null;
			}
			return reviveSession(data as unknown as Record<string, unknown>);
		}

		// Legacy flat format from vanilla JS app (keys like "name", "*-grading", "*-positive-*", "*-textarea")
		const flatSession = parseLegacyFlatJson(data);
		if (flatSession) {
			return flatSession;
		}

		console.error(
			"[session-persistence] Unrecognized JSON format: missing 'feedback', 'category_selections', or legacy flat keys",
		);
		return null;
	} catch (error) {
		console.error("[session-persistence] Failed to parse JSON import:", error);
		return null;
	}
}

/**
 * Parse an imported file (YAML or JSON) based on file extension.
 *
 * @param text - The file content
 * @param filename - The filename (used to determine format)
 * @returns Parsed ReviewSession, or null on failure
 */
export function parseImport(text: string, filename: string): ReviewSession | null {
	const ext = filename.split(".").pop()?.toLowerCase();

	switch (ext) {
		case "yaml":
		case "yml":
			return parseYamlImport(text);
		case "json":
			return parseJsonImport(text);
		default:
			console.error(
				`[session-persistence] Unsupported file extension: .${ext}. Supported: .yaml, .yml, .json`,
			);
			return null;
	}
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Deep-clone a value for JSON serialization.
 *
 * Converts Set → Array and Map → Array of entries.
 */
function deepCloneForJSON<T>(value: T): T {
	return jsonSerialize(value);
}

/**
 * Revive a ReviewSession from a plain object.
 *
 * Converts Array → Set for runtime use.
 */
function reviveSession(data: Record<string, unknown>): ReviewSession {
	const session = { ...data } as unknown as ReviewSession;

	// Convert category_selections arrays back to Sets
	if (session.category_selections && typeof session.category_selections === "object") {
		const selections = session.category_selections as unknown as Record<
			string,
			Record<string, unknown>
		>;
		for (const key of Object.keys(selections)) {
			const catSel = selections[key];
			if (catSel.checked_items && Array.isArray(catSel.checked_items)) {
				catSel.checked_items = new Set(catSel.checked_items as string[]);
			}
		}
	}

	return session;
}

/**
 * Convert a v2 Evaluation object to a ReviewSession.
 *
 * This is used when importing an evaluation file to resume editing.
 */
function evaluationToSession(evaluation: Evaluation): ReviewSession {
	const categorySelections: Record<string, unknown> = {};

	if (evaluation.feedback && typeof evaluation.feedback === "object") {
		for (const [key, feedback] of Object.entries(evaluation.feedback)) {
			const fb = feedback as unknown as Record<string, unknown>;
			categorySelections[key] = {
				checked_items: new Set(fb.checked ? (fb.checked as string[]) : []),
				comments: fb.comments ? { ...(fb.comments as Record<string, string>) } : {},
				deductions: fb.deductions ? { ...(fb.deductions as Record<string, number>) } : {},
				notes: (fb.notes as string) ?? "",
			};
		}
	}

	const scores = evaluation.scores as Record<string, number>;

	// Dynamically map all dimension keys from the scores object
	const grading: Record<string, number> = {};
	for (const [key, value] of Object.entries(scores)) {
		grading[key] = value ?? 0;
	}

	return {
		student_id: evaluation.student_id,
		assignment_id: evaluation.assignment,
		mode: "student",
		category_selections: categorySelections as Record<string, never>,
		grading: grading as never,
		generated_text: "",
		notes: (evaluation as { notes?: string }).notes ?? "",
		started_at: evaluation.date ?? new Date().toISOString(),
		updated_at: new Date().toISOString(),
	};
}

// ---------------------------------------------------------------------------
// Legacy flat JSON format (vanilla JS app)
// ---------------------------------------------------------------------------

/**
 * Mapping from legacy grading keys to current dimension keys.
 */
const LEGACY_GRADING_MAP: Record<string, string> = {
	codequality: "code_quality_design",
	codeexecution: "code_execution_results",
	assignmentrequirements: "assignment_requirements",
	scientific: "scientific_programming",
	creativity: "creativity",
};

/**
 * Mapping from legacy category prefixes to current category keys.
 */
const LEGACY_CATEGORY_MAP: Record<string, string> = {
	codeFormatting: "code_formatting",
	codingConcept: "coding_concept",
	jupyterNotebooks: "jupyter_notebooks",
	academicScholarship: "academic_scholarship",
	followingInstructions: "following_instructions",
	userDefinedFunctions: "user_defined_functions",
	callingFunction: "calling_function",
	plotting: "plotting",
	Pandas: "pandas",
	NumPy: "numpy",
	SciPy: "scipy",
	sklearn: "sklearn",
	GenAI: "genai",
};

/**
 * Detect whether a parsed JSON object uses the legacy flat format.
 *
 * The legacy format has flat keys like:
 *   - "name": "2026SS_00"
 *   - "codequality-grading": "4.0"
 *   - "codeFormatting-positive-...": "checked"
 *   - "codeFormatting-textarea": "..."
 */
function isLegacyFlatFormat(data: Record<string, unknown>): boolean {
	if (data.name && typeof data.name === "string" && data.name.startsWith("20")) {
		return true;
	}
	// Also check for legacy grading keys
	for (const key of Object.keys(data)) {
		if (key.endsWith("-grading") && typeof data[key] === "string") {
			return true;
		}
	}
	return false;
}

/**
 * Parse legacy grading scores from flat key-value pairs.
 *
 * Legacy format stores scores as `"<legacyKey>-grading": "<score>"`, e.g.
 * `"codequality-grading": "4.0"`. Maps legacy keys to current dimension keys.
 *
 * @param data - The raw legacy data object.
 * @returns Record of dimension keys to numeric scores.
 */
function parseLegacyScored(data: Record<string, unknown>): Record<string, number> {
	const grading: Record<string, number> = {};
	for (const [key, value] of Object.entries(data)) {
		if (key.endsWith("-grading")) {
			const legacyKey = key.replace("-grading", "");
			const dimensionKey = LEGACY_GRADING_MAP[legacyKey];
			if (dimensionKey && typeof value === "string") {
				grading[dimensionKey] = parseFloat(value) || 0;
			}
		}
	}
	return grading;
}

/**
 * Parse legacy category selections from flat key-value pairs.
 *
 * Legacy format stores selections as:
 *   - `"<category>-textarea": "<notes>"` — free-text notes
 *   - `"<category>-positive-<text>": "checked"` — positive checked item
 *   - `"<category>-negative-<text>": "checked"` — negative checked item
 *   - `"<category>-neutral-<text>": "checked"` — neutral checked item
 *
 * @param data - The raw legacy data object.
 * @returns Record of category keys to their selections.
 */
function parseLegacyFlat(data: Record<string, unknown>): Record<string, CategorySelections> {
	const categorySelections: Record<string, CategorySelections> = {};

	for (const [key, value] of Object.entries(data)) {
		if (key === "name" || key.endsWith("-grading")) continue;

		// Keys are: <category>-<sentiment>-<text> or <category>-textarea
		const firstDash = key.indexOf("-");
		if (firstDash === -1) continue;

		const legacyPrefix = key.slice(0, firstDash);
		const categoryKey = LEGACY_CATEGORY_MAP[legacyPrefix];
		if (!categoryKey) continue;

		// Initialize category if needed
		if (!categorySelections[categoryKey]) {
			categorySelections[categoryKey] = {
				checked_items: new Set<string>(),
				notes: "",
				comments: {},
				deductions: {},
			};
		}

		const rest = key.slice(firstDash + 1);

		if (rest === "textarea") {
			// Free-text notes for the category
			if (typeof value === "string" && value.trim()) {
				categorySelections[categoryKey].notes = value.trim();
			}
		} else if (
			rest.startsWith("positive-") ||
			rest.startsWith("negative-") ||
			rest.startsWith("neutral-")
		) {
			// Checkbox item — the text is everything after "positive-" / "negative-" / "neutral-"
			const sentimentEnd = rest.indexOf("-");
			const itemText = rest.slice(sentimentEnd + 1);
			if (value === "checked" && itemText) {
				categorySelections[categoryKey].checked_items.add(itemText);
			}
		}
	}

	return categorySelections;
}

/**
 * Parse a legacy flat JSON object into a ReviewSession.
 *
 * The legacy format stores everything as flat key-value pairs:
 *   - "name": student ID
 *   - "*-grading": dimension score (string)
 *   - "<category>-positive-<text>": "checked"
 *   - "<category>-negative-<text>": "checked"
 *   - "<category>-neutral-<text>": "checked"
 *   - "<category>-textarea": notes/comments
 *
 * Delegates scoring to {@link parseLegacyScored} and category parsing
 * to {@link parseLegacyFlat}.
 *
 * Returns null if the data does not match the legacy format.
 */
function parseLegacyFlatJson(data: Record<string, unknown>): ReviewSession | null {
	if (!isLegacyFlatFormat(data)) {
		return null;
	}

	const studentId = (data.name as string) ?? "";
	const grading = parseLegacyScored(data);
	const categorySelections = parseLegacyFlat(data);

	// Detect assignment from legacy category prefixes in the data
	const soilContaminationPrefixes = ["Pandas", "NumPy", "SciPy", "sklearn", "GenAI"];
	const hasSoilPrefixes = Object.keys(data).some((key) =>
		soilContaminationPrefixes.some((prefix) => key.startsWith(prefix + "-")),
	);
	const assignmentId = hasSoilPrefixes ? "soil_contamination" : "atom_interaction";

	return {
		student_id: studentId,
		assignment_id: assignmentId,
		mode: "student",
		category_selections: categorySelections as unknown as ReviewSession["category_selections"],
		grading: grading as unknown as ReviewSession["grading"],
		generated_text: "",
		started_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
	} as ReviewSession;
}

// ---------------------------------------------------------------------------
// Legacy checked-item normalization
// ---------------------------------------------------------------------------

/**
 * Collect all sub-points from all sentiment groups in a category.
 *
 * @param category - The rubric category containing positive/neutral/negative groups.
 * @returns Flat array of all sub-points across all sentiments.
 */
function collectAllSubPoints(category: MergedRubric["categories"][number]["category"]): SubPoint[] {
	const allSubPoints: SubPoint[] = [];
	for (const sentiment of ["positive", "neutral", "negative"] as const) {
		const groups = category[sentiment];
		for (const group of groups) {
			for (const sp of group.sub_points) {
				allSubPoints.push(sp);
			}
		}
	}
	return allSubPoints;
}

/**
 * Try to match a legacy checked item exactly against rubric sub-points.
 *
 * Some legacy items may already use the correct sub-point text.
 *
 * @param legacyItem - The legacy checked item text.
 * @param subPoints - All rubric sub-points to match against.
 * @returns The matched sub-point text, or null if no direct match.
 */
function directMatch(legacyItem: string, subPoints: SubPoint[]): string | null {
	for (const sp of subPoints) {
		if (sp.text === legacyItem) return sp.text;
	}
	return null;
}

/**
 * Try to match a legacy checked item by suffix segments.
 *
 * Legacy keys include "main_point-sub_point" joined by dashes.
 * This tries progressively shorter suffix slices against rubric sub-points.
 *
 * @param legacyItem - The legacy checked item text (e.g. "Formatting is done well-commenting").
 * @param subPoints - All rubric sub-points to match against.
 * @returns The matched sub-point text, or null if no suffix match.
 */
function suffixMatch(legacyItem: string, subPoints: SubPoint[]): string | null {
	const legacyParts = legacyItem.split("-");
	for (let i = legacyParts.length - 1; i > 0; i--) {
		const candidate = legacyParts.slice(i).join("-").trim();
		for (const sp of subPoints) {
			if (sp.text === candidate || sp.text.endsWith(candidate)) {
				return sp.text;
			}
		}
	}
	return null;
}

/**
 * Try to match a legacy checked item by substring containment.
 *
 * Checks whether any rubric sub-point is contained within the legacy item,
 * or vice versa. This is a fallback when exact and suffix matching fail.
 *
 * @param legacyItem - The legacy checked item text.
 * @param subPoints - All rubric sub-points to match against.
 * @returns The matched sub-point text, or null if no fuzzy match.
 */
function fuzzyMatch(legacyItem: string, subPoints: SubPoint[]): string | null {
	for (const sp of subPoints) {
		if (legacyItem.includes(sp.text) || sp.text.includes(legacyItem)) {
			return sp.text;
		}
	}
	return null;
}

/**
 * Normalize legacy checked items against the current rubric.
 *
 * The legacy flat format stores checked items with the full key text including
 * the main_point prefix (e.g. "Formatting is done well, which includes-commenting").
 * The current rubric stores only the sub_point text (e.g. "commenting - ...").
 *
 * This function re-maps checked items by matching the sub_point text against
 * the legacy key suffix using three strategies in order:
 * 1. {@link directMatch} — exact text match
 * 2. {@link suffixMatch} — dash-split suffix matching
 * 3. {@link fuzzyMatch} — substring containment fallback
 *
 * @param session - The parsed legacy session (mutated in place)
 * @param rubric - The loaded rubric for the assignment
 */
export function normalizeLegacyCheckedItems(session: ReviewSession, rubric: MergedRubric): void {
	for (const entry of rubric.categories) {
		const catKey = entry.key;
		const category = entry.category;
		const selections = session.category_selections[catKey];
		if (!selections) continue;

		const newChecked = new Set<string>();
		const allSubPoints = collectAllSubPoints(category);

		// Try each matching strategy in order
		for (const legacyItem of selections.checked_items) {
			const matched =
				directMatch(legacyItem, allSubPoints) ??
				suffixMatch(legacyItem, allSubPoints) ??
				fuzzyMatch(legacyItem, allSubPoints);

			if (matched) {
				newChecked.add(matched);
			} else {
				// If still no match, keep the legacy item as-is (it may be a
				// custom note or a rubric that has changed).
				newChecked.add(legacyItem);
			}
		}

		selections.checked_items = newChecked;
	}
}
