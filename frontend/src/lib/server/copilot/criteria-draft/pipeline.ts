/**
 * @file Turn-based criteria draft pipeline (Task D4 — mirrors the
 * pre-evaluation pipeline's phased shape).
 *
 * Phases:
 *   0. Grounding (deterministic, no LLM) — shared context (grounding.ts)
 *   1. Category-planning turn (1 LLM call) — assignment-specific skeleton
 *   2. Per-category turns (1 LLM call EACH, sequential) — dimension-attributed
 *      category maps, each turn seeing the already-drafted categories
 *   3. Deterministic merge (no LLM) — object spread in skeleton order
 *   4. Consistency pass (1 LLM call) — coverage/unattributed/vague flags;
 *      deterministic one-round revision application (no loops)
 *   5. Validation gate + whole-draft retry — validateCriteriaYaml (async,
 *      dimension-aware) + general-collision gate; on failure the validation
 *      message is fed back to the model, at most MAX_DRAFT_ATTEMPTS attempts;
 *      final failure throws CriteriaValidationError (route → 400)
 *
 * NEVER writes: this module performs no file I/O beyond the read-only
 * grounding loaders.
 */

import * as yaml from "js-yaml";

import type { Assignment } from "$lib/types/assignments";
import {
	CriteriaValidationError,
	loadCriteriaFile,
	validateCriteriaYaml,
} from "$lib/server/criteria";
import { getPhase2Model } from "$lib/server/copilot/pipeline/prompts";
import { getKiConnectClient } from "$lib/server/ki-connect";
import { buildGrounding, ownCriteriaFile, toCategoryMap, type Grounding } from "./grounding";
import {
	buildDraftSystemPrompt,
	buildPhase1SkeletonPrompt,
	buildPhase2CategoryPrompt,
	buildPhase4ConsistencyPrompt,
	MAX_DRAFT_ATTEMPTS,
} from "./prompts";

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/** One entry of the Phase 1 category skeleton. */
interface SkeletonEntry {
	key: string;
	title: string;
	rationale: string;
}

/** One deterministic revision emitted by the Phase 4 consistency pass. */
interface Revision {
	category: string;
	main_point?: string;
	sub_point?: string;
	action: "rephrase" | "remove";
	text?: string;
}

/** The pipeline result: the merged categories map plus surfaced notes. */
export interface DraftResult {
	categories: Record<string, unknown>;
	/** Consistency-pass notes (coverage gaps, unattributed items, ...) — surfaced in the response, never silent. */
	notes: string[];
}

