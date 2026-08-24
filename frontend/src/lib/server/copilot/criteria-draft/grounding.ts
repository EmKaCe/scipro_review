/**
 * @file Phase 0 grounding for the turn-based criteria draft pipeline
 * (Task D4 — mirrors the pre-evaluation pipeline's context module).
 *
 * Deterministic, NO LLM: assembles the shared context every draft turn
 * receives — assignment metadata, the own-rubric summary (when one exists),
 * the assignment PDF text, the key notebook summary, the input-data file
 * list, the FIXED 5-dimension contract, and summaries of the shared criteria
 * files (general / general_feedback / following_instructions) so the draft
 * knows what already applies and must not duplicate.
 *
 * The chicken-and-egg is fixed here: an own rubric is OPTIONAL grounding. A
 * draft can start from PDF + key summary + input data + shared criteria
 * alone; when an own file exists its summary is included as additional
 * grounding (the draft builds FROM it, never discards it).
 */

import type { Assignment } from "$lib/types/assignments";
import { loadCriteriaFile } from "$lib/server/criteria";
import { loadGradingConfigFile } from "$lib/server/grading-config-writer";
import {
	formatKeySummary,
	listInputDataFiles,
	loadAssignmentPdfText,
	loadKeySummary,
	type KeySummary,
} from "$lib/server/copilot/pipeline/context";
import type { CriteriaFile } from "$lib/types/criteria";
import { DEFAULT_DIMENSIONS, SHARED_CRITERIA_PATHS } from "./prompts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One line of the FIXED dimension contract (key + title + max_points). */
export interface DimensionContractLine {
	key: string;
	title: string;
	max_points: number;
}

/**
 * The deterministic Phase 0 grounding shared by every LLM turn. All text
 * blocks are bounded (the PDF loader caps itself; the key summary is capped
 * at KEY_PREVIEW_CELLS; the shared-context block stays well under ~6k tokens).
 */
