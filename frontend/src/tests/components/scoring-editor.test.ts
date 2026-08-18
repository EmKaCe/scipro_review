/**
 * @file L4 component test — scoring editor model helpers.
 *
 * Covers the pure model layer shared by the scoring editor tabs: the
 * server-shape ↔ editable-draft round-trip, the empty-draft → empty-map
 * conversion (no anchors = calibration off), client-side UX validation,
 * and pattern-key uniqueness.
 */
import { describe, expect, it } from "vitest";

import {
	fromServerScoring,
	nextPatternKey,
	toServerScoring,
	validateScoringDraft,
	type EditableScoringConfig,
	type ScoringConfigDocument,
} from "$lib/components/assignments/scoring-editor-model.js";

/** A minimal soil-like scoring document (subset of data/scoring/soil_contamination.yaml). */
const SOIL_LIKE: ScoringConfigDocument = {
	reference_anchors: { A: 1210.91, B: -484.95, L: 684.48 },
	evidence_patterns: {
		std_err_from_covariance: {
			pattern: "np\\.sqrt\\s*\\(\\s*np\\.diag\\s*\\(\\s*covariance\\s*\\)\\s*\\)",
			semantics: "test",
			haystack: "output+code",
		},
		fit_reproduces_reference: {
			pattern: ["\\bA\\b[^\\n]{0,60}?1210\\.9\\d*", "\\bB\\b[^\\n]{0,60}?-?484\\.9\\d*"],
			semantics: "test_all",
			haystack: "output",
		},
		plot_family_counter: {
			pattern: "(?:plt|ax)\\.(\\w+)\\s*\\(",
			semantics: "distinct_count",
			capture_group: 1,
			haystack: "code",
		},
	},
	disallowed_libraries: ["tensorflow", "torch", "keras"],
	prompt_anchor_text: {
		dimension_guidance: {
			scientific_programming: "scientific methodology. Anchor scale: 5-5.5 = fit reproduces the reference.",
		},
	},
};

describe("scoring-editor-model", () => {
	it("round-trips a soil-like scoring document losslessly", () => {
		const draft = fromServerScoring(SOIL_LIKE);
		const server = toServerScoring(draft);

		expect(server.reference_anchors).toEqual(SOIL_LIKE.reference_anchors);
		expect(server.disallowed_libraries).toEqual(SOIL_LIKE.disallowed_libraries);
		expect(server.prompt_anchor_text).toEqual(SOIL_LIKE.prompt_anchor_text);

		const patterns = server.evidence_patterns as Record<string, Record<string, unknown>>;
		// Single-line pattern stays a string.
		expect(patterns.std_err_from_covariance).toMatchObject({
			pattern: SOIL_LIKE.evidence_patterns!.std_err_from_covariance!.pattern,
			semantics: "test",
			haystack: "output+code",
		});
		// Newline-separated list round-trips back to a string[].
		expect(patterns.fit_reproduces_reference!.pattern).toEqual(
			SOIL_LIKE.evidence_patterns!.fit_reproduces_reference!.pattern,
		);
		expect(patterns.fit_reproduces_reference!.semantics).toBe("test_all");
		// capture_group survives for capture semantics.
		expect(patterns.plot_family_counter).toMatchObject({
			pattern: SOIL_LIKE.evidence_patterns!.plot_family_counter!.pattern,
			semantics: "distinct_count",
			capture_group: 1,
			haystack: "code",
		});

		// And the draft round-trips back to the same document.
		expect(fromServerScoring(server as ScoringConfigDocument)).toEqual(draft);
	});

	it("converts an empty draft to an empty scoring map (no anchors = calibration off)", () => {
		const empty: EditableScoringConfig = {
			anchors: { A: "", B: "", x0: "", y0: "", L: "", r_squared: "", rmse: "" },
			evidencePatterns: [],
			disallowedLibraries: "",
			dimensionGuidance: {},
		};
		expect(toServerScoring(empty)).toEqual({});
	});

	it("omits empty anchors, empty capture groups and blank guidance entries", () => {
		const draft: EditableScoringConfig = {
			anchors: { A: "1210.91", B: "", x0: "", y0: "", L: "684.48", r_squared: "", rmse: "" },
			evidencePatterns: [
				{
					key: "partial_capture",
					semantics: "capture_value",
					haystack: "output",
					pattern: "\\bR\\s*(?:\\^2|²|2)\\s*[=:]\\s*([\\d.]+)",
					captureGroup: "",
				},
			],
			disallowedLibraries: "tensorflow, , torch",
			dimensionGuidance: { creativity: "", scientific_programming: "methodology text" },
		};
		const server = toServerScoring(draft);
		// Partial anchors are kept as-is (the server compile gate rejects them
		// with its all-or-nothing error — the client never blocks the save).
		expect(server.reference_anchors).toEqual({ A: 1210.91, L: 684.48 });
		// No capture_group emitted when the input is empty.
		const patterns = server.evidence_patterns as Record<string, Record<string, unknown>>;
		expect(patterns.partial_capture!.capture_group).toBeUndefined();
		// Comma-split trims and drops empty entries.
		expect(server.disallowed_libraries).toEqual(["tensorflow", "torch"]);
		// Blank guidance entries are dropped.
		expect(server.prompt_anchor_text).toEqual({
			dimension_guidance: { scientific_programming: "methodology text" },
		});
	});

	it("validates a bad regex with an error", () => {
		const draft = fromServerScoring(SOIL_LIKE);
		draft.evidencePatterns[0]!.pattern = "([unclosed";
		expect(validateScoringDraft(draft)).toMatch(/not a valid regex/);
	});

	it("validates an empty pattern key with an error", () => {
		const draft = fromServerScoring(SOIL_LIKE);
		draft.evidencePatterns[0]!.key = "";
		expect(validateScoringDraft(draft)).toMatch(/needs a key/);
	});

	it("validates a missing capture group for capture semantics", () => {
		const draft = fromServerScoring(SOIL_LIKE);
		draft.evidencePatterns[2]!.captureGroup = "";
		expect(validateScoringDraft(draft)).toMatch(/capture group/);
	});

	it("rejects a non-numeric anchor instead of silently dropping it", () => {
		const draft = fromServerScoring(SOIL_LIKE);
		draft.anchors["A"] = "abc";
		expect(validateScoringDraft(draft)).toMatch(/Anchor "A" must be a number/);
		// Empty anchors are still fine (calibration off is a valid state).
		const empty = fromServerScoring(SOIL_LIKE);
		for (const key of Object.keys(empty.anchors)) empty.anchors[key] = "";
		expect(validateScoringDraft(empty)).toBeNull();
	});

	it("returns null for a valid draft", () => {
		expect(validateScoringDraft(fromServerScoring(SOIL_LIKE))).toBeNull();
	});

	it("generates unique next pattern keys", () => {
		expect(nextPatternKey([])).toBe("new_pattern");
		expect(nextPatternKey(["new_pattern"])).toBe("new_pattern_2");
		expect(nextPatternKey(["new_pattern", "new_pattern_2", "new_pattern_3"])).toBe(
			"new_pattern_4",
		);
		// Unrelated keys don't collide with the reserved prefix.
		expect(nextPatternKey(["std_err_from_covariance"])).toBe("new_pattern");
	});
});
