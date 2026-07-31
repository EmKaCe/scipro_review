/**
 * @file L5 tests for the structural plagiarism engine (Phase 3d.1).
 *
 * Covers: identical/shared/unrelated notebooks, normalization (comments,
 * docstrings, whitespace), configurable n-gram size, boilerplate
 * resistance, flags + details, thresholds/severity, sorting, empty inputs,
 * and the markdown exclusion policy.
 */
import { describe, expect, it } from "vitest";

import {
	CELL_MATCH_THRESHOLD,
	classifyPair,
	combinedScore,
	compareAll,
	compareNotebooks,
	extractComments,
	fingerprintNotebook,
	isFlaggedPair,
	jaccard,
	normalizeCode,
	type NotebookInput,
	type PlagiarismPair,
} from "$lib/server/plagiarism/structural";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function notebook(studentId: string, cells: Array<{ type?: string; source: string }>): NotebookInput {
	return { studentId, cells: cells.map((c) => ({ type: c.type ?? "code", source: c.source })) };
}

const SHARED_CELL = [
	'import numpy as np',
	'data = np.loadtxt("data.csv")',
	'mean = data.mean()',
	'print(mean)',
].join("\n");

const UNRELATED_CELL = [
	'import math',
	'radius = 5',
	'area = math.pi * radius ** 2',
	'print(area)',
].join("\n");

const MD_A = "import math\nx = alpha + beta * gamma\nprint(x)";
const MD_B = "y = delta + epsilon * zeta\nprint(y)";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("compareNotebooks — core similarity", () => {
	it("identical notebooks get cellOverlap and notebookOverlap of 1.0", () => {
		const a = notebook("2026SS_01", [
			{ source: SHARED_CELL },
			{ source: UNRELATED_CELL },
		]);
		const b = notebook("2026SS_02", [
			{ source: SHARED_CELL },
			{ source: UNRELATED_CELL },
		]);

		const pair = compareNotebooks(a, b);

		expect(pair.cellOverlap).toBe(1);
		expect(pair.notebookOverlap).toBe(1);
		expect(pair.matchedCells).toHaveLength(2);
		expect(pair.matchedCells.map((m) => m.similarity)).toEqual([1, 1]);
		expect(classifyPair(pair)).toBe("high");
	});

	it("notebooks sharing most cells are flagged high with correct cell indices", () => {
		const a = notebook("2026SS_01", [
			{ source: SHARED_CELL },
			{ source: SHARED_CELL },
			{ source: MD_A },
		]);
		const b = notebook("2026SS_02", [
			{ source: SHARED_CELL },
			{ source: SHARED_CELL },
			{ source: MD_B },
		]);

		const pair = compareNotebooks(a, b);

		expect(pair.cellOverlap).toBeCloseTo(2 / 3, 4);
		expect(isFlaggedPair(pair)).toBe(true);
		expect(classifyPair(pair)).toBe("high");
		expect(pair.matchedCells).toHaveLength(2);
		for (const match of pair.matchedCells) {
			expect(match.cellIndexA).toBeLessThan(2);
			expect(match.cellIndexB).toBeLessThan(2);
			expect(match.similarity).toBe(1);
		}
	});

	it("unrelated notebooks produce no matches, no flags and severity none", () => {
		const a = notebook("2026SS_01", [{ source: SHARED_CELL }]);
		const b = notebook("2026SS_02", [{ source: MD_A }, { source: MD_B }]);

		const pair = compareNotebooks(a, b);

		expect(pair.cellOverlap).toBe(0);
		expect(pair.notebookOverlap).toBe(0);
		expect(pair.matchedCells).toEqual([]);
		expect(pair.flags).toEqual([]);
		expect(isFlaggedPair(pair)).toBe(false);
		expect(classifyPair(pair)).toBe("none");
	});

	it("canonical pair ordering: studentA < studentB regardless of input order", () => {
		const a = notebook("2026SS_02", [{ source: SHARED_CELL }]);
		const b = notebook("2026SS_01", [{ source: SHARED_CELL }]);

		const pair = compareNotebooks(a, b);

		expect(pair.studentA).toBe("2026SS_01");
		expect(pair.studentB).toBe("2026SS_02");
		// matchedCells indices refer to the canonical studentA notebook.
		expect(pair.matchedCells[0]!.cellIndexA).toBe(0);
		expect(pair.matchedCells[0]!.cellIndexB).toBe(0);
	});

	it("whole-notebook overlap is partial when only some cells are shared", () => {
		const a = notebook("2026SS_01", [
			{ source: SHARED_CELL },
			{ source: SHARED_CELL },
			{ source: MD_A },
		]);
		const b = notebook("2026SS_02", [
			{ source: SHARED_CELL },
			{ source: SHARED_CELL },
			{ source: MD_B },
		]);

		const pair = compareNotebooks(a, b);

		expect(pair.notebookOverlap).toBeGreaterThan(0);
		expect(pair.notebookOverlap).toBeLessThan(1);
	});
});

