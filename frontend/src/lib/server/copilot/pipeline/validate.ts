/**
 * @file Wire-contract validation for the pre-evaluation pipeline (extracted
 * from pre-evaluation.ts — Wave 0, pure structural move; no behavior change).
 * The Zod schema is the wire contract and must not change shape; the
 * post-Zod semantic validation grounds the envelope against the ACTUAL
 * configuration (rubric, grading dimensions).
 */

import { z } from "zod";

import { allSubPoints, type MergedRubric } from "$lib/types/criteria";
import type { DimensionBrief } from "./context";

// ---------------------------------------------------------------------------
// Zod validation (markers nullable — never fabricated)
// ---------------------------------------------------------------------------

export const PRE_EVALUATION_MARKER_SCHEMA = z.object({
	cell_index: z.number().int().nonnegative(),
	marker: z.enum(["same", "different", "questionable"]),
	reason: z.string(),
});

export const PRE_EVALUATION_SCHEMA = z.object({
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

export type ValidatedPreEvaluation = z.infer<typeof PRE_EVALUATION_SCHEMA>;

/**
 * Normalize a key/text for comparison: trim surrounding whitespace and fold
 * case. The LLM tends to add stray whitespace or alter capitalization when
 * copying category keys and sub-point texts — both sides are normalized so
 * these cosmetic drifts do not fail the validation.
 */
export function normalizeKey(value: string): string {
	return value.trim().toLowerCase();
}

/**
 * Fuzzy-match an LLM-generated optionKey against rubric sub-point texts.
 * Exact-match validation is too brittle — the LLM routinely drops trailing
 * periods, omits backticks, or truncates parentheticals. This function uses
 * two strategies:
 *
 * 1. Containment: if one side's bigrams are ≥90% contained in the other
 *    (handles truncation like "citing - missing references" vs the full
 *    rubric text with parenthetical).
 * 2. Jaccard: intersection/union ≥ 80% handles minor cosmetic drift
 *    (trailing periods, backtick omissions).
 *
 * Returns the best-matching sub-point text or null when no candidate meets
 * either threshold. The caller uses this as a fallback after exact match fails.
 */
export function fuzzyMatchOptionKey(
	candidate: string,
	subPoints: readonly { text: string }[],
): string | null {
	const norm = normalizeKey(candidate);
	if (norm.length === 0) return null;

	const candBigrams = new Set<string>();
	for (let i = 0; i < norm.length - 1; i++) {
		candBigrams.add(norm.slice(i, i + 2));
	}
	const candTotal = candBigrams.size;
	if (candTotal === 0) return null;

	let bestScore = 0;
	let bestText = "";

	for (const sp of subPoints) {
		const spNorm = normalizeKey(sp.text);
		if (spNorm.length === 0) continue;

		const spBigrams = new Set<string>();
		for (let i = 0; i < spNorm.length - 1; i++) {
			spBigrams.add(spNorm.slice(i, i + 2));
		}
		const spTotal = spBigrams.size;

		// Containment: how much of the smaller text is inside the larger?
		let overlap = 0;
		const smaller = candTotal <= spTotal ? candBigrams : spBigrams;
		const larger = candTotal <= spTotal ? spBigrams : candBigrams;
		for (const bg of smaller) {
			if (larger.has(bg)) overlap++;
		}
		const containment = overlap / Math.max(smaller.size, 1);

		// Jaccard: intersection / union
		let jacOverlap = 0;
		for (const bg of candBigrams) {
			if (spBigrams.has(bg)) jacOverlap++;
		}
		const jaccard = jacOverlap / Math.max(candTotal + spTotal - jacOverlap, 1);

		// Prefer containment (catches truncation), fall back to Jaccard
		const score = Math.max(containment, jaccard);
		if (score > bestScore) {
			bestScore = score;
			bestText = sp.text;
		}
	}

	// Containment ≥ 90% = "one is clearly a fragment of the other"
	// Jaccard ≥ 80% = "minor cosmetic drift"
	return bestScore >= 0.8 && bestText.length > 0 ? bestText : null;
}

/**
 * Post-Zod semantic validation. The schema guarantees SHAPE, but the LLM can
 * still hallucinate content: rubric category keys / sub-point texts that do
 * not exist in the assignment's rubric, dimension ids that are not configured,
 * or scores outside 0..max_points. Each of these is checked against the
 * ACTUAL configuration so a bogus envelope is rejected instead of persisted —
 * the apply path would otherwise create phantom category selections
 * (categorySelections keyed by an unknown category) and the dashboard would
 * show out-of-range scores.
 *
 * Rubric selections are ADVISORY (the teacher can adjust them in the UI), so
 * invalid entries — unknown categoryKeys (e.g. grading dimension keys) or
 * fabricated optionKeys — are STRIPPED with a console.warn, and overlong
 * lists are truncated, never fatal. Only a hard structural problem (selections
 * with no rubric configured) still fails the envelope.
 *
 * Returns the first issue found, or null when the envelope is grounded. The
 * caller wraps the message with submission context and throws.
 */
export function validateEnvelopeAgainstContext(
	envelope: ValidatedPreEvaluation,
	context: {
		rubric: MergedRubric | null;
		gradingDimensions: DimensionBrief[] | null;
		assignmentDimensions: readonly string[] | undefined;
	},
): string | null {
	const { rubric, gradingDimensions, assignmentDimensions } = context;

	// Rubric selections: every categoryKey must name a rubric category and
	// every optionKey must be a real sub-point text of that category (the
	// checkbox model keys on sub-point text, not main-point headings).
	// These entries are ADVISORY — the teacher can adjust them in the UI —
	// so bad entries are STRIPPED (or the list TRUNCATED), never fatal:
	// losing a few selections is far better than discarding the entire
	// envelope (markers, grade suggestion, feedback draft).
	const selections = envelope.rubricSelections;
	if (selections && selections.length > 0) {
		if (!rubric || rubric.categories.length === 0) {
			return "rubricSelections were returned but the assignment has no rubric configured";
		}
		// The worksheet pipeline methodically checks every rubric sub-point
		// across all categories — 200+ items is expected. Bad entries
		// (unknown categories, fabricated optionKeys) are stripped by the
		// filter below; the cap exists only as a safety valve against
		// unbounded growth (e.g. a model looping and appending infinitely).
		const MAX_SELECTIONS = 200;
		if (selections.length > MAX_SELECTIONS) {
			console.warn(
				`[pre-evaluation] rubricSelections has ${selections.length} items — exceeding safety cap of ${MAX_SELECTIONS}. Truncating.`,
			);
		}
		// Strip entries that reference unknown categories (the LLM regularly
		// uses grading DIMENSION keys like "scientific_programming" here) or
		// fabricated optionKeys that match nothing after fuzzy matching.
		const toClean =
			selections.length > MAX_SELECTIONS ? selections.slice(0, MAX_SELECTIONS) : selections;
		envelope.rubricSelections = toClean.filter((item) => {
			// Shape guard: the LLM occasionally emits malformed entries.
			if (
				!item ||
				typeof item.categoryKey !== "string" ||
				typeof item.optionKey !== "string"
			) {
				console.warn("[pre-evaluation] dropping malformed rubricSelections entry:", item);
				return false;
			}
			const category = rubric.categories.find(
				(entry) => normalizeKey(entry.key) === normalizeKey(item.categoryKey),
			);
			if (!category) {
				console.warn(
					`[pre-evaluation] dropping rubricSelections entry: unknown category "${item.categoryKey}" (optionKey "${item.optionKey}")`,
				);
				return false;
			}
			const matchesOption = allSubPoints(category.category).some(
				(sp) => normalizeKey(sp.text) === normalizeKey(item.optionKey),
			);
			if (matchesOption) return true;
			// Exact match failed — try fuzzy matching within the stated category.
			const fuzzyHit = fuzzyMatchOptionKey(item.optionKey, allSubPoints(category.category));
			if (fuzzyHit) {
				item.optionKey = fuzzyHit;
				return true;
			}
			// Cross-category fallback: the LLM often puts sub-points
			// under the wrong category (e.g. "imports - libraries
			// were imported, but not used" under code_formatting
			// instead of coding_concept). Search ALL categories.
			for (const otherEntry of rubric.categories) {
				const match = fuzzyMatchOptionKey(
					item.optionKey,
					allSubPoints(otherEntry.category),
				);
				if (match) {
					item.optionKey = match;
					item.categoryKey = otherEntry.key;
					return true;
				}
			}
			console.warn(
				`[pre-evaluation] dropping rubricSelections entry: optionKey "${item.optionKey}" does not exist in category "${item.categoryKey}" (or any other category)`,
			);
			return false;
		});
	}

	// Grade dimensions: every key must be a configured dimension and every
	// score within 0..max_points. When grading_config.yaml is absent the
	// assignment's declared dimension ids are the fallback (no max_points —
	// only the key is then checked).
	const known = new Map<string, number>();
	if (gradingDimensions && gradingDimensions.length > 0) {
		for (const d of gradingDimensions) known.set(normalizeKey(d.key), d.max_points);
	} else if (assignmentDimensions && assignmentDimensions.length > 0) {
		for (const id of assignmentDimensions) known.set(normalizeKey(id), NaN);
	}
	for (const [dimensionId, score] of Object.entries(envelope.gradeSuggestion.dimensions)) {
		const max = known.get(normalizeKey(dimensionId));
		if (max === undefined) {
			return `gradeSuggestion references unknown dimension "${dimensionId}"`;
		}
		// (Scores are schema-validated as finite z.number()s already; only
		// the range check needs the config's max_points.)
		if (Number.isFinite(max) && (score < 0 || score > max)) {
			return `gradeSuggestion score ${score} for dimension "${dimensionId}" is outside 0..${max}`;
		}
	}
	return null;
}
