/**
 * @file Unit tests for the cell-diff utility (original vs auto-fixed cells).
 *
 * The diff is deliberately simple: line-zip by index, no Myers algorithm —
 * the LLM replaces whole cells, so the teacher only needs to see which
 * lines changed and the error/output before/after.
 */
import { describe, expect, it } from "vitest";

import type { CellInfo } from "$lib/types/submissions";
import { cellDelta, diffLines } from "$lib/utils/cell-diff";

describe("diffLines", () => {
	it("returns no changes for identical sources", () => {
		expect(diffLines("a = 1\nb = 2", "a = 1\nb = 2")).toEqual([]);
	});

	it("returns the changed line pair", () => {
		expect(diffLines("a = 1\nb = 2", "a = 1\nb = 3")).toEqual([
			{ oldLine: "b = 2", newLine: "b = 3" },
		]);
	});

	it("pads the shorter side when line counts differ", () => {
		expect(diffLines("a = 1\nb = 2", "a = 1")).toEqual([{ oldLine: "b = 2", newLine: "" }]);
		expect(diffLines("a = 1", "a = 1\nb = 3")).toEqual([{ oldLine: "", newLine: "b = 3" }]);
	});

	it("ignores a trailing-newline-only difference", () => {
		expect(diffLines("print(x)", "print(x)\n")).toEqual([]);
	});
});

describe("cellDelta", () => {
	const original: CellInfo = {
		index: 1,
		type: "code",
		source: "y = (x + 1",
		error: "SyntaxError: invalid syntax",
		marker: "error",
	};
	const fixed: CellInfo = {
		index: 1,
		type: "code",
		source: "y = (x + 1)",
		output: "6\n",
		marker: "pending",
	};

	it("combines line changes with error/output before and after", () => {
		const delta = cellDelta(original, fixed);
		expect(delta).toEqual({
			changedLines: [{ oldLine: "y = (x + 1", newLine: "y = (x + 1)" }],
			errorBefore: "SyntaxError: invalid syntax",
			errorAfter: null,
			outputBefore: "",
			outputAfter: "6\n",
		});
	});

	it("normalizes missing errors/outputs to null/empty", () => {
		const delta = cellDelta(
			{ ...original, error: undefined, output: undefined },
			{ ...fixed, output: undefined },
		);
		expect(delta.errorBefore).toBeNull();
		expect(delta.outputBefore).toBe("");
		expect(delta.outputAfter).toBe("");
	});
});