describe("normalization", () => {
	it("strips comments: notebooks differing only in comments are identical", () => {
		const a = notebook("2026SS_01", [
			{ source: 'data = np.loadtxt("data.csv")  # read the measurements' },
		]);
		const b = notebook("2026SS_02", [{ source: 'data = np.loadtxt("data.csv")' }]);

		const pair = compareNotebooks(a, b);

		expect(pair.cellOverlap).toBe(1);
		expect(pair.matchedCells[0]!.similarity).toBe(1);
		expect(pair.details.sharedComments).toEqual([]);
		// The comment itself is still extracted for comment similarity.
		expect(extractComments('data = np.loadtxt("data.csv")  # read the measurements')).toEqual([
			"read the measurements",
		]);
	});

	it("strips full-line comments and docstrings", () => {
		const a = notebook("2026SS_01", [
			{ source: '# load the data\ndef compute(data):\n    """Mean of the array."""\n    return data.mean()' },
		]);
		const b = notebook("2026SS_02", [
			{ source: "def compute(data):\n    return data.mean()" },
		]);

		const pair = compareNotebooks(a, b);

		expect(pair.cellOverlap).toBe(1);
		expect(pair.matchedCells[0]!.similarity).toBe(1);
		expect(normalizeCode('def compute(data):\n    """Mean of the array."""\n    return data.mean()')).toBe(
			"def compute(data): return data.mean()",
		);
	});

	it("normalizes whitespace: spacing/indentation differences do not matter", () => {
		const a = notebook("2026SS_01", [{ source: 'data = np.loadtxt( "data.csv" )' }]);
		const b = notebook("2026SS_02", [{ source: 'data=np.loadtxt("data.csv")' }]);

		const pair = compareNotebooks(a, b);

		expect(pair.cellOverlap).toBe(1);
		expect(pair.matchedCells[0]!.similarity).toBe(1);
	});

	it("excludes markdown cells: identical template markdown alone does not flag", () => {
		const markdown = "# Task 1\nLoad the data and plot it";
		const a = notebook("2026SS_01", [
			{ type: "markdown", source: markdown },
			{ source: 'data = np.loadtxt("a.csv")' },
		]);
		const b = notebook("2026SS_02", [
			{ type: "markdown", source: markdown },
			{ source: "stuff = math.sqrt(2)" },
		]);

		const pair = compareNotebooks(a, b);

		expect(pair.cellOverlap).toBe(0);
		expect(pair.notebookOverlap).toBe(0);
		expect(isFlaggedPair(pair)).toBe(false);
	});
});

