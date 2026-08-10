/**
 * @file JSON extraction + repair for LLM responses.
 *
 * LLMs frequently wrap JSON in markdown code fences or emit slightly
 * malformed JSON (trailing commas, single-quoted keys, unescaped literal
 * newlines in strings, …). This module extracts the JSON portion of a
 * response text and repairs the common mistakes so that `JSON.parse`
 * succeeds.
 *
 * Strategy ladder (each rung is tried only when the previous ones failed):
 *   1. Direct `JSON.parse(text.trim())` — the happy path for ~95% of
 *      responses, zero extraction/repair overhead.
 *   2. Markdown code fences, non-greedy: a `json`-tagged fence first
 *      (explicit signal), then any fence.
 *   3. Aggressive fence extraction: everything between the FIRST opening
 *      fence and the LAST closing fence in the text (catches responses
 *      where a non-greedy match would stop too early).
 *   4. The outermost balanced `{…}` / `[…]` block via a character walk
 *      tracking string/escape state and nesting depth.
 *   5. Last resort: the first `{` and its matching `}` by naive brace
 *      counting (simpler than the string-aware walker; only reached when
 *      the walker gave up).
 *
 * Each candidate is repaired and parsed; the first that parses wins. When
 * every rung fails a descriptive error (with a text snippet) is thrown.
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
 * Aggressive fence extraction: the content between the FIRST opening fence
 * (preferring a `json` tag) and the LAST closing fence in the text. The
 * non-greedy patterns above stop at the first closing fence, which can cut
 * a candidate short when the response contains nested-looking fence markers;
 * this fallback widens the net. Returns null when there is no second fence.
 */
function extractFenceAggressive(text: string): string | null {
	const firstMatch = text.match(/```\s*(?:json\b)?/i);
	if (!firstMatch || firstMatch.index === undefined) return null;
	const lastFence = text.lastIndexOf("```");
	if (lastFence <= firstMatch.index) return null;
	return text.slice(firstMatch.index + firstMatch[0].length, lastFence);
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

/**
 * Last-resort extraction: the substring between the FIRST `{` and the brace
 * that balances it by naive counting (no string/escape awareness). Only used
 * when the string-aware walker found nothing; a stray `{` in prose may
 * produce a bogus candidate, but it is cheaper to try and fail than to give
 * up on the response.
 */
function findNaiveBracedBlock(text: string): string | null {
	const start = text.indexOf("{");
	if (start === -1) return null;
	let depth = 0;
	for (let i = start; i < text.length; i++) {
		if (text[i] === "{") {
			depth++;
		} else if (text[i] === "}") {
			depth--;
			if (depth === 0) {
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

/**
 * Second repair pass: escape unescaped literal newlines, tabs, and other
 * control characters that appear INSIDE double-quoted string values — a
 * very common LLM mistake (multi-line strings emitted with raw line
 * breaks). Outside strings, whitespace is legal JSON and is left alone.
 * Already-escaped sequences (`\n`, `\"`, …) are preserved verbatim.
 */
function escapeControlCharsInStrings(raw: string): string {
	let out = "";
	let inString = false;
	let escaped = false;

	for (const ch of raw) {
		if (inString) {
			if (escaped) {
				out += ch;
				escaped = false;
				continue;
			}
			if (ch === "\\") {
				out += ch;
				escaped = true;
				continue;
			}
			if (ch === '"') {
				inString = false;
				out += ch;
				continue;
			}
			const code = ch.charCodeAt(0);
			if (code < 0x20) {
				if (ch === "\n") out += "\\n";
				else if (ch === "\r") out += "\\r";
				else if (ch === "\t") out += "\\t";
				else out += `\\u${code.toString(16).padStart(4, "0")}`;
				continue;
			}
			out += ch;
			continue;
		}
		if (ch === '"') inString = true;
		out += ch;
	}

	return out;
}

/**
 * Try to parse one candidate: repair first, then a second repair pass that
 * escapes control characters inside strings. Returns undefined when neither
 * attempt parses (the caller moves on to the next candidate).
 */
function tryParseJSONCandidate(candidate: string): unknown {
	const repaired = repairJSON(candidate);
	try {
		return JSON.parse(repaired);
	} catch {
		try {
			return JSON.parse(escapeControlCharsInStrings(repaired));
		} catch {
			return undefined;
		}
	}
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract the JSON portion of a (possibly noisy) LLM response and parse it.
 *
 * @throws {Error} with a message containing "valid JSON" when no JSON
 *   object/array can be found, including a snippet of the offending text;
 *   otherwise lets `JSON.parse` errors propagate.
 */
export function extractAndParseJSON(text: string): unknown {
	// 1. Happy path: the response IS the JSON (no fences, no prose). Trimmed
	//    so leading/trailing whitespace is tolerated.
	try {
		return JSON.parse(text.trim());
	} catch {
		// Fall through to extraction.
	}

	// 2-5. Extraction ladder — each candidate is repaired + parsed; the
	// first one that parses wins.
	const candidates: string[] = [];
	const jsonFence = text.match(FENCE_JSON_PATTERN);
	if (jsonFence?.[1]) candidates.push(jsonFence[1]);

	const anyFence = text.match(FENCE_ANY_PATTERN);
	if (anyFence?.[1]) candidates.push(anyFence[1]);

	const aggressiveFence = extractFenceAggressive(text);
	if (aggressiveFence !== null) candidates.push(aggressiveFence);

	const block = findBalancedBlock(text);
	if (block !== null) candidates.push(block);

	const naive = findNaiveBracedBlock(text);
	if (naive !== null) candidates.push(naive);

	const seen = new Set<string>();
	for (const candidate of candidates) {
		if (seen.has(candidate)) continue;
		seen.add(candidate);
		const parsed = tryParseJSONCandidate(candidate);
		if (parsed !== undefined) return parsed;
	}

	throw new Error(
		`Could not find valid JSON object or array in the response. Text near the failure: ${JSON.stringify(text.slice(0, 200))}`,
	);
}
