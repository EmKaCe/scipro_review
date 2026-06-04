/**
 * @file Unit tests for json-serialize.ts
 *
 * Tests the shared deep-clone utility for stripping Proxy wrappers
 * and handling Set/Map conversions.
 */
import { describe, it, expect } from "vitest";
import { jsonSerialize } from "$lib/utils/json-serialize";

describe("jsonSerialize", () => {
	it("returns primitives unchanged", () => {
		expect(jsonSerialize(42)).toBe(42);
		expect(jsonSerialize("hello")).toBe("hello");
		expect(jsonSerialize(true)).toBe(true);
		expect(jsonSerialize(null)).toBe(null);
	});

	it("converts Set to Array", () => {
		const result = jsonSerialize(new Set(["a", "b", "c"]));
		expect(Array.isArray(result)).toBe(true);
		expect(result).toEqual(["a", "b", "c"]);
	});

	it("converts Map to array of entries", () => {
		const map = new Map<string, number>([
			["a", 1],
			["b", 2],
		]);
		const result = jsonSerialize(map);
		expect(Array.isArray(result)).toBe(true);
		expect(result).toEqual([
			["a", 1],
			["b", 2],
		]);
	});

	it("deep-clones nested objects with Sets", () => {
		const input = {
			name: "test",
			items: new Set(["x", "y"]),
			meta: { tags: new Set(["a"]) },
		};
		const result = jsonSerialize(input) as Record<string, unknown>;
		expect(result.name).toBe("test");
		expect(result.items).toEqual(["x", "y"]);
		expect((result.meta as Record<string, unknown>).tags).toEqual(["a"]);
	});

	it("deep-clones nested objects with Maps", () => {
		const input = {
			scores: new Map<string, number>([["dim1", 4]]),
		};
		const result = jsonSerialize(input) as Record<string, unknown>;
		expect(result.scores).toEqual([["dim1", 4]]);
	});

	it("handles objects with both Set and Map", () => {
		const input = {
			checked: new Set(["item1"]),
			deductions: new Map<string, number>([["item1", 2]]),
		};
		const result = jsonSerialize(input) as Record<string, unknown>;
		expect(result.checked).toEqual(["item1"]);
		expect(result.deductions).toEqual([["item1", 2]]);
	});

	it("strips undefined values (JSON.stringify behavior)", () => {
		const input = { a: 1, b: undefined };
		const result = jsonSerialize(input) as Record<string, unknown>;
		expect(result).not.toHaveProperty("b");
	});

	it("strips functions (JSON.stringify behavior)", () => {
		const input = { a: 1, fn: () => "hello" };
		const result = jsonSerialize(input) as Record<string, unknown>;
		expect(result).not.toHaveProperty("fn");
	});

	it("handles arrays containing Sets", () => {
		const input = [{ items: new Set([1, 2]) }, { items: new Set([3, 4]) }];
		const result = jsonSerialize(input) as Array<Record<string, unknown>>;
		expect(result).toHaveLength(2);
		expect(result[0].items).toEqual([1, 2]);
		expect(result[1].items).toEqual([3, 4]);
	});

	it("handles empty Set", () => {
		const result = jsonSerialize(new Set());
		expect(result).toEqual([]);
	});

	it("handles empty Map", () => {
		const result = jsonSerialize(new Map());
		expect(result).toEqual([]);
	});

	it("handles deeply nested mixed structures", () => {
		const input = {
			level1: {
				level2: {
					tags: new Set(["deep"]),
					mapping: new Map<string, number>([["key", 42]]),
				},
			},
		};
		const result = jsonSerialize(input) as Record<string, unknown>;
		const l2 = (result.level1 as Record<string, unknown>).level2 as Record<string, unknown>;
		expect(l2.tags).toEqual(["deep"]);
		expect(l2.mapping).toEqual([["key", 42]]);
	});
});