describe("n-gram configuration", () => {
	it("supports configurable n-gram sizes (3 vs 5)", () => {
		const a = notebook("2026SS_01", [{ source: "x = alpha + beta" }]);
		const b = notebook("2026SS_02", [{ source: "x = alpha + beta" }]);

		const n3 = compareNotebooks(a, b, { ngramSize: 3 });
		const n5 = compareNotebooks(a, b, { ngramSize: 5 });

		expect(n3.cellOverlap).toBe(1);
		expect(n5.cellOverlap).toBe(0); // 4 tokens < 5 -> no n-grams
	});

	it("rejects n-gram sizes outside 2..5", () => {
		const a = notebook("2026SS_01", [{ source: SHARED_CELL }]);
		const b = notebook("2026SS_02", [{ source: SHARED_CELL }]);

		expect(() => compareNotebooks(a, b, { ngramSize: 6 })).toThrow(RangeError);
		expect(() => compareNotebooks(a, b, { ngramSize: 1 })).toThrow(RangeError);
		expect(() => fingerprintNotebook(a, { ngramSize: 3.5 })).toThrow(RangeError);
	});

	it("is resistant to keyword/boilerplate-only notebooks", () => {
		const a = notebook("2026SS_01", [
			{ source: "import numpy as np" },
			{ source: 'print("hello")' },
		]);
		const b = notebook("2026SS_02", [
			{ source: "import numpy as np" },
			{ source: 'print("hello")' },
		]);

		const pair = compareNotebooks(a, b);

		expect(pair.cellOverlap).toBe(0);
		expect(pair.notebookOverlap).toBe(0);
		expect(isFlaggedPair(pair)).toBe(false);
	});
});

describe("matched cells", () => {
	it("records only cell pairs at/above CELL_MATCH_THRESHOLD", () => {
		// A cell0 vs B cell1: 4 shared / 6 union = 0.6667 -> matched.
		// A cell0 vs B cell0: 4 shared / 10 union = 0.4 -> not matched.
		const a = notebook("2026SS_01", [
			{ source: "alpha = beta + gamma\ndelta = epsilon + zeta" },
		]);
		const b = notebook("2026SS_02", [
			{
				source:
					"alpha = beta + gamma\ndelta = epsilon + zeta\neta = theta + iota\nkappa = lambda + mu",
			},
			{ source: "alpha = beta + gamma\ndelta = epsilon + zeta\neta = theta + iota" },
		]);

		const pair = compareNotebooks(a, b);

		expect(pair.matchedCells).toHaveLength(1);
		// Exact similarity depends on n-gram fingerprinting internals; the
		// contract is: the right pair is recorded and its score is >= threshold
		// (while the 0.4 pair below threshold is absent — checked by length).
		expect(pair.matchedCells[0]).toEqual(
			expect.objectContaining({
				cellIndexA: 0,
				cellIndexB: 1,
			}),
		);
		expect(pair.matchedCells[0]!.similarity).toBeGreaterThanOrEqual(CELL_MATCH_THRESHOLD);
		for (const match of pair.matchedCells) {
			expect(match.similarity).toBeGreaterThanOrEqual(CELL_MATCH_THRESHOLD);
		}
	});
});

describe("flags and details", () => {
	it("flags shared imports, variables and comments with details", () => {
		const a = notebook("2026SS_01", [
			{ source: 'import numpy as np\ndata = load("a.csv")\nresult = process(data)' },
			{ source: "# normalize the values\nprint(result)" },
		]);
		const b = notebook("2026SS_02", [
			{ source: 'import numpy as np\ndata = load("b.csv")\nresult = process(data)' },
			{ source: "# normalize the values\nprint(result)" },
		]);

		const pair = compareNotebooks(a, b);

		expect(pair.flags).toContain("shared_imports");
		expect(pair.flags).toContain("shared_variables");
		expect(pair.flags).toContain("shared_comments");
		expect(pair.flags).not.toContain("same_cell_structure");
		expect(pair.details.sharedImports).toEqual(["numpy"]);
		expect(pair.details.sharedVariableNames).toEqual(["data", "np", "result"]);
		expect(pair.details.sharedComments).toEqual(["normalize the values"]);
	});

	it("flags same_cell_structure for identical cell layouts", () => {
		const a = notebook("2026SS_01", [{ source: SHARED_CELL }, { source: MD_A }]);
		const b = notebook("2026SS_02", [{ source: SHARED_CELL }, { source: MD_A }]);

		const pair = compareNotebooks(a, b);

		expect(pair.flags).toContain("same_cell_structure");
		expect(pair.details.cellCountDiff).toBe(0);
	});

	it("reports the cell count difference in details", () => {
		const a = notebook("2026SS_01", [{ source: SHARED_CELL }]);
		const b = notebook("2026SS_02", [{ source: SHARED_CELL }, { source: MD_A }]);

		const pair = compareNotebooks(a, b);

		expect(pair.details.cellCountDiff).toBe(1);
	});
});

