/**
 * @file Per-assignment scoring config (design signed off 2026-08-18).
 *
 * Loads `data/scoring/<assignment_id>.yaml` (referenced from assignments.yaml
 * via the optional `scoring_file` key) and compiles it into typed, validated
 * scoring semantics: calibration anchors, evidence regexes, disallowed
 * libraries, and Phase 2a prompt-anchor text.
 *
 * Contract (mirrors the design doc):
 *   - Every `pattern` string is compiled at load time
 *     (`new RegExp(pattern, flags ?? 'i')`). A SyntaxError throws with the
 *     pattern key — a bad config surfaces as a 500/test failure, never
 *     silent degradation.
 *   - `semantics` ∈ {test, test_all, capture_value, distinct_count};
 *     `capture_group` bounds checked for capture semantics.
 *   - `reference_anchors` is all-or-nothing (partial anchors are a hard
 *     error) and validated for sanity (r_squared ∈ [0,1], rmse > 0, all
 *     finite).
 *   - Absent scoring config (no `scoring_file`, or file missing) resolves to
 *     NULL — callers then use generic fallbacks (no anchors → calibration
 *     skipped; no disallowed libs → `[]`; generic dimension guidance). This
 *     is the strict-additive fallback that fixes atom_interaction's current
 *     soil-leakage WITHOUT shipping any config for it.
 *
 * This module runs only on the SvelteKit server (`$lib/server/`).
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import * as yaml from "js-yaml";

import { getDataDir } from "$lib/server/metadata";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Calibration anchors — FACTS used only to identify the reference-fit cluster. */
export interface ReferenceAnchors {
	A: number;
	B: number;
	x0: number;
	y0: number;
	L: number;
	rSquared: number;
	rmse: number;
}

export type EvidenceSemantics = "test" | "test_all" | "capture_value" | "distinct_count";
export type Haystack = "output" | "code" | "markdown" | "output+code" | "markdown+code";

/** One compiled evidence pattern (config YAML → runtime). */
export interface CompiledEvidencePattern {
	key: string;
	/** RegExp list — test/test_all use [0]; test_all requires ALL to match. */
	regexes: RegExp[];
	semantics: EvidenceSemantics;
	haystack: Haystack;
	/** For capture_value / distinct_count: which capture group to read. */
	captureGroup?: number;
}

/** The full per-assignment scoring config (typed, validated). */
export interface ScoringConfig {
	assignmentId: string;
	anchors: ReferenceAnchors | null;
	/** Compiled evidence patterns keyed by name. */
	evidencePatterns: Map<string, CompiledEvidencePattern>;
	disallowedLibraries: string[];
	/** Per-dimension Phase 2a guidance suffix text (key → suffix after `- <key>: `). */
	dimensionGuidance: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/** Absolute path of the scoring config for an assignment. */
export function getScoringConfigPath(assignmentId: string): string {
	return path.join(getDataDir(), "scoring", `${assignmentId}.yaml`);
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
	return err instanceof Error && "code" in err;
}

/**
 * Load and validate the scoring config for an assignment.
 *
 * Returns null when the file is absent (assignment has no committed scoring
 * semantics — callers use generic fallbacks). Throws on corrupt YAML,
 * invalid regexes, or schema violations — a misconfigured scoring file must
 * surface loudly, never silently disable scoring semantics.
 */
export async function loadScoringConfig(assignmentId: string): Promise<ScoringConfig | null> {
	let raw: string;
	try {
		raw = await readFile(getScoringConfigPath(assignmentId), "utf-8");
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
		throw new Error(
			`scoring config ${getScoringConfigPath(assignmentId)} is not valid YAML: ${(err as Error).message}`,
			{ cause: err },
		);
	}

	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`scoring config ${getScoringConfigPath(assignmentId)} is invalid: expected a 'scoring' map`);
	}
	const root = parsed as { scoring?: unknown };
	if (!root.scoring || typeof root.scoring !== "object" || Array.isArray(root.scoring)) {
		throw new Error(`scoring config ${getScoringConfigPath(assignmentId)} is invalid: missing 'scoring' map`);
	}
	const scoring = root.scoring as Record<string, unknown>;

	return compileScoringConfig(assignmentId, scoring);
}

// ---------------------------------------------------------------------------
// Compilation (pure — unit-testable)
// ---------------------------------------------------------------------------

const EVIDENCE_SEMANTICS: readonly EvidenceSemantics[] = [
	"test",
	"test_all",
	"capture_value",
	"distinct_count",
];

const HAYSTACKS: readonly Haystack[] = [
	"output",
	"code",
	"markdown",
	"output+code",
	"markdown+code",
];