/** Structural client shape (only the calls this pipeline makes). */
interface DraftClient {
	chatCompletion(
		system: string,
		user: string,
		temperature?: number,
		responseFormat?: { type: string },
		schema?: unknown,
		timeoutMs?: number,
		model?: string,
	): Promise<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Phase 1 — category skeleton
// ---------------------------------------------------------------------------

/** Normalize one skeleton entry (string key or { key, title?, rationale? }). */
function normalizeSkeletonEntry(entry: unknown): SkeletonEntry | null {
	if (typeof entry === "string" && entry.trim()) {
		return { key: entry.trim(), title: entry.trim(), rationale: "" };
	}
	if (entry && typeof entry === "object") {
		const record = entry as Record<string, unknown>;
		const key = typeof record.key === "string" ? record.key.trim() : "";
		if (!key) return null;
		return {
			key,
			title:
				typeof record.title === "string" && record.title.trim() ? record.title.trim() : key,
			rationale: typeof record.rationale === "string" ? record.rationale.trim() : "",
		};
	}
	return null;
}

/** Parse the Phase 1 response into a skeleton (throws on unusable output). */
function parseSkeleton(raw: unknown): SkeletonEntry[] {
	const record = (raw ?? {}) as Record<string, unknown>;
	let list: unknown = null;
	if (Array.isArray(record.categories)) {
		list = record.categories;
	} else if (record.categories && typeof record.categories === "object") {
		// Tolerated shape: { categories: { "key": { title, rationale } } }.
		list = Object.entries(record.categories as Record<string, unknown>).map(([key, value]) =>
			value && typeof value === "object"
				? { key, ...(value as Record<string, unknown>) }
				: key,
		);
	} else if (Array.isArray(raw)) {
		list = raw;
	}
	if (!Array.isArray(list)) {
		throw new Error("Draft Phase 1 returned an invalid category skeleton");
	}
	const skeleton = list.map(normalizeSkeletonEntry).filter((e): e is SkeletonEntry => e !== null);
	if (skeleton.length === 0) {
		throw new Error("Draft Phase 1 returned an empty category skeleton");
	}
	return skeleton;
}

// ---------------------------------------------------------------------------
// Phase 2 — per-category turn
// ---------------------------------------------------------------------------

/**
 * Run the Phase 2 turns SEQUENTIALLY (the KI Connect concurrency ceiling is
 * 2; sequential is always safe). Each turn receives the shared context + the
 * categories already drafted, and returns the category map for its ONE
 * category; the accumulated map is merged in skeleton order (Phase 3 is the
 * object spread inside this loop).
 */
async function runCategoryTurns(
	client: DraftClient,
	grounding: Grounding,
	skeleton: SkeletonEntry[],
	systemPrompt: string,
	temperature: number,
	timeoutMs: number,
	model: string,
): Promise<Record<string, unknown>> {
	let merged: Record<string, unknown> = {};
	for (const entry of skeleton) {
		const userPrompt = buildPhase2CategoryPrompt(grounding, entry, merged);
		const raw = await client.chatCompletion(
			systemPrompt,
			userPrompt,
			temperature,
			{ type: "json_object" },
			undefined,
			timeoutMs,
			model,
		);
		merged = toCategoryMap(entry.key, raw, merged);
	}
	return merged;
}

// ---------------------------------------------------------------------------
// Phase 4 — consistency pass + deterministic revision application
// ---------------------------------------------------------------------------

/** Parse the Phase 4 response into notes + a well-formed revision list. */
function parseConsistencyResult(raw: unknown): { notes: string[]; revisions: Revision[] } {
	const record = (raw ?? {}) as Record<string, unknown>;
	const notes = Array.isArray(record.notes)
		? record.notes.filter((n): n is string => typeof n === "string")
		: [];
	const rawRevisions = Array.isArray(record.revisions) ? record.revisions : [];
	const revisions: Revision[] = [];
	for (const item of rawRevisions) {
		if (!item || typeof item !== "object") continue;
		const r = item as Record<string, unknown>;
		if (typeof r.category !== "string" || !r.category.trim()) continue;
		const action = r.action;
		if (action !== "rephrase" && action !== "remove") continue;
		const rev: Revision = { category: r.category, action };
		if (typeof r.main_point === "string" && r.main_point.trim())
			rev.main_point = r.main_point.trim();
		if (typeof r.sub_point === "string" && r.sub_point.trim())
			rev.sub_point = r.sub_point.trim();
		if (typeof r.text === "string" && r.text.trim()) rev.text = r.text.trim();
		if (action === "rephrase" && !rev.text) continue; // rephrase needs replacement text
		if (action === "remove" && !rev.main_point && !rev.sub_point) continue; // remove needs a target
		revisions.push(rev);
	}
	return { notes, revisions };
}

/** Locate a category in the merged map (exact key, then case-insensitive). */
function findCategory(
	merged: Record<string, unknown>,
	categoryKey: string,
): Record<string, unknown> | null {
	if (merged[categoryKey] && typeof merged[categoryKey] === "object") {
		return merged[categoryKey] as Record<string, unknown>;
	}
	const lower = categoryKey.trim().toLowerCase();
	for (const [key, value] of Object.entries(merged)) {
		if (key.trim().toLowerCase() === lower && value && typeof value === "object") {
			return value as Record<string, unknown>;
		}
	}
	return null;
}

const SENTIMENTS = ["positive", "neutral", "negative"] as const;

/** Find a main-point group whose sub_points contain the given exact text. */
function findGroupBySubPoint(
	category: Record<string, unknown>,
	text: string,
): { sentiment: string; group: Record<string, unknown> } | null {
	for (const sentiment of SENTIMENTS) {
		const groups = category[sentiment];
		if (!Array.isArray(groups)) continue;
		for (const group of groups as Record<string, unknown>[]) {
			if (!group || typeof group !== "object") continue;
			const subPoints = group.sub_points;
			if (
				Array.isArray(subPoints) &&
				subPoints.some(
					(sp) =>
						sp &&
						typeof sp === "object" &&
						(sp as Record<string, unknown>).text === text,
				)
			) {
				return { sentiment, group };
			}
		}
	}
	return null;
}

/** Find a main-point group whose heading equals the given text. */
function findGroupByHeading(
	category: Record<string, unknown>,
	heading: string,
): { sentiment: string; group: Record<string, unknown> } | null {
	for (const sentiment of SENTIMENTS) {
		const groups = category[sentiment];
		if (!Array.isArray(groups)) continue;
		for (const group of groups as Record<string, unknown>[]) {
			if (group && typeof group === "object" && group.main_point === heading) {
				return { sentiment, group };
			}
		}
	}
	return null;
}

/** Remove a group from its sentiment array (mutates the category). */
function removeGroup(category: Record<string, unknown>, sentiment: string, group: unknown): void {
	const groups = category[sentiment];
	if (!Array.isArray(groups)) return;
	const index = groups.indexOf(group);
	if (index >= 0) groups.splice(index, 1);
}

/**
 * Apply the well-formed revision list deterministically (ONE round, no
 * loops). Unapplicable revisions (unknown category / missing text) are
 * skipped silently. Returns the number of revisions applied.
 */
function applyRevisions(merged: Record<string, unknown>, revisions: Revision[]): number {
	let applied = 0;
	for (const rev of revisions) {
		const category = findCategory(merged, rev.category);
		if (!category) continue;
		if (rev.action === "remove") {
			if (rev.sub_point) {
				const found = findGroupBySubPoint(category, rev.sub_point);
				if (!found) continue;
				const subPoints = found.group.sub_points as unknown[];
				const index = subPoints.findIndex(
					(sp) =>
						sp &&
						typeof sp === "object" &&
						(sp as Record<string, unknown>).text === rev.sub_point,
				);
				if (index < 0) continue;
				subPoints.splice(index, 1);
				// A group left with no sub-points is dead weight — drop it.
				if (subPoints.length === 0) removeGroup(category, found.sentiment, found.group);
				applied++;
			} else if (rev.main_point) {
				const found = findGroupByHeading(category, rev.main_point);
				if (!found) continue;
				removeGroup(category, found.sentiment, found.group);
				applied++;
			}
		} else if (rev.action === "rephrase") {
			if (rev.sub_point && rev.text) {
				const found = findGroupBySubPoint(category, rev.sub_point);
				if (!found) continue;
				const subPoints = found.group.sub_points as Record<string, unknown>[];
				const target = subPoints.find((sp) => sp.text === rev.sub_point);
				if (!target) continue;
				target.text = rev.text;
				applied++;
			} else if (rev.main_point && rev.text) {
				const found = findGroupByHeading(category, rev.main_point);
				if (!found) continue;
				found.group.main_point = rev.text;
				applied++;
			}
		}
	}
	return applied;
}

// ---------------------------------------------------------------------------
// Phase 5 — validation gate
// ---------------------------------------------------------------------------

/** The general-collision gate (shared general.yaml keys must never appear in
 * a draft). Throws CriteriaValidationError on collision (retryable, → 400
 * when exhausted) and a plain Error on corrupt general.yaml (→ 500). */
async function assertNoGeneralCollision(categories: Record<string, unknown>): Promise<void> {
	let general;
	try {
		general = await loadCriteriaFile("data/criteria/general.yaml");
	} catch (err) {
		throw new Error(`Failed to load data/criteria/general.yaml: ${(err as Error).message}`, {
			cause: err,
		});
	}
	if (!general?.categories) return; // general.yaml absent on disk — skip
	const generalKeys = new Set(Object.keys(general.categories).map((k) => k.trim().toLowerCase()));
	for (const key of Object.keys(categories)) {
		if (generalKeys.has(key.trim().toLowerCase())) {
			throw new CriteriaValidationError(`category key ${key} already exists in general.yaml`);
		}
	}
}

/** Validate a merged draft through the criteria gate + collision gate. */
async function runValidationGate(merged: Record<string, unknown>, fileName: string): Promise<void> {
	await validateCriteriaYaml(yaml.dump({ categories: merged }), fileName);
	await assertNoGeneralCollision(merged);
}

// ---------------------------------------------------------------------------
// One full draft attempt (Phases 1-4)
// ---------------------------------------------------------------------------

async function draftOnce(
	client: DraftClient,
	grounding: Grounding,
	validationFeedback: string | null,
	temperature: number,
	timeoutMs: number,
	model: string,
): Promise<{ categories: Record<string, unknown>; notes: string[] }> {
	const systemPrompt = buildDraftSystemPrompt(grounding, validationFeedback);

	// Phase 1 — category skeleton (dimension-aware; shared categories excluded).
	const skeletonRaw = await client.chatCompletion(
		systemPrompt,
		buildPhase1SkeletonPrompt(grounding),
		temperature,
		{ type: "json_object" },
		undefined,
		timeoutMs,
		model,
	);
	const skeleton = parseSkeleton(skeletonRaw);

	// Phase 2 — one call per category, sequential; Phase 3 is the merge.
	const merged = await runCategoryTurns(
		client,
		grounding,
		skeleton,
		systemPrompt,
		temperature,
		timeoutMs,
		model,
	);

	// Phase 4 — consistency pass + deterministic one-round revision apply.
	const consistencyRaw = await client.chatCompletion(
		systemPrompt,
		buildPhase4ConsistencyPrompt(grounding, merged),
		temperature,
		{ type: "json_object" },
		undefined,
		timeoutMs,
		model,
	);
	const { notes, revisions } = parseConsistencyResult(consistencyRaw);
	applyRevisions(merged, revisions);

	return { categories: merged, notes };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Run the full turn-based criteria draft pipeline for an assignment.
 *
 * @param assignment - Registry entry (metadata + criteria_files)
 * @param client - KI Connect client (test seam)
 * @returns the merged categories map + surfaced consistency notes
 * @throws CriteriaValidationError — final gate failure after
 *   MAX_DRAFT_ATTEMPTS (route → 400 with the validation message)
 * @throws Error — LLM failure / corrupt general.yaml (route → 500)
 */
export async function draftCriteriaCategories(
	assignment: Assignment,
	client: DraftClient = getKiConnectClient(),
): Promise<DraftResult> {
	const grounding = await buildGrounding(assignment);
	const model = await getPhase2Model();
	const temperature = 0.2;
	const timeoutMs = 60_000;

	const fileName = (ownCriteriaFile(assignment.criteria_files) ?? `${assignment.id}.yaml`)
		.split("/")
		.pop()!;

	let validationFeedback: string | null = null;
	for (let attempt = 1; attempt <= MAX_DRAFT_ATTEMPTS; attempt++) {
		const result = await draftOnce(
			client,
			grounding,
			validationFeedback,
			temperature,
			timeoutMs,
			model,
		);
		try {
			await runValidationGate(result.categories, fileName);
		} catch (err) {
			if (err instanceof CriteriaValidationError) {
				// Feed the exact rejection back to the model; re-run the WHOLE
				// draft (the pre-eval validation-retry contract).
				validationFeedback = err.message;
				continue;
			}
			throw err;
		}
		return { categories: result.categories, notes: result.notes };
	}

	throw new CriteriaValidationError(
		validationFeedback ?? "Draft failed validation after multiple attempts",
	);
}