export interface Grounding {
	/** "key: title (max N points)" lines — the FIXED dimension contract. */
	dimensionContract: string;
	/** Assignment id + title + declared dimensions. */
	assignmentMeta: string;
	/** Summaries of the SHARED criteria files (never the own rubric). */
	sharedRubricSummary: string;
	/** Own-rubric summary when one exists ("" when none — chicken-and-egg fixed). */
	ownRubricSummary: string;
	/** Assignment PDF text (capped by the loader) or a "none" note. */
	pdfText: string;
	/** Key notebook summary or a "none" note. */
	keySummary: string;
	/** Input-data file list or a "none" note. */
	inputDataFiles: string;
	/** The full assembled context block (all of the above). */
	sharedContext: string;
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/**
 * Resolve the FIXED dimension contract: from data/grading_config.yaml when it
 * loads (authoritative), else the hardcoded 5-dimension fallback. The
 * validator applies the same soft-skip when the config file is absent, so
 * this fallback keeps the draft grounded instead of failing the endpoint.
 */
async function loadDimensionContract(): Promise<DimensionContractLine[]> {
	try {
		const config = await loadGradingConfigFile();
		if (config && config.dimensions.length > 0) {
			return config.dimensions.map((d) => ({
				key: d.key,
				title: d.title,
				max_points: d.max_points,
			}));
		}
	} catch {
		// Corrupt config — fall through to the fixed defaults rather than
		// failing the draft over a config the validator would also skip.
	}
	return DEFAULT_DIMENSIONS.map((d) => ({ ...d }));
}

/**
 * Compact rubric summary: category key + title + positive/neutral/negative
 * sub-point texts. Kept in the route-adjacent module so the pipeline and the
 * shared-criteria summarizer share one formatter.
 */
export function summarizeRubric(criteria: CriteriaFile): string {
	const lines: string[] = [];
	for (const [key, category] of Object.entries(criteria.categories)) {
		lines.push(`- ${key}: ${category.title}`);
		for (const sentiment of ["positive", "neutral", "negative"] as const) {
			const texts = category[sentiment].flatMap((mp) => mp.sub_points.map((sp) => sp.text));
			if (texts.length === 0) continue;
			lines.push(`  ${sentiment}:`);
			for (const text of texts) lines.push(`    - ${text}`);
		}
	}
	return lines.join("\n");
}

/** Summarize the shared criteria files (general/general_feedback/following_instructions). */
async function summarizeSharedCriteria(): Promise<{
	summary: string;
	/** Category keys present in ANY shared file (exclusion list for the draft). */
	sharedKeys: Set<string>;
}> {
	const summaries: string[] = [];
	const sharedKeys = new Set<string>();
	for (const filePath of SHARED_CRITERIA_PATHS) {
		const criteria = await loadCriteriaFile(filePath);
		if (!criteria) continue;
		sharedKeys.add(filePath);
		for (const key of Object.keys(criteria.categories)) {
			sharedKeys.add(key.trim().toLowerCase());
		}
		summaries.push(`## ${filePath}`, summarizeRubric(criteria), "");
	}
	return {
		summary: summaries.join("\n").trim() || "(no shared criteria files found on disk)",
		sharedKeys,
	};
}

/** Format the key notebook summary (null → "none" note). */
function formatKeyOrNone(key: KeySummary | null): string {
	if (!key)
		return "(no key notebook found — the draft is grounded on the PDF, input data, and shared rubric alone)";
	return `${key.fileName} (${key.cellCount} cells):\n${formatKeySummary(key)}`;
}

/**
 * Phase 0 — assemble the shared context. Deterministic, no LLM. Reads from
 * DATA_DIR via the pipeline loaders; all text blocks are bounded.
 */
export async function buildGrounding(assignment: Assignment): Promise<Grounding> {
	const dimensions = await loadDimensionContract();
	const dimensionContract = dimensions
		.map((d) => `- ${d.key}: ${d.title} (max ${d.max_points} points)`)
		.join("\n");

	const assignmentMeta = [
		`- id: ${assignment.id}`,
		`- title: ${assignment.title}`,
		`- declared dimensions: ${assignment.dimensions.length > 0 ? assignment.dimensions.join(", ") : "(none declared — use the FIXED dimensions from the dimension contract)"}`,
	].join("\n");

	// The own rubric is OPTIONAL grounding (chicken-and-egg fixed): the first
	// criteria file that is not one of the shared files.
	const ownCriteriaFile = assignment.criteria_files.find(
		(f) => !SHARED_CRITERIA_PATHS.includes(f as (typeof SHARED_CRITERIA_PATHS)[number]),
	);
	const ownCriteria = ownCriteriaFile ? await loadCriteriaFile(ownCriteriaFile) : null;
	const ownRubricSummary = ownCriteria
		? `## ${ownCriteriaFile} (the assignment's OWN rubric — draft FROM these categories and observable facts; do not discard the existing checkable sub-points, rephrase any vague ones):\n${summarizeRubric(ownCriteria)}`
		: "";

	const { summary: sharedRubricSummary } = await summarizeSharedCriteria();

	// Loaders run in parallel — none of them depend on each other.
	const [pdfText, key, inputDataFiles] = await Promise.all([
		loadAssignmentPdfText(assignment.id),
		loadKeySummary(assignment.id),
		listInputDataFiles(assignment.id),
	]);

	const sharedContext = [
		"ASSIGNMENT METADATA:",
		assignmentMeta,
		"",
		"FIXED GRADING DIMENSIONS (the ONLY valid dimension keys — the model attributes, never invents):",
		dimensionContract,
		"",
		"SHARED RUBRIC (applies to EVERY assignment — do NOT duplicate its categories or concerns):",
		sharedRubricSummary,
		"",
		...(ownRubricSummary ? [ownRubricSummary, ""] : []),
		"ASSIGNMENT INSTRUCTIONS (PDF text):",
		pdfText
			? pdfText
			: "(no assignment PDF found — ground on the key summary, input data, and shared rubric)",
		"",
		"REFERENCE KEY NOTEBOOK:",
		formatKeyOrNone(key),
		"",
		"INPUT-DATA FILES:",
		inputDataFiles.length > 0 ? inputDataFiles.join(", ") : "(no input_data directory found)",
	].join("\n");

	return {
		dimensionContract,
		assignmentMeta,
		sharedRubricSummary,
		ownRubricSummary,
		pdfText: pdfText ?? "",
		keySummary: key ? formatKeyOrNone(key) : "",
		inputDataFiles: inputDataFiles.join(", "),
		sharedContext,
	};
}

// ---------------------------------------------------------------------------
// Draft-shape helpers (no LLM)
// ---------------------------------------------------------------------------

/** The first criteria file in the registry that is not a shared file (null
 * when the assignment has no own rubric — the chicken-and-egg fix). */
export function ownCriteriaFile(criteriaFiles: readonly string[]): string | null {
	return (
		criteriaFiles.find(
			(f) => !SHARED_CRITERIA_PATHS.includes(f as (typeof SHARED_CRITERIA_PATHS)[number]),
		) ?? null
	);
}

/**
 * Normalize a Phase 2 turn result to a single-category map: the model may
 * emit the bare category object or wrap it as { "<key>": {...} }. When it is
 * a wrapped map with multiple keys, the extra keys are emitted as separate
 * categories (tolerance, mirroring the single-shot rawRecord tolerance).
 */
export function toCategoryMap(
	key: string,
	raw: unknown,
	existing: Record<string, unknown>,
): Record<string, unknown> {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error(`Draft turn for "${key}" returned a non-object result`);
	}
	const record = raw as Record<string, unknown>;
	const result: Record<string, unknown> = { ...existing };
	// Wrapped shape: { "<key>": { ... } } (or several keys — tolerate extras).
	if (typeof record[key] === "object" && record[key] !== null && !Array.isArray(record[key])) {
		result[key] = record[key];
		for (const [extra, value] of Object.entries(record)) {
			if (extra === key) continue;
			if (value && typeof value === "object" && !Array.isArray(value)) {
				result[extra] = value;
			}
		}
		return result;
	}
	// Bare category object — check it is not a categories-wrapped document.
	if (
		typeof record.categories === "object" &&
		record.categories !== null &&
		!Array.isArray(record.categories)
	) {
		const inner = record.categories as Record<string, unknown>;
		result[key] = inner[key] ?? {
			title: key,
			additional_notes: true,
			positive: [],
			neutral: [],
			negative: [],
		};
		return result;
	}
	result[key] = record;
	return result;
}
