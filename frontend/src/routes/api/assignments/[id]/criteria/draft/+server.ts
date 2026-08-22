/**
 * @file POST /api/assignments/[id]/criteria/draft — LLM-drafted per-assignment
 * criteria (rubric) config for the visual criteria editor.
 *
 * Drafts a criteria YAML document (the assignment's OWN categories map) from
 * the assignment's rubric + metadata via KI Connect (PHASE_2_MODEL, json_object
 * mode), following the quantifiable criteria-authoring rules (see
 * .github/skills/criteria-authoring/SKILL.md). This endpoint NEVER writes: the
 * teacher reviews the draft in the criteria editor and saves it through the
 * existing PUT /api/assignments/[id]/criteria (which runs the same validation
 * gate). The draft is validated here through the criteria validation/load path
 * so a model-produced document that cannot load is rejected with the validation
 * message — the model drafts, the gate guards.
 *
 * Grounding: the rubric is the assignment's OWN criteria file (the first entry
 * in `criteria_files` that is not the shared general.yaml) — without it the
 * draft would be ungrounded, so the endpoint 400s. The draft emits ONLY the
 * assignment-specific categories; general.yaml categories apply automatically
 * and are never part of this file.
 *
 * Responses:
 *   POST 200 { draft: { categories } }  — criterion-gate-validated
 *   POST 400 — no own rubric ("Assignment has no rubric — upload criteria
 *              first"), or the draft failed the criteria validation gate
 *   POST 404 — unknown assignment id
 *   POST 500 — LLM call failure / corrupt rubric file on disk
 *
 * Environment: DATA_DIR (default ./data). Server-only ($lib/server deps).
 */

import { error, json } from "@sveltejs/kit";
import type { RequestEvent } from "@sveltejs/kit";
import * as yaml from "js-yaml";

import { getAssignmentById } from "$lib/server/assignments";
import {
	CriteriaValidationError,
	loadCriteriaFile,
	validateCriteriaYaml,
} from "$lib/server/criteria";
import { getPhase2Model } from "$lib/server/copilot/pipeline/prompts";
import { getKiConnectClient } from "$lib/server/ki-connect";
import type { CriteriaFile } from "$lib/types/criteria";

/** The shared rubric file — never the assignment's own rubric. */
const GENERAL_CRITERIA_PATH = "data/criteria/general.yaml";

/** The criteria-document schema the model is told to emit (validation-gate contract). */
const CRITERIA_SCHEMA = `Emit a single top-level "categories" map, JSON object (the model emits JSON; the server serializes to YAML). Each key is a snake_case category id; each value has:
- title: human-readable category title (string)
- additional_notes: boolean — whether the grader gets a free-text notes box for this category
- positive / neutral / negative: arrays of main-point groups. Each group has:
  - main_point: group heading (string, may be "" for ungrouped)
  - sub_points: array of { text } items — a single checkable feedback option. Optional flags: "comment": true (selection opens a textarea), "point_deduction": true (selection reveals a numeric deduction input).

CRITICAL — quantifiable-criteria rules (non-negotiable):
1. Every sub-point text must be checkable by OBSERVABLE notebook evidence (a specific import, cell marker, or output pattern) or a single bounded LLM pass — never a vague qualitative verdict ("demonstrates a thoughtful approach").
2. Sub-point wording you emit IS the worksheet option text: write it once and reuse it verbatim everywhere — worksheet validation is exact-text (no synonyms, no rephrasing you would then have to re-match).
3. Actively REPHRASE vague options into observable ones (e.g. "shows good pandas knowledge" -> "Functions: good use of Pandas functions."). Vague options are defects.
4. One coherent concern per category; do not pack unrelated concerns together or split one concern across categories.
5. NO "N/A" / opt-out options — every category must hold applicable, checkable sub-points.
These rules are defined in .github/skills/criteria-authoring/SKILL.md.`;

/**
 * The assignment's own criteria file: the first entry in `criteria_files`
 * that is NOT the shared general.yaml (mirrors ownCriteriaFile in the
 * criteria API route — general.yaml applies to every assignment and is
 * never the draft's grounding rubric).
 */
function ownCriteriaFile(criteriaFiles: readonly string[]): string | null {
	return criteriaFiles.find((f) => f !== GENERAL_CRITERIA_PATH) ?? null;
}