/** Compile a validated raw scoring map into the runtime config. */
export function compileScoringConfig(
	assignmentId: string,
	scoring: Record<string, unknown>,
): ScoringConfig {
	// ── reference_anchors (all-or-nothing) ──
	const anchors = compileAnchors(scoring.reference_anchors, assignmentId);

	// ── evidence_patterns ──
	const evidencePatterns = new Map<string, CompiledEvidencePattern>();
	const rawPatterns = scoring.evidence_patterns;
	if (rawPatterns !== undefined) {
		if (!rawPatterns || typeof rawPatterns !== "object" || Array.isArray(rawPatterns)) {
			throw new Error(`scoring config ${assignmentId}: evidence_patterns must be a map`);
		}
		for (const [key, entry] of Object.entries(rawPatterns as Record<string, unknown>)) {
			evidencePatterns.set(key, compileEvidencePattern(assignmentId, key, entry));
		}
	}

	// ── disallowed_libraries ──
	let disallowedLibraries: string[] = [];
	const rawDisallowed = scoring.disallowed_libraries;
	if (rawDisallowed !== undefined) {
		if (!Array.isArray(rawDisallowed) || rawDisallowed.some((v) => typeof v !== "string")) {
			throw new Error(`scoring config ${assignmentId}: disallowed_libraries must be a string array`);
		}
		disallowedLibraries = rawDisallowed as string[];
	}

	// ── prompt_anchor_text.dimension_guidance ──
	let dimensionGuidance: Record<string, string> = {};
	const rawPrompt = scoring.prompt_anchor_text;
	if (rawPrompt !== undefined) {
		if (!rawPrompt || typeof rawPrompt !== "object" || Array.isArray(rawPrompt)) {
			throw new Error(`scoring config ${assignmentId}: prompt_anchor_text must be a map`);
		}
		const rawGuidance = (rawPrompt as Record<string, unknown>).dimension_guidance;
		if (rawGuidance !== undefined) {
			if (!rawGuidance || typeof rawGuidance !== "object" || Array.isArray(rawGuidance)) {
				throw new Error(`scoring config ${assignmentId}: prompt_anchor_text.dimension_guidance must be a map`);
			}
			for (const [dim, text] of Object.entries(rawGuidance as Record<string, unknown>)) {
				if (typeof text !== "string") {
					throw new Error(`scoring config ${assignmentId}: dimension_guidance.${dim} must be a string`);
				}
				dimensionGuidance[dim] = text;
			}
		}
	}

	return {
		assignmentId,
		anchors,
		evidencePatterns,
		disallowedLibraries,
		dimensionGuidance,
	};
}

function compileAnchors(
	raw: unknown,
	assignmentId: string,
): ReferenceAnchors | null {
	if (raw === undefined || raw === null) {
		return null; // no anchors → calibration is skipped by callers
	}
	if (typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error(`scoring config ${assignmentId}: reference_anchors must be a map`);
	}
	const r = raw as Record<string, unknown>;
	const num = (key: string): number => {
		const v = r[key];
		if (typeof v !== "number" || !Number.isFinite(v)) {
			throw new Error(`scoring config ${assignmentId}: reference_anchors.${key} must be a finite number`);
		}
		return v;
	};
	const anchors: ReferenceAnchors = {
		A: num("A"),
		B: num("B"),
		x0: num("x0"),
		y0: num("y0"),
		L: num("L"),
		rSquared: num("r_squared"),
		rmse: num("rmse"),
	};
	// Sanity: r_squared ∈ [0,1], rmse > 0.
	if (anchors.rSquared < 0 || anchors.rSquared > 1) {
		throw new Error(`scoring config ${assignmentId}: reference_anchors.r_squared must be in [0,1]`);
	}
	if (anchors.rmse <= 0) {
		throw new Error(`scoring config ${assignmentId}: reference_anchors.rmse must be > 0`);
	}
	return anchors;
}

