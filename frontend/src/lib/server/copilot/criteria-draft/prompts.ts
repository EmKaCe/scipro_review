/**
 * @file Prompt contract for the turn-based criteria draft pipeline
 * (Task D4 — mirrors the pre-evaluation pipeline's prompts module).
 *
 * The draft pipeline runs 5 phases: deterministic grounding (Phase 0), a
 * category-skeleton planning turn (Phase 1), one LLM call PER category
 * (Phase 2), a deterministic merge (Phase 3), a one-call consistency pass
 * (Phase 4), and the validation gate with whole-draft retry (Phase 5).
 *
 * The prompt contract is split across two files: this module owns the
 * constants (shared criteria paths, dimension fallback, retry bound) and the
 * prompt builders; grounding.ts owns the deterministic Phase 0 context
 * assembly; pipeline.ts owns the orchestration.
 */

import * as yaml from "js-yaml";

import type { Grounding } from "./grounding";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Criteria files that apply to EVERY assignment. Their categories are never
 * part of a draft — the draft emits only assignment-specific categories, so
 * the grounding must summarize them for the model (know what already applies,
 * must not duplicate) and `ownCriteriaFile` must skip them.
 */
export const SHARED_CRITERIA_PATHS = [
	"data/criteria/general.yaml",
	"data/criteria/general_feedback.yaml",
	"data/criteria/following_instructions.yaml",
] as const;

/**
 * Whole-draft validation-retry bound (the pre-evaluation validation-retry
 * contract): on a gate failure the validation message is fed back to the
 * model and the WHOLE draft is re-run, at most this many attempts.
 */
export const MAX_DRAFT_ATTEMPTS = 3;

/**
 * Fallback dimension contract used when data/grading_config.yaml is absent
 * from DATA_DIR. The five grading dimensions are GLOBAL and FIXED (design
 * doc, 2026-08-24); the validator likewise soft-skips dimension-membership
 * checks when the config file is absent, so the fallback keeps the draft
 * grounded instead of failing the endpoint on a missing config.
 */
export const DEFAULT_DIMENSIONS = [
	{ key: "code_quality_design", title: "Code Quality & Design", max_points: 6 },
	{ key: "code_execution_results", title: "Code Execution & Results", max_points: 6 },
	{ key: "assignment_requirements", title: "Assignment Requirements", max_points: 6 },
	{ key: "scientific_programming", title: "Scientific Programming", max_points: 6 },
	{ key: "creativity", title: "Creativity", max_points: 4 },
] as const;

// ---------------------------------------------------------------------------
// Criteria-document schema (the validation-gate contract)
// ---------------------------------------------------------------------------

/**
 * The criteria-document schema the model is told to emit (validation-gate
 * contract). Rules 1-5 are the quantifiable-criteria authoring contract and
 * MUST stay verbatim (defined in .github/skills/criteria-authoring/SKILL.md);
 * rules 6-8 ADD the dimension-attribution requirements on top.
 */
export const CRITERIA_SCHEMA = `Emit a single top-level "categories" map, JSON object (the model emits JSON; the server serializes to YAML). Each key is a snake_case category id; each value has:
- title: human-readable category title (string)
- additional_notes: boolean — whether the grader gets a free-text notes box for this category
- positive / neutral / negative: arrays of main-point groups. Each group has:
  - main_point: group heading (string, may be "" for ungrouped)
  - sub_points: array of { text } items — a single checkable feedback option. Optional flags: "comment": true (selection opens a textarea), "point_deduction": true (selection reveals a numeric deduction input).
  - dimensions: array of 1+ keys from the FIXED grading dimensions — the GROUP DEFAULT for its sub-points (see rule 6).

CRITICAL — quantifiable-criteria rules (non-negotiable):
1. Every sub-point text must be checkable by OBSERVABLE notebook evidence (a specific import, cell marker, or output pattern) or a single bounded LLM pass — never a vague qualitative verdict ("demonstrates a thoughtful approach").
2. Sub-point wording you emit IS the worksheet option text: write it once and reuse it verbatim everywhere — worksheet validation is exact-text (no synonyms, no rephrasing you would then have to re-match).
3. Actively REPHRASE vague options into observable ones (e.g. "shows good pandas knowledge" -> "Functions: good use of Pandas functions."). Vague options are defects.
4. One coherent concern per category; do not pack unrelated concerns together or split one concern across categories.
5. NO "N/A" / opt-out options — every category must hold applicable, checkable sub-points.
6. DIMENSION ATTRIBUTION (mandatory): every main-point group MUST carry "dimensions": ["key", ...] — 1+ keys from the FIXED grading dimensions — as the group default for its sub-points. A sub-point MAY override the group default with its own "dimensions" array (the override REPLACES the group default, never merges) when that single sub-point's concern maps to different dimension(s) than the group.
7. Every sub-point must resolve to at least one dimension (its group's default or its own override) — an unattributed sub-point is a defect.
8. NEVER invent dimensions: only the FIXED dimension keys given in the prompt are valid. You attribute sub-points to existing dimensions; you do not define new dimensions.
These rules are defined in .github/skills/criteria-authoring/SKILL.md.`;

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

/**
 * The system prompt for every draft turn: the existing teaching-assistant
 * persona, extended with the dimension-attribution statement (the FIXED
 * dimensions are INPUT — the model attributes, never invents). On a
 * validation-gate retry the exact rejection message is appended so every
 * turn of the re-run sees the defect it must fix.
 */