describe("compareAll — matrix", () => {
	it("returns all unique pairs sorted by cellOverlap descending", () => {
		const a = notebook("2026SS_01", [{ source: SHARED_CELL }, { source: UNRELATED_CELL }]);
		const b = notebook("2026SS_02", [{ source: SHARED_CELL }, { source: UNRELATED_CELL }]);
		const c = notebook("2026SS_03", [{ source: MD_A }, { source: MD_B }]);

		const pairs = compareAll([a, b, c]);

		expect(pairs).toHaveLength(3);
		expect(pairs[0]!.studentA).toBe("2026SS_01");
		expect(pairs[0]!.studentB).toBe("2026SS_02");
		expect(pairs[0]!.cellOverlap).toBe(1);
		for (const pair of pairs) {
			expect(pair.studentA < pair.studentB).toBe(true);
		}
		// Sorted: 1.0, then 0, 0 (ties broken by student ids).
		expect(pairs[1]!.cellOverlap).toBe(0);
		expect(pairs[2]!.cellOverlap).toBe(0);
		expect(pairs[1]!.studentA).toBe("2026SS_01");
	});

	it("returns an empty matrix for an empty assignment", () => {
		expect(compareAll([])).toEqual([]);
	});

	it("skips self-pairs when student ids collide", () => {
		const a = notebook("2026SS_01", [{ source: SHARED_CELL }]);
		const b = notebook("2026SS_01", [{ source: UNRELATED_CELL }]);

		expect(compareAll([a, b])).toEqual([]);
	});
});

describe("empty / degenerate notebooks", () => {
	it("an empty notebook never matches", () => {
		const empty = notebook("2026SS_01", []);
		const full = notebook("2026SS_02", [{ source: SHARED_CELL }]);

		const pair = compareNotebooks(empty, full);

		expect(pair.cellOverlap).toBe(0);
		expect(pair.notebookOverlap).toBe(0);
		expect(pair.matchedCells).toEqual([]);
		expect(classifyPair(pair)).toBe("none");
	});

	it("jaccard of two empty sets is 0 (no evidence)", () => {
		expect(jaccard(new Set(), new Set())).toBe(0);
	});
});

describe("combinedScore", () => {
	it("equals cellOverlap without a semantic score", () => {
		const pair: PlagiarismPair = {
			studentA: "2026SS_01",
			studentB: "2026SS_02",
			cellOverlap: 0.6,
			notebookOverlap: 0.5,
			matchedCells: [],
			flags: [],
			details: { cellCountDiff: 0, sharedVariableNames: [], sharedComments: [], sharedImports: [] },
		};

		expect(combinedScore(pair)).toBe(0.6);
	});

	it("weights the semantic score when present (0.7 structural / 0.3 semantic)", () => {
		const pair: PlagiarismPair = {
			studentA: "2026SS_01",
			studentB: "2026SS_02",
			cellOverlap: 0.6,
			notebookOverlap: 0.5,
			matchedCells: [],
			flags: [],
			details: { cellCountDiff: 0, sharedVariableNames: [], sharedComments: [], sharedImports: [] },
			semanticScore: 0.8,
		};

		expect(combinedScore(pair)).toBe(0.66);
	});
});