function compileEvidencePattern(
	assignmentId: string,
	key: string,
	entry: unknown,
): CompiledEvidencePattern {
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
		throw new Error(`scoring config ${assignmentId}: evidence_patterns.${key} must be a map`);
	}
	const e = entry as Record<string, unknown>;

	const semantics = e.semantics as EvidenceSemantics;
	if (!EVIDENCE_SEMANTICS.includes(semantics)) {
		throw new Error(
			`scoring config ${assignmentId}: evidence_patterns.${key}.semantics must be one of ${EVIDENCE_SEMANTICS.join(", ")}`,
		);
	}
	const haystack = e.haystack as Haystack;
	if (!HAYSTACKS.includes(haystack)) {
		throw new Error(
			`scoring config ${assignmentId}: evidence_patterns.${key}.haystack must be one of ${HAYSTACKS.join(", ")}`,
		);
	}

	let patterns: unknown[];
	if (Array.isArray(e.pattern)) {
		patterns = e.pattern;
	} else {
		patterns = [e.pattern];
	}
	if (patterns.length === 0 || patterns.some((p) => typeof p !== "string" || (p as string).length === 0)) {
		throw new Error(`scoring config ${assignmentId}: evidence_patterns.${key}.pattern must be a non-empty string or string list`);
	}

	const regexes: RegExp[] = [];
	for (const p of patterns) {
		try {
			regexes.push(new RegExp(p as string, "i"));
		} catch (err) {
			throw new Error(
				`scoring config ${assignmentId}: evidence_patterns.${key} is not a valid regex: ${(err as Error).message}`,
				{ cause: err },
			);
		}
	}

	let captureGroup: number | undefined;
	if (semantics === "capture_value" || semantics === "distinct_count") {
		const g = e.capture_group;
		if (typeof g !== "number" || !Number.isInteger(g) || g < 1 || g > 9) {
			throw new Error(
				`scoring config ${assignmentId}: evidence_patterns.${key}.capture_group must be an integer 1..9 for ${semantics}`,
			);
		}
		captureGroup = g;
	}

	return { key, regexes, semantics, haystack, captureGroup };
}

// ---------------------------------------------------------------------------
// Runtime helpers
// ---------------------------------------------------------------------------

/** Run one compiled pattern against a haystack string → boolean result. */
export function testEvidencePattern(pattern: CompiledEvidencePattern, haystack: string): boolean {
	if (pattern.semantics === "test_all") {
		return pattern.regexes.every((re) => re.test(haystack));
	}
	return pattern.regexes[0]!.test(haystack);
}

/** Run one compiled pattern → value (capture_value) or count (distinct_count). */
export function measureEvidencePattern(pattern: CompiledEvidencePattern, haystack: string): string | number {
	if (pattern.semantics === "capture_value") {
		return pattern.regexes[0]!.exec(haystack)?.[pattern.captureGroup!] ?? "";
	}
	// distinct_count — matchAll + collect the capture group.
	// matchAll requires the `g` flag; the loader compiles with `i` only, so
	// clone with `g` for the scan (the source is unchanged).
	const re = new RegExp(pattern.regexes[0]!.source, pattern.regexes[0]!.flags.includes("g") ? pattern.regexes[0]!.flags : `${pattern.regexes[0]!.flags}g`);
	const seen = new Set<string>();
	for (const m of haystack.matchAll(re)) {
		seen.add(m[pattern.captureGroup!] ?? "");
	}
	return seen.size;
}

/**
 * Build the haystack strings for the evidence patterns from the cells.
 * Mirrors buildExtraAnalysisEvidence's exact joins (design §6).
 */
export function buildEvidenceHaystacks(
	cells: readonly { type: string; source: string; output?: string | null }[],
): { code: string; markdown: string; output: string } {
	const codeSource = cells
		.filter((c) => c.type === "code")
		.map((c) => c.source)
		.join("\n");
	const markdownSource = cells
		.filter((c) => c.type === "markdown")
		.map((c) => c.source)
		.join("\n");
	const outputText = cells
		.filter((c) => c.type === "code")
		.map((c) => c.output ?? "")
		.join("\n");
	return { code: codeSource, markdown: markdownSource, output: outputText };
}

/** Pick the haystack string for a pattern's declared haystack kind. */
export function haystackFor(
	kind: Haystack,
	h: { code: string; markdown: string; output: string },
): string {
	switch (kind) {
		case "output":
			return h.output;
		case "code":
			return h.code;
		case "markdown":
			return h.markdown;
		case "output+code":
			return h.output + h.code;
		case "markdown+code":
			return h.markdown + h.code;
	}
}

/** Substitute {A} {B} {L} (and other anchor placeholders) into guidance text. */
export function substituteAnchors(text: string, anchors: ReferenceAnchors | null): string {
	if (!anchors) return text;
	return text
		.replaceAll("{A}", String(anchors.A))
		.replaceAll("{B}", String(anchors.B))
		.replaceAll("{L}", String(anchors.L))
		.replaceAll("{x0}", String(anchors.x0))
		.replaceAll("{y0}", String(anchors.y0))
		.replaceAll("{r_squared}", String(anchors.rSquared))
		.replaceAll("{rmse}", String(anchors.rmse));
}