export function buildDraftSystemPrompt(
	grounding: Grounding,
	validationFeedback: string | null,
): string {
	const parts = [
		"You are an expert scientific-programming teaching assistant. You draft a quantitative per-assignment rubric (criteria) for an automated pre-evaluation harness. Every sub-point MUST be checkable by observable notebook evidence (specific imports, cell markers, output patterns) or a single bounded LLM pass. Be precise and conservative: only emit criteria the assignment and its students' notebooks actually support.",
		"",
		"You are building a dimension-attributed rubric. The FIXED grading dimensions are:",
		grounding.dimensionContract,
		"Every sub-point must be attributable to ≥1 dimension; you attribute, never invent new dimensions.",
		"",
		"CRITERIA-DOCUMENT SCHEMA:",
		CRITERIA_SCHEMA,
	];
	if (validationFeedback) {
		parts.push(
			"",
			`PREVIOUS DRAFT REJECTED — the validation gate returned this error; fix it in the new draft: ${validationFeedback}`,
		);
	}
	return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Phase 1 — category-skeleton turn
// ---------------------------------------------------------------------------

/**
 * Phase 1 user prompt: propose the assignment-specific category skeleton
 * (keys + titles + one-line rationale) from the grounding. The dimension
 * contract is part of the grounding so the skeleton is dimension-aware, and
 * the shared-rubric constraint is restated explicitly.
 */
export function buildPhase1SkeletonPrompt(grounding: Grounding): string {
	return [
		"Propose the assignment-specific rubric CATEGORY SKELETON: the category keys + titles you will draft for this assignment, each with a one-line rationale. Do NOT draft sub-points yet.",
		"",
		'Return ONLY JSON: { "categories": [ { "key": "snake_case_id", "title": "Human-readable title", "rationale": "One line: what this category checks and which FIXED dimensions it maps to" } ] }',
		"",
		"Constraints:",
		"- Propose 5-9 categories.",
		"- Assignment-specific concerns ONLY. The shared rubric (general / general_feedback / following_instructions) already applies to every assignment — do NOT propose its categories or duplicate its concerns.",
		"- Make the skeleton dimension-aware: every category should map to a clear subset of the FIXED grading dimensions, and the skeleton as a whole should plausibly cover all of them.",
		"",
		"GROUNDING:",
		grounding.sharedContext,
	].join("\n");
}

// ---------------------------------------------------------------------------
// Phase 2 — per-category turn
// ---------------------------------------------------------------------------

/**
 * Phase 2 user prompt for ONE category (pre-evaluation pattern: one call per
 * category, sequential). Carries the shared context, the categories already
 * drafted (style/coverage consistency), and the dimension-attribution
 * granularity: main-point groups carry `dimensions` (group default), sub-points
 * MAY override.
 */
export function buildPhase2CategoryPrompt(
	grounding: Grounding,
	category: { key: string; title: string; rationale: string },
	alreadyDrafted: Record<string, unknown>,
): string {
	const lines = [
		`Draft ONE rubric category: "${category.key}" — ${category.title}.`,
		category.rationale ? `Rationale: ${category.rationale}` : "",
		"",
		'Return ONLY JSON — the category object, either bare ({ title, additional_notes, positive, neutral, negative }) or wrapped as { "<key>": { ... } }.',
		"",
		'Dimension attribution: every main-point group carries "dimensions": ["key", ...] (1+ keys from the FIXED grading dimensions) as the group default; a sub-point MAY override the group default with its own "dimensions" array. Every sub-point must resolve to at least one dimension.',
		"",
		"ALREADY-DRAFTED CATEGORIES (keep style and coverage consistent with these; do NOT re-emit them):",
		Object.keys(alreadyDrafted).length > 0
			? yamlDump(alreadyDrafted)
			: "(none yet — this is the first category)",
		"",
		"GROUNDING:",
		grounding.sharedContext,
	];
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Phase 4 — consistency pass
// ---------------------------------------------------------------------------

/**
 * Phase 4 user prompt: one call over the merged draft checking duplicate
 * concerns, per-dimension coverage (gaps are FLAGGED, never silent),
 * unattributed sub-points (soft), and vague wording. The model emits a
 * revision LIST; the server applies it deterministically (one round, no
 * loops).
 */
export function buildPhase4ConsistencyPrompt(
	grounding: Grounding,
	merged: Record<string, unknown>,
): string {
	return [
		"Review the MERGE DRAFT below for consistency and completeness:",
		"- duplicate concerns across categories",
		'- per-dimension coverage: is every FIXED grading dimension mapped by at least one sub-point? (e.g. nothing maps to "creativity" → surface it as a flagged note, do NOT stay silent)',
		"- unattributed sub-points (sub-points that resolve to no dimension) — flag them (soft)",
		"- vague wording (rephrase into observable evidence, per the quantifiable-criteria rules)",
		"",
		'Return ONLY JSON: { "notes": ["..."], "revisions": [ { "category": "...", "main_point": "...", "sub_point": "...", "action": "rephrase" | "remove", "text": "..." } ] }',
		"",
		'revisions: minimal, deterministic edits. "rephrase" replaces the sub_point\'s text with "text" (or the main_point\'s heading when sub_point is omitted). "remove" deletes the sub_point (or the whole main-point group when only main_point is given). Only reference texts that exist verbatim in the MERGE DRAFT.',
		"",
		"MERGE DRAFT:",
		yamlDump({ categories: merged }),
	].join("\n");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function yamlDump(value: unknown): string {
	return yaml.dump(value, { noRefs: true });
}
