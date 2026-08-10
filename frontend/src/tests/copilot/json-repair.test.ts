/**
 * @file Unit tests for extractAndParseJSON ($lib/server/copilot/json-repair).
 */
import { describe, expect, it } from "vitest";

import { extractAndParseJSON } from "$lib/server/copilot/json-repair";

describe("extractAndParseJSON", () => {
	it("parses clean JSON", () => {
		expect(extractAndParseJSON('{"a": 1, "b": [1, 2, 3]}')).toEqual({
			a: 1,
			b: [1, 2, 3],
		});
	});

	it("parses a clean JSON array", () => {
		expect(extractAndParseJSON("[1, 2, 3]")).toEqual([1, 2, 3]);
	});

	it("extracts JSON from a markdown code fence tagged json", () => {
		const text = 'Here is the result:\n```json\n{"a": 1}\n```\nThat is all.';
		expect(extractAndParseJSON(text)).toEqual({ a: 1 });
	});

	it("extracts JSON from an untagged markdown code fence", () => {
		const text = '```\n{"a": 1}\n```';
		expect(extractAndParseJSON(text)).toEqual({ a: 1 });
	});

	it("prefers a json-tagged fence over a preceding untagged one", () => {
		const text = '```\nprint("not json")\n```\n```json\n{"a": 1}\n```';
		expect(extractAndParseJSON(text)).toEqual({ a: 1 });
	});

	it("fixes a trailing comma in an object", () => {
		expect(extractAndParseJSON('{"a": 1, "b": 2,}')).toEqual({ a: 1, b: 2 });
	});

	it("fixes a trailing comma in an array", () => {
		expect(extractAndParseJSON("[1, 2, 3,]")).toEqual([1, 2, 3]);
	});

	it("fixes multiple consecutive commas", () => {
		expect(extractAndParseJSON('{"a": 1,, "b": 2}')).toEqual({ a: 1, b: 2 });
	});

	it("returns the first JSON object when multiple exist in the text", () => {
		const text = 'First result: {"a": 1}. Second result: {"b": 2}.';
		expect(extractAndParseJSON(text)).toEqual({ a: 1 });
	});

	it("returns the first JSON object when multiple code fences exist", () => {
		const text = '```json\n{"a": 1}\n```\n\n```json\n{"b": 2}\n```';
		expect(extractAndParseJSON(text)).toEqual({ a: 1 });
	});

	it("throws on irreparable input (no braces at all)", () => {
		expect(() => extractAndParseJSON("This response contains no JSON whatsoever.")).toThrow(
			/valid JSON/,
		);
	});

	it("throws when only non-JSON content sits in a code fence", () => {
		expect(() => extractAndParseJSON('```\nprint("hello")\n```')).toThrow();
	});

	it("fixes single-quoted keys", () => {
		expect(extractAndParseJSON("{'a': 1, 'b': 'x'}")).toEqual({ a: 1, b: "x" });
	});

	it("fixes single-quoted values and array elements", () => {
		expect(extractAndParseJSON("{'a': 'x', 'b': ['y', 'z']}")).toEqual({
			a: "x",
			b: ["y", "z"],
		});
	});

	it("keeps escaped quotes inside strings intact", () => {
		expect(extractAndParseJSON('{"text": "She said \\"hello\\""}')).toEqual({
			text: 'She said "hello"',
		});
	});

	it("strips a BOM prefix", () => {
		expect(extractAndParseJSON('\uFEFF{"a": 1}')).toEqual({ a: 1 });
	});
});
