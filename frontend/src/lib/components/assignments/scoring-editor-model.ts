/**
 * @file Shared editable scoring-config model for the scoring editor tabs.
 *
 * The visual editor, raw-YAML editor, and preview all work on the same
 * mutable draft shape (`EditableScoringConfig`). Pure helpers live here so
 * the tabs wrapper can own the single source of truth while the visual
 * editor stays a controlled component.
 *
 * The draft keeps numeric inputs as STRINGS (empty = absent) so the visual
 * editor can render text inputs without number-input coercion; conversion to
 * the server shape happens in `toServerScoring`.
 */

/**
 * The raw YAML shape under `scoring:` — the document the editor edits and
 * the shape `compileScoringConfig` consumes (see scoring-config.ts).
 */
export interface ScoringConfigDocument {
	/** Calibration anchors — A, B, x0, y0, L, r_squared, rmse. */
	reference_anchors?: Record<string, number>;
	evidence_patterns?: Record<
		string,
		{
			pattern: string | string[];
			semantics: "test" | "test_all" | "capture_value" | "distinct_count";
			haystack: "output" | "code" | "markdown" | "output+code" | "markdown+code";
			capture_group?: number;
		}
	>;
	disallowed_libraries?: string[];
	prompt_anchor_text?: {
		dimension_guidance?: Record<string, string>;
	};
}

/** The 5 known grading dimensions (mirrors DIMENSION_CATALOG in assignment-form.svelte). */
export const SCORING_DIMENSIONS = [
	"code_quality_design",
	"code_execution_results",
	"assignment_requirements",
	"scientific_programming",
	"creativity",
] as const;

export type ScoringDimension = (typeof SCORING_DIMENSIONS)[number];

export const EVIDENCE_SEMANTICS = [
	"test",
	"test_all",
	"capture_value",
	"distinct_count",
] as const;
export type EvidenceSemantics = (typeof EVIDENCE_SEMANTICS)[number];

export const HAYSTACKS = [
	"output",
	"code",
	"markdown",
	"output+code",
	"markdown+code",
] as const;
export type Haystack = (typeof HAYSTACKS)[number];

/** One editable evidence pattern card. */
export interface EditablePattern {
	key: string;
	semantics: EvidenceSemantics;
	haystack: Haystack;
	/**
	 * The regex source. For test/test_all a newline-separated list means
	 * multiple patterns (test_all requires ALL to match); capture semantics
	 * use a single line.
	 */
	pattern: string;
	/** Capture group as a string so empty = absent (capture semantics only). */
	captureGroup: string;
}

/** The full editable draft shared by the three tabs. */
export interface EditableScoringConfig {
	/** Anchor key → numeric input text (empty string = absent). */
	anchors: Record<string, string>;
	evidencePatterns: EditablePattern[];
	/** Comma-separated library names (empty string = none). */
	disallowedLibraries: string;
	/** Dimension key → guidance suffix text. */
	dimensionGuidance: Record<string, string>;
}

/** The anchor keys the editor knows about (order = display order). */
export const ANCHOR_KEYS = ["A", "B", "x0", "y0", "L", "r_squared", "rmse"] as const;

/** Next unique "new_pattern" key (new_pattern_2, ...) not present in `existing`. */
export function nextPatternKey(existing: string[]): string {
	const taken = new Set(existing);
	if (!taken.has("new_pattern")) return "new_pattern";
	let i = 2;
	while (taken.has(`new_pattern_${i}`)) i++;
	return `new_pattern_${i}`;
}

/** A fresh empty pattern card with a unique key. */
export function emptyPattern(existing: string[]): EditablePattern {
	return {
		key: nextPatternKey(existing),
		semantics: "test",
		haystack: "output",
		pattern: "",
		captureGroup: "",
	};
}

function toEditablePattern(
	key: string,
	entry: {
		pattern?: string | string[];
		semantics?: unknown;
		haystack?: unknown;
		capture_group?: unknown;
	},
): EditablePattern {
	const semantics = EVIDENCE_SEMANTICS.includes(entry.semantics as EvidenceSemantics)
		? (entry.semantics as EvidenceSemantics)
		: "test";
	const haystack = HAYSTACKS.includes(entry.haystack as Haystack)
		? (entry.haystack as Haystack)
		: "output";
	const pattern = Array.isArray(entry.pattern)
		? entry.pattern.join("\n")
		: (entry.pattern ?? "");
	const captureGroup =
		typeof entry.capture_group === "number" ? String(entry.capture_group) : "";
	return { key, semantics, haystack, pattern, captureGroup };
}

/**
 * Convert a server/parsed-YAML scoring document into the editable draft.
 * Defensive defaults make raw-YAML input safe (missing sections → empty).
 */