/** Compact rubric summary: category key + title + positive/neutral/negative sub-point texts. */
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

/** POST /api/assignments/[id]/criteria/draft — LLM-drafted criteria categories. */
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

	const systemPrompt = [
		"You are an expert scientific-programming teaching assistant. You draft a quantitative per-assignment rubric (criteria) for an automated pre-evaluation harness. Every sub-point MUST be checkable by observable notebook evidence (specific imports, cell markers, output patterns) or a single bounded LLM pass. Be precise and conservative: only emit criteria the assignment and its students' notebooks actually support.",
		"",
		`ASSIGNMENT: ${assignment.id} — ${assignment.title}`,
		"",
		"EXISTING RUBRIC (grounding — draft FROM these categories and observable facts; do not discard the existing checkable sub-points, rephrase any vague ones):",
		summarizeRubric(criteria),
		"",
		"CRITERIA-DOCUMENT SCHEMA:",
		CRITERIA_SCHEMA,
	].join("\n");

	const userPrompt = [
		"Draft the assignment-specific criteria (rubric categories) for this assignment. Return ONLY JSON — a single 'categories' object. DO NOT include general rubric categories (they apply automatically and are not editable here).",
		"",
		"ASSIGNMENT METADATA:",
		`- id: ${assignment.id}`,
		`- title: ${assignment.title}`,
		`- dimensions: ${assignment.dimensions.join(", ")}`,
		"",
		"RUBRIC:",
		summarizeRubric(criteria),
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

	// The model emits a JSON object whose shape is the whole document
	// (mirroring scoring-draft). Accept either { categories: {...} } or a
	// bare categories map for robustness, then gate on the given map.
	const rawRecord = raw as { categories?: unknown } | Record<string, unknown>;
	const categoriesMap =
		rawRecord &&
		typeof rawRecord === "object" &&
		!Array.isArray(rawRecord) &&
		"categories" in rawRecord &&
		typeof (rawRecord as { categories?: unknown }).categories === "object" &&
		(rawRecord as { categories?: unknown }).categories !== null
			? (rawRecord as { categories: unknown }).categories
			: rawRecord;

	// Validation gate: the draft must be a VALID criteria document before the
	// teacher ever sees it. The model drafts, but the gate guards — a rejected
	// document surfaces as a 400 with the validation message (never a silent
	// save). This is the same schema the PUT/upload save path enforces.
	try {
		validateCriteriaYaml(
			yaml.dump({ categories: categoriesMap }),
			fileName.split("/").pop() ?? `${id}.yaml`,
		);
	} catch (err) {
		if (err instanceof CriteriaValidationError) {
			throw error(400, err.message);
		}
		throw error(500, (err as Error).message);
	}

	// General-collision gate: the draft's category keys must not collide with
	// the shared general.yaml categories (those apply automatically and are
	// not editable here). The save PUT re-guards on the way in, but a draft
	// that cannot EVER be saved is a defect the gate should catch up front —
	// surface it as a 400 now, not as a confusing failure at the teacher's
	// Save click. Skipped when general.yaml is missing on disk (mirrors the
	// PUT's tolerance).
	await assertNoGeneralCollision(categoriesMap as Record<string, unknown>);

	const draft = { categories: categoriesMap } as unknown as CriteriaFile;
	return json({ draft });
}

/** Category keys the draft must not use (already defined by shared general.yaml). */
async function assertNoGeneralCollision(categories: Record<string, unknown>): Promise<void> {
	let general;
	try {
		general = await loadCriteriaFile(GENERAL_CRITERIA_PATH);
	} catch (err) {
		// Corrupt general.yaml is a server misconfig, not the draft's fault —
		// surface it rather than silently accepting a colliding draft (mirrors
		// the save PUT's collision helper).
		throw error(500, `Failed to load data/criteria/general.yaml: ${(err as Error).message}`);
	}
	if (!general?.categories) return; // general.yaml absent on disk — skip
	const generalKeys = new Set(Object.keys(general.categories).map((k) => k.trim().toLowerCase()));
	for (const key of Object.keys(categories)) {
		if (generalKeys.has(key.trim().toLowerCase())) {
			throw error(400, `category key ${key} already exists in general.yaml`);
		}
	}
}
