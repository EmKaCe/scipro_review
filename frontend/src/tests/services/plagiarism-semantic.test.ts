/**
 * @file L5 tests for the semantic (KI Connect) plagiarism wrapper (Phase 3d.2).
 *
 * Covers graceful degradation (no API key, LLM failure, malformed response
 * -> null), response parsing/clamping, pair capping, and result merging.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	compareNotebooks,
	mergeSemanticResults,
	runSemanticPass,
} from "$lib/server/plagiarism/semantic";
import type { NotebookInput, PlagiarismPair } from "$lib/server/plagiarism/structural";

// ---------------------------------------------------------------------------
// KI Connect client mock
// ---------------------------------------------------------------------------

const mockClient = vi.hoisted(() => ({
	chatCompletion: vi.fn(),
}));

vi.mock("$lib/server/ki-connect", async (importOriginal) => {
	const actual = await importOriginal<typeof import("$lib/server/ki-connect")>();
	return {
		...actual,
		getKiConnectClient: () => mockClient,
	};
});

// ---------------------------------------------------------------------------
// Fixtures & helpers
// ---------------------------------------------------------------------------

function notebook(studentId: string, source: string): NotebookInput {
	return { studentId, cells: [{ type: "code", source }] };
}

function pair(a: string, b: string): PlagiarismPair {
	return {
		studentA: a,
		studentB: b,
		cellOverlap: 0.9,
		notebookOverlap: 0.8,
		matchedCells: [],
		flags: [],
		details: {
			cellCountDiff: 0,
			sharedVariableNames: [],
			sharedComments: [],
			sharedImports: [],
		},
	};
}

const NB_A = notebook("2026SS_01", "data = np.loadtxt('a.csv')\nmean = data.mean()");
const NB_B = notebook("2026SS_02", "data = np.loadtxt('b.csv')\nmean = data.mean()");
const NB_C = notebook("2026SS_03", "radius = 5\narea = 3.14159 * radius ** 2");

beforeEach(() => {
	process.env.KI_CONNECT_API_KEY = "test-key";
	mockClient.chatCompletion.mockReset();
});

afterEach(() => {
	delete process.env.KI_CONNECT_API_KEY;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("isSemanticComparisonAvailable", () => {
	it("is false without KI_CONNECT_API_KEY", async () => {
		delete process.env.KI_CONNECT_API_KEY;
		const { isSemanticComparisonAvailable } = await import("$lib/server/plagiarism/semantic");
		expect(isSemanticComparisonAvailable()).toBe(false);
	});
});

describe("compareNotebooks", () => {
	it("returns null when KI_CONNECT_API_KEY is unset (graceful)", async () => {
		delete process.env.KI_CONNECT_API_KEY;

		const result = await compareNotebooks(NB_A, NB_B);

		expect(result).toBeNull();
		expect(mockClient.chatCompletion).not.toHaveBeenCalled();
	});

	it("returns null when the LLM call fails (graceful)", async () => {
		mockClient.chatCompletion.mockRejectedValue(new Error("connection refused"));

		const result = await compareNotebooks(NB_A, NB_B);

		expect(result).toBeNull();
	});

	it("parses a valid response, clamps and rounds the score", async () => {
		mockClient.chatCompletion.mockResolvedValue({
			similarity: 1.4,
			verdict: "Same approach and structure throughout.",
			same_approach: true,
		});

		const result = await compareNotebooks(NB_A, NB_B);

		expect(result).toEqual({
			studentA: "2026SS_01",
			studentB: "2026SS_02",
			semanticScore: 1,
			verdict: "Same approach and structure throughout.",
		});
		// Prompt carries both student ids and the JSON response format.
		const [system, user, temperature, format] = mockClient.chatCompletion.mock.calls[0]!;
		expect(typeof system).toBe("string");
		expect(user).toContain("2026SS_01");
		expect(user).toContain("2026SS_02");
		expect(temperature).toBe(0);
		expect(format).toEqual({ type: "json_object" });
	});

	it("rounds mid-range scores to 4 decimals", async () => {
		mockClient.chatCompletion.mockResolvedValue({ similarity: 0.456789, verdict: "" });

		const result = await compareNotebooks(NB_A, NB_B);

		expect(result!.semanticScore).toBe(0.4568);
	});

	it("returns null on a malformed response (missing similarity)", async () => {
		mockClient.chatCompletion.mockResolvedValue({ verdict: "looks fine" });

		const result = await compareNotebooks(NB_A, NB_B);

		expect(result).toBeNull();
	});
});

describe("runSemanticPass", () => {
	it("returns [] without an API key", async () => {
		delete process.env.KI_CONNECT_API_KEY;
		mockClient.chatCompletion.mockResolvedValue({ similarity: 0.5, verdict: "" });

		const results = await runSemanticPass([pair("2026SS_01", "2026SS_02")], new Map());

		expect(results).toEqual([]);
		expect(mockClient.chatCompletion).not.toHaveBeenCalled();
	});

	it("processes pairs in order, capped by maxPairs", async () => {
		mockClient.chatCompletion.mockResolvedValue({ similarity: 0.9, verdict: "same" });
		const notebooks = new Map([
			[NB_A.studentId, NB_A],
			[NB_B.studentId, NB_B],
			[NB_C.studentId, NB_C],
		]);
		const pairs = [pair("2026SS_01", "2026SS_02"), pair("2026SS_01", "2026SS_03")];

		const results = await runSemanticPass(pairs, notebooks, { maxPairs: 1 });

		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({ studentA: "2026SS_01", studentB: "2026SS_02" });
		expect(mockClient.chatCompletion).toHaveBeenCalledTimes(1);
	});

	it("skips pairs whose notebooks are missing instead of failing", async () => {
		mockClient.chatCompletion.mockResolvedValue({ similarity: 0.9, verdict: "same" });

		const results = await runSemanticPass(
			[pair("2026SS_01", "2026SS_02")],
			new Map([[NB_A.studentId, NB_A]]),
		);

		expect(results).toEqual([]);
		expect(mockClient.chatCompletion).not.toHaveBeenCalled();
	});
});

describe("mergeSemanticResults", () => {
	it("attaches scores to matching pairs and leaves the rest untouched", () => {
		const pairs = [pair("2026SS_01", "2026SS_02"), pair("2026SS_01", "2026SS_03")];

		const merged = mergeSemanticResults(pairs, [
			{
				studentA: "2026SS_01",
				studentB: "2026SS_02",
				semanticScore: 0.75,
				verdict: "similar",
			},
		]);

		expect(merged[0]!.semanticScore).toBe(0.75);
		expect(merged[0]!.semanticVerdict).toBe("similar");
		expect(merged[1]!.semanticScore).toBeUndefined();
		// Input pairs are not mutated.
		expect(pairs[0]!.semanticScore).toBeUndefined();
	});

	it("returns the input pairs unchanged when there are no results", () => {
		const pairs = [pair("2026SS_01", "2026SS_02")];

		expect(mergeSemanticResults(pairs, [])).toBe(pairs);
	});
});