export function fromServerScoring(scoring: ScoringConfigDocument | null): EditableScoringConfig {
	const anchors: Record<string, string> = {};
	for (const key of ANCHOR_KEYS) {
		const value = scoring?.reference_anchors?.[key];
		anchors[key] = typeof value === "number" ? String(value) : "";
	}

	const evidencePatterns: EditablePattern[] = [];
	if (scoring?.evidence_patterns) {
		for (const [key, entry] of Object.entries(scoring.evidence_patterns)) {
			evidencePatterns.push(toEditablePattern(key, entry));
		}
	}

	return {
		anchors,
		evidencePatterns,
		disallowedLibraries: (scoring?.disallowed_libraries ?? []).join(", "),
		dimensionGuidance: { ...(scoring?.prompt_anchor_text?.dimension_guidance ?? {}) },
	};
}

/**
 * Rebuild the raw `scoring` map shape from the draft.
 *
 * - reference_anchors: only non-empty entries; the whole key is omitted when
 *   every anchor is empty (no anchors = calibration off).
 * - evidence_patterns: `pattern` is a single string, or a string[] when the
 *   draft holds a newline-separated list; `capture_group` is emitted only for
 *   capture semantics and only when non-empty.
 * - disallowed_libraries: comma-split, trimmed, empty entries dropped.
 * - prompt_anchor_text.dimension_guidance: only non-empty entries.
 */
export function toServerScoring(draft: EditableScoringConfig): Record<string, unknown> {
	const out: Record<string, unknown> = {};

	const anchors: Record<string, number> = {};
	for (const [key, value] of Object.entries(draft.anchors)) {
		const trimmed = value.trim();
		if (trimmed === "") continue;
		const num = Number(trimmed);
		if (Number.isFinite(num)) anchors[key] = num;
	}
	if (Object.keys(anchors).length > 0) {
		out.reference_anchors = anchors;
	}

	const evidencePatterns: Record<string, unknown> = {};
	for (const pattern of draft.evidencePatterns) {
		const lines = pattern.pattern
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0);
		const entry: Record<string, unknown> = {
			semantics: pattern.semantics,
			haystack: pattern.haystack,
		};
		if (lines.length > 1) {
			entry.pattern = lines;
		} else if (lines.length === 1) {
			entry.pattern = lines[0]!;
		} else {
			entry.pattern = "";
		}
		const captureGroup = pattern.captureGroup.trim();
		if (
			(pattern.semantics === "capture_value" || pattern.semantics === "distinct_count") &&
			captureGroup !== ""
		) {
			const g = Number(captureGroup);
			if (Number.isInteger(g)) entry.capture_group = g;
		}
		evidencePatterns[pattern.key] = entry;
	}
	if (Object.keys(evidencePatterns).length > 0) {
		out.evidence_patterns = evidencePatterns;
	}

	const libraries = draft.disallowedLibraries
		.split(",")
		.map((lib) => lib.trim())
		.filter((lib) => lib.length > 0);
	if (libraries.length > 0) {
		out.disallowed_libraries = libraries;
	}

	const guidance: Record<string, string> = {};
	for (const [dim, text] of Object.entries(draft.dimensionGuidance)) {
		if (text.trim().length > 0) guidance[dim] = text;
	}
	if (Object.keys(guidance).length > 0) {
		out.prompt_anchor_text = { dimension_guidance: guidance };
	}

	return out;
}

/**
 * Client-side UX validation of the shared draft.
 *
 * The SERVER compile gate (compileScoringConfig) is authoritative — this is
 * a UX-only pre-check so the teacher gets immediate feedback. It never
 * blocks a save the server would accept, and server 400s still surface
 * through the save error path.
 */
export function validateScoringDraft(draft: EditableScoringConfig): string | null {
	// Anchors are all-or-nothing on the server; a non-numeric value would be
	// silently dropped by toServerScoring (calibration silently off), so
	// surface it here instead of letting the teacher's input vanish.
	for (const [key, value] of Object.entries(draft.anchors)) {
		const trimmed = value.trim();
		if (trimmed === "") continue;
		if (!Number.isFinite(Number(trimmed))) {
			return `Anchor "${key}" must be a number (got "${trimmed}").`;
		}
	}
	for (const [index, pattern] of draft.evidencePatterns.entries()) {
		if (!pattern.key.trim()) {
			return `Evidence pattern ${index + 1} needs a key.`;
		}
		if (!EVIDENCE_SEMANTICS.includes(pattern.semantics)) {
			return `Evidence pattern "${pattern.key}" has an unknown semantics "${pattern.semantics}".`;
		}
		if (!HAYSTACKS.includes(pattern.haystack)) {
			return `Evidence pattern "${pattern.key}" has an unknown haystack "${pattern.haystack}".`;
		}
		const lines = pattern.pattern
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0);
		if (lines.length === 0) {
			return `Evidence pattern "${pattern.key}" needs at least one pattern.`;
		}
		for (const line of lines) {
			try {
				new RegExp(line);
			} catch (e) {
				return `Evidence pattern "${pattern.key}" is not a valid regex: ${(e as Error).message}`;
			}
		}
		if (pattern.semantics === "capture_value" || pattern.semantics === "distinct_count") {
			const g = pattern.captureGroup.trim();
			if (g === "" || !/^[1-9]$/.test(g)) {
				return `Evidence pattern "${pattern.key}" needs a capture group (integer 1-9) for ${pattern.semantics}.`;
			}
		}
	}
	return null;
}
