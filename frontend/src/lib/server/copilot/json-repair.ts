/**
 * @file JSON extraction + repair for LLM responses.
 *
 * LLMs frequently wrap JSON in markdown code fences or emit slightly
 * malformed JSON (trailing commas, single-quoted keys, …). This module
 * extracts the JSON portion of a response text and repairs the common
 * mistakes so that `JSON.parse` succeeds.
 *
 * Standalone module — no server-only imports, safe to unit test directly.
 */

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/** First markdown code fence tagged `json` (case-insensitive). */
const FENCE_JSON_PATTERN = /```\s*json\b\s*([\s\S]*?)```/i;

/** First markdown code fence with no (or any other) language tag. */
const FENCE_ANY_PATTERN = /```\s*([\s\S]*?)```/;

/**
 * Extract a JSON candidate from `text`:
 *
 * 1. A `json`-tagged code fence, if present (preferred — explicit signal).
 * 2. Any code fence (with or without language tag).
 * 3. The outermost balanced `{…}` / `[…]` block, walking characters while
 *    tracking string/escape state and nesting depth.
 *
 * Throws when no JSON object/array can be found.
 */
function extractJSONCandidate(text: string): string {
	const jsonFence = text.match(FENCE_JSON_PATTERN);
	if (jsonFence?.[1]) {
		return jsonFence[1];
	}

	const anyFence = text.match(FENCE_ANY_PATTERN);
	if (anyFence?.[1]) {
		return anyFence[1];
	}

	const block = findBalancedBlock(text);
	if (block !== null) {
		return block;
	}

	throw new Error("Could not find valid JSON object or array in the response");
}

/**
 * Find the outermost balanced `{…}` or `[…]` block in `text`, ignoring
 * characters inside quoted strings (with escape handling).
 *
 * First pass tracks both double- and single-quoted strings (LLMs often emit
 * single-quoted JSON). If that fails — e.g. an apostrophe in prose opens an
 * unterminated single-quote string — retry tracking only double quotes.
 */
function findBalancedBlock(text: string): string | null {
	const withSingleQuotes = findBalancedBlockWith(text, true);
	if (withSingleQuotes !== null) {
		return withSingleQuotes;
	}
	return findBalancedBlockWith(text, false);
}

function findBalancedBlockWith(text: string, trackSingleQuotes: boolean): string | null {
	let start = -1;
	let depth = 0;
	let inString = false;
	let escaped = false;
	let quoteChar = '"';

	for (let i = 0; i < text.length; i++) {
		const ch = text[i]!;

		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (ch === "\\") {
				escaped = true;
			} else if (ch === quoteChar) {
				inString = false;
			}
			continue;
		}

		if (ch === '"' || (trackSingleQuotes && ch === "'")) {
			inString = true;
			quoteChar = ch;
			continue;
		}

		if (ch === "{" || ch === "[") {
			if (depth === 0) start = i;
			depth++;
		} else if (ch === "}" || ch === "]") {
			if (depth > 0) depth--;
			if (depth === 0 && start >= 0) {
				return text.slice(start, i + 1);
			}
		}
	}

	return null;
}

// ---------------------------------------------------------------------------
// Repair
// ---------------------------------------------------------------------------

/**
 * Repair common LLM JSON errors:
 * - BOM prefix stripped
 * - single-quoted keys converted to double-quoted
 * - single-quoted simple string values converted to double-quoted
 * - trailing commas before a closing delimiter removed
 * - double (or more) consecutive commas collapsed
 */
function repairJSON(raw: string): string {
	let s = raw.replace(/^\uFEFF/, "");

	// Single-quoted keys: {'key': …} → {"key": …}
	// (lookbehind/lookahead so consecutive matches don't overlap)
	s = s.replace(/(?<=[\[{,]\s*)'([^'\\]*(?:\\.[^'\\]*)*)'(?=\s*:)/g, '"$1"');

	// Single-quoted string values after a colon: {"key": 'value'} → {"key": "value"}
	s = s.replace(/(?<=:\s*)'([^'\\]*(?:\\.[^'\\]*)*)'(?=\s*[,}\]])/g, '"$1"');

	// Single-quoted string elements in arrays: ['a', 'b'] → ["a", "b"]
	s = s.replace(/(?<=[\[{,]\s*)'([^'\\]*(?:\\.[^'\\]*)*)'(?=\s*[,}\]])/g, '"$1"');

	// Consecutive commas first: {"a": 1,, "b": 2} → {"a": 1, "b": 2}
	s = s.replace(/,{2,}/g, ",");

	// Then trailing commas before a closing brace/bracket: {"a": 1,} → {"a": 1}
	s = s.replace(/,\s*([}\]])/g, "$1");

	return s;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract the JSON portion of a (possibly noisy) LLM response and parse it.
 *
 * @throws {Error} with a message containing "valid JSON" when no JSON
 *   object/array can be found; otherwise lets `JSON.parse` errors propagate.
 */
export function extractAndParseJSON(text: string): unknown {
	const candidate = extractJSONCandidate(text);
	return JSON.parse(repairJSON(candidate));
}
