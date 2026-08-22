/**
 * @file POST /api/assignments/[id]/scoring/draft — LLM-drafted scoring
 * config for the per-assignment scoring editor.
 *
 * Drafts a scoring config document from the assignment's rubric + metadata
 * via KI Connect (PHASE_2_MODEL, json_object mode). This endpoint NEVER
 * writes: the teacher reviews the draft in the P7 scoring editor and saves
 * it through the existing PUT /api/assignments/[id]/scoring (which runs the
 * same compile gate). The draft is validated here through the compile gate
 * so a model-produced document that cannot compile is rejected with the
 * compile message — the model drafts, the gate guards.
 *
 * Grounding: the rubric is the assignment's OWN criteria file (the first
 * entry in `criteria_files` that is not the shared general.yaml) — without
 * it the draft would be ungrounded, so the endpoint 400s. The assignment's
 * existing scoring config (when present) is passed as context so the model
 * EVOLVES the committed semantics instead of discarding them.
 *
 * Responses:
 *   POST 200 { draft: ScoringConfigDocument }  — compile-gate-validated
 *   POST 400 — no own rubric ("Assignment has no rubric — upload criteria
 *              first"), or the draft failed the compile gate
 *   POST 404 — unknown assignment id
 *   POST 500 — LLM call failure / corrupt rubric or scoring file on disk
 *
 * Environment: DATA_DIR (default ./data). Server-only ($lib/server deps).
 */

import { error, json } from "@sveltejs/kit";
import type { RequestEvent } from "@sveltejs/kit";

import { getAssignmentById } from "$lib/server/assignments";
import type { ScoringConfigDocument } from "$lib/components/assignments/scoring-editor-model";
import {
	compileScoringConfig,
	loadScoringConfig,
	type ScoringConfig,
} from "$lib/server/copilot/scoring-config";
import { getPhase2Model } from "$lib/server/copilot/pipeline/prompts";
import { loadCriteriaFile } from "$lib/server/criteria";
import { getKiConnectClient } from "$lib/server/ki-connect";
import type { CriteriaFile } from "$lib/types/criteria";

/** The shared rubric file — never the assignment's own rubric. */
const GENERAL_CRITERIA_PATH = "data/criteria/general.yaml";

/** The scoring-config schema the model is told to emit (compile-gate contract). */
const SCORING_CONFIG_SCHEMA = `Emit ONLY this shape (omit any key the assignment does not need):
- reference_anchors: all-or-nothing map of finite numbers: A, B, x0, y0, L, r_squared (in [0,1]), rmse (> 0). Omit the whole key when the assignment has no numeric fit to reproduce — calibration then stays OFF.
- evidence_patterns: map of { pattern: string | string[], semantics: "test" | "test_all" | "capture_value" | "distinct_count", haystack: "output" | "code" | "markdown" | "output+code" | "markdown+code", capture_group?: integer 1-9 }. Every pattern must be a valid regex (no capturing-group escapes); capture_group is required for capture_value / distinct_count.
- disallowed_libraries: array of strings — libraries the students may NOT import (e.g. libraries that would trivialize the assignment).
- allowed_libraries: array of strings — libraries the students MAY import (the assignment's intended toolset).
- prompt_anchor_text: { dimension_guidance: { "<dimension>": "anchor-scale text" } } — per-dimension anchor-scale guidance for the assignment's dimensions only.`;

/**
 * The assignment's own criteria file: the first entry in `criteria_files`
 * that is NOT the shared general.yaml (mirrors ownCriteriaFile in the
 * criteria API route — general.yaml applies to every assignment and is
 * never the draft's grounding rubric).
 */
function ownCriteriaFile(criteriaFiles: readonly string[]): string | null {
	return criteriaFiles.find((f) => f !== GENERAL_CRITERIA_PATH) ?? null;
}

/** Compact rubric summary: category key + positive/neutral/negative sub-point texts. */
function summarizeRubric(criteria: CriteriaFile): string {
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

/**
 * The assignment's existing compiled scoring config, serialized back to the
 * document shape as context — the model evolves it rather than discarding
 * it. Null → the draft starts from the rubric alone.
 */
function summarizeExistingScoring(config: ScoringConfig | null): string {
	if (!config) {
		return "No scoring config exists yet for this assignment — draft from the rubric alone.";
	}
	const evidence: Record<string, unknown> = {};
	for (const [key, pattern] of config.evidencePatterns) {
		const sources = pattern.regexes.map((re) => re.source);
		evidence[key] = {
			pattern: sources.length === 1 ? sources[0]! : sources,
			semantics: pattern.semantics,
			haystack: pattern.haystack,
			...(pattern.captureGroup !== undefined ? { capture_group: pattern.captureGroup } : {}),
		};
	}
	return JSON.stringify(
		{
			reference_anchors: config.anchors,
			evidence_patterns: evidence,
			disallowed_libraries: config.disallowedLibraries,
			allowed_libraries: config.allowedLibraries ?? [],
			dimension_guidance: config.dimensionGuidance,
		},
		null,
		2,
	);
}

/** POST /api/assignments/[id]/scoring/draft — LLM-drafted scoring config. */
export async function POST(event: RequestEvent): Promise<Response> {
	const id = event.params.id ?? "";

	const assignment = await getAssignmentById(id);
	if (!assignment) {
		throw error(404, `Assignment "${id}" not found`);
	}

	// The draft is grounded in the assignment's OWN rubric — without it the
	// model would hallucinate category texts. Missing own file (registry or
	// on disk) → 400.
	const fileName = ownCriteriaFile(assignment.criteria_files);
	const criteria = fileName ? await loadCriteriaFile(fileName) : null;
	if (!fileName || !criteria) {
		throw error(400, "Assignment has no rubric — upload criteria first");
	}

	// Existing scoring config as evolution context (null when none exists).
	const existing = await loadScoringConfig(id);

	const systemPrompt = [
		"You are an expert scientific-programming teaching assistant. You draft a per-assignment scoring config document for an automated pre-evaluation harness (calibration anchors, evidence patterns, library allow/deny lists, dimension anchor text). Be precise and conservative: only emit semantics the rubric and assignment actually support.",
		"",
		`ASSIGNMENT: ${assignment.id} — ${assignment.title}`,
		"",
		"RUBRIC CATEGORIES (from the assignment's own rubric file):",
		summarizeRubric(criteria),
		"",
		"SCORING-CONFIG SCHEMA:",
		SCORING_CONFIG_SCHEMA,
	].join("\n");

	const userPrompt = [
		"Draft the scoring config for this assignment. Return ONLY JSON.",
		"",
		"ASSIGNMENT METADATA:",
		`- id: ${assignment.id}`,
		`- title: ${assignment.title}`,
		`- dimensions: ${assignment.dimensions.join(", ")}`,
		"",
		"RUBRIC:",
		summarizeRubric(criteria),
		"",
		"EXISTING SCORING CONFIG (evolve it, do not discard):",
		summarizeExistingScoring(existing),
	].join("\n");

	const client = getKiConnectClient();
	const phase2Model = await getPhase2Model();
	const raw = await client.chatCompletion(
		systemPrompt,
		userPrompt,
		0.2,
		{ type: "json_object" },
		undefined,
		60_000,
		phase2Model,
	);
	const draft = raw as ScoringConfigDocument;

	// Compile gate: the draft must be a VALID config before the teacher ever
	// sees it. The model drafts, but the gate guards — a rejected document
	// surfaces as a 400 with the compile message (never a silent save).
	try {
		compileScoringConfig(assignment.id, raw);
	} catch (err) {
		throw error(400, (err as Error).message);
	}

	return json({ draft });
}
