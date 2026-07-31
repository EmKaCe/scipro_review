/**
 * @file L5 API-contract tests for the /api/plagiarism routes (Phase 3d.3).
 *
 * Real temp DATA_DIR (assignments.yaml + metadata + .ipynb files on disk),
 * real Request/Response objects, the real structural engine, and a mocked
 * semantic pass. Covers: check happy path + cache write, semantic merge,
 * graceful degradation without an API key, empty assignment, 400/404
 * mapping, results read + 404, and the notebook loader's corrupt-file skip.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestEvent } from "@sveltejs/kit";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { upsertSubmission } from "$lib/server/metadata";
import { loadAssignmentNotebooks } from "$lib/server/plagiarism/structural";

import { POST as checkPOST } from "../../routes/api/plagiarism/check/+server";
import { GET as resultsGET } from "../../routes/api/plagiarism/results/+server";

// ---------------------------------------------------------------------------
// Semantic pass mock (availability + LLM calls; merging stays real)
// ---------------------------------------------------------------------------

const mockSemantic = vi.hoisted(() => ({
	isSemanticComparisonAvailable: vi.fn(),
	runSemanticPass: vi.fn(),
}));

vi.mock("$lib/server/plagiarism/semantic", async (importOriginal) => {
	const actual = await importOriginal<typeof import("$lib/server/plagiarism/semantic")>();
	return {
		...actual,
		isSemanticComparisonAvailable: mockSemantic.isSemanticComparisonAvailable,
		runSemanticPass: mockSemantic.runSemanticPass,
	};
});

// ---------------------------------------------------------------------------
// Fixtures & helpers
// ---------------------------------------------------------------------------

const ASSIGNMENTS_YAML = `assignments:
  - id: soil_contamination
    title: Soil Contamination by Factories
    enabled: true
    criteria_files: []
    dimensions: []
  - id: molecular_dynamics
    title: Molecular Dynamics
    enabled: false
    criteria_files: []
    dimensions: []
`;

const SHARED_CELL = [
	'import numpy as np',
	'data = np.loadtxt("data.csv")',
	'mean = data.mean()',
	'print(mean)',
].join("\n");

const UNRELATED_CELL = "import math\nradius = 5\narea = math.pi * radius ** 2\nprint(area)";
const OTHER_CELL = "x = alpha + beta * gamma\nprint(x)";

const ASSIGNMENT = "soil_contamination";

function notebookJson(cells: Array<{ cell_type: string; source: string[] }>): string {
	return JSON.stringify({ cells, metadata: {}, nbformat: 4, nbformat_minor: 5 });
}

const notebookPath = (studentId: string) =>
	path.join("submissions", ASSIGNMENT, `${studentId}.ipynb`);

async function seedSubmission(studentId: string, cells: string[]): Promise<void> {
	await upsertSubmission(ASSIGNMENT, studentId, { notebookPath: notebookPath(studentId) });
	await writeFile(
		path.join(dataDir, notebookPath(studentId)),
		notebookJson(cells.map((source) => ({ cell_type: "code", source: source.split("\n") }))),
		"utf-8",
	);
}

function jsonRequest(body: unknown): Request {
	return new Request("http://localhost/api/plagiarism/check", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

function getRequest(url: string): Request {
	return new Request(url, { method: "GET" });
}

function asEvent(request: Request): RequestEvent {
	return { request, url: new URL(request.url) } as unknown as RequestEvent;
}

let dataDir: string;

beforeEach(async () => {
	dataDir = await mkdtemp(path.join(os.tmpdir(), "scipro-plagiarism-"));
	process.env.DATA_DIR = dataDir;
	await writeFile(path.join(dataDir, "assignments.yaml"), ASSIGNMENTS_YAML, "utf-8");

	mockSemantic.isSemanticComparisonAvailable.mockReset().mockReturnValue(false);
	mockSemantic.runSemanticPass.mockReset().mockResolvedValue([]);
});

afterEach(async () => {
	delete process.env.DATA_DIR;
	delete process.env.KI_CONNECT_API_KEY;
	await rm(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// POST /api/plagiarism/check
// ---------------------------------------------------------------------------

describe("POST /api/plagiarism/check", () => {
	it("runs the structural check, returns flagged pairs and writes the cache", async () => {
		await seedSubmission("2026SS_01", [SHARED_CELL, UNRELATED_CELL]);
		await seedSubmission("2026SS_02", [SHARED_CELL, UNRELATED_CELL]);
		await seedSubmission("2026SS_03", [OTHER_CELL]);

		const response = await checkPOST(asEvent(jsonRequest({ assignmentId: ASSIGNMENT })));

		expect(response.status).toBe(200);
		const result = (await response.json()) as {
			status: string;
			assignmentId: string;
			totalPairs: number;
			comparedSubmissions: string[];
			pairs: Array<{ studentA: string; studentB: string; cellOverlap: number }>;
		};
		expect(result.status).toBe("done");
		expect(result.assignmentId).toBe(ASSIGNMENT);
		expect(result.totalPairs).toBe(3);
		expect(result.comparedSubmissions).toEqual(["2026SS_01", "2026SS_02", "2026SS_03"]);
		expect(result.pairs).toHaveLength(1);
		expect(result.pairs[0]).toMatchObject({
			studentA: "2026SS_01",
			studentB: "2026SS_02",
			cellOverlap: 1,
			notebookOverlap: 1,
		});
		expect(mockSemantic.runSemanticPass).not.toHaveBeenCalled();

		// Cache file written and identical to the response.
		const cached = JSON.parse(
			await readFile(path.join(dataDir, "plagiarism", `${ASSIGNMENT}.json`), "utf-8"),
		) as typeof result;
		expect(cached).toEqual(result);
	});

	it("merges semantic scores when semantic: true and the LLM is available", async () => {
		await seedSubmission("2026SS_01", [SHARED_CELL]);
		await seedSubmission("2026SS_02", [SHARED_CELL]);
		mockSemantic.isSemanticComparisonAvailable.mockReturnValue(true);
		mockSemantic.runSemanticPass.mockResolvedValue([
			{ studentA: "2026SS_01", studentB: "2026SS_02", semanticScore: 0.9, verdict: "same" },
		]);

		const response = await checkPOST(
			asEvent(jsonRequest({ assignmentId: ASSIGNMENT, semantic: true })),
		);

		const result = (await response.json()) as {
			semanticChecked: boolean;
			pairs: Array<{ semanticScore?: number; semanticVerdict?: string }>;
		};
		expect(result.semanticChecked).toBe(true);
		expect(result.pairs[0]!.semanticScore).toBe(0.9);
		expect(result.pairs[0]!.semanticVerdict).toBe("same");
		expect(mockSemantic.runSemanticPass).toHaveBeenCalledTimes(1);
		expect(mockSemantic.runSemanticPass).toHaveBeenCalledWith(
			expect.any(Array),
			expect.any(Map),
		);
	});

	it("degrades gracefully when semantic: true but no API key is configured", async () => {
		await seedSubmission("2026SS_01", [SHARED_CELL]);
		await seedSubmission("2026SS_02", [SHARED_CELL]);
		mockSemantic.isSemanticComparisonAvailable.mockReturnValue(false);

		const response = await checkPOST(
			asEvent(jsonRequest({ assignmentId: ASSIGNMENT, semantic: true })),
		);

		const result = (await response.json()) as {
			semanticChecked: boolean;
			pairs: Array<{ semanticScore?: number }>;
		};
		expect(result.semanticChecked).toBe(false);
		expect(result.pairs[0]!.semanticScore).toBeUndefined();
		expect(mockSemantic.runSemanticPass).not.toHaveBeenCalled();
	});

	it("returns done with no pairs for an empty assignment", async () => {
		const response = await checkPOST(asEvent(jsonRequest({ assignmentId: ASSIGNMENT })));

		const result = (await response.json()) as { status: string; pairs: unknown[]; totalPairs: number };
		expect(result.status).toBe("done");
		expect(result.pairs).toEqual([]);
		expect(result.totalPairs).toBe(0);

		const cached = JSON.parse(
			await readFile(path.join(dataDir, "plagiarism", `${ASSIGNMENT}.json`), "utf-8"),
		) as { pairs: unknown[] };
		expect(cached.pairs).toEqual([]);
	});

	it("accepts an explicit ngramSize", async () => {
		await seedSubmission("2026SS_01", [SHARED_CELL]);
		await seedSubmission("2026SS_02", [SHARED_CELL]);

		const response = await checkPOST(
			asEvent(jsonRequest({ assignmentId: ASSIGNMENT, ngramSize: 5 })),
		);

		expect(response.status).toBe(200);
	});

	it("returns 404 for an unknown assignment", async () => {
		await expect(
			checkPOST(asEvent(jsonRequest({ assignmentId: "nope" }))),
		).rejects.toMatchObject({ status: 404 });
	});

	it("returns 400 for a non-JSON body and an invalid ngramSize", async () => {
		const badBody = new Request("http://localhost/api/plagiarism/check", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "not json",
		});
		await expect(checkPOST(asEvent(badBody))).rejects.toMatchObject({ status: 400 });

		await expect(
			checkPOST(asEvent(jsonRequest({ assignmentId: ASSIGNMENT, ngramSize: 9 }))),
		).rejects.toMatchObject({ status: 400 });
	});
});

// ---------------------------------------------------------------------------
// GET /api/plagiarism/results
// ---------------------------------------------------------------------------

describe("GET /api/plagiarism/results", () => {
	it("returns the cached result for the default assignment after a check", async () => {
		await seedSubmission("2026SS_01", [SHARED_CELL]);
		await seedSubmission("2026SS_02", [SHARED_CELL]);
		await checkPOST(asEvent(jsonRequest({ assignmentId: ASSIGNMENT })));

		const response = await resultsGET(asEvent(getRequest("http://localhost/api/plagiarism/results")));

		expect(response.status).toBe(200);
		const result = (await response.json()) as {
			assignmentId: string;
			pairs: Array<{ studentA: string }>;
		};
		expect(result.assignmentId).toBe(ASSIGNMENT);
		expect(result.pairs[0]!.studentA).toBe("2026SS_01");
	});

	it("returns the cached result for an explicit assignmentId", async () => {
		await seedSubmission("2026SS_01", [SHARED_CELL]);
		await seedSubmission("2026SS_02", [SHARED_CELL]);
		await checkPOST(asEvent(jsonRequest({ assignmentId: ASSIGNMENT })));

		const response = await resultsGET(
			asEvent(getRequest(`http://localhost/api/plagiarism/results?assignmentId=${ASSIGNMENT}`)),
		);

		expect(response.status).toBe(200);
	});

	it("returns 404 when no check has been run", async () => {
		await expect(
			resultsGET(asEvent(getRequest("http://localhost/api/plagiarism/results"))),
		).rejects.toMatchObject({ status: 404 });
	});

	it("returns 404 for an unknown assignment", async () => {
		await expect(
			resultsGET(asEvent(getRequest("http://localhost/api/plagiarism/results?assignmentId=nope"))),
		).rejects.toMatchObject({ status: 404 });
	});
});

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

describe("loadAssignmentNotebooks", () => {
	it("skips unreadable/corrupt notebooks and keeps the valid ones", async () => {
		await seedSubmission("2026SS_01", [SHARED_CELL]);
		await upsertSubmission(ASSIGNMENT, "2026SS_02", { notebookPath: notebookPath("2026SS_02") });
		await writeFile(path.join(dataDir, notebookPath("2026SS_02")), "not json", "utf-8");
		await mkdir(path.join(dataDir, "submissions", ASSIGNMENT), { recursive: true });

		const notebooks = await loadAssignmentNotebooks(ASSIGNMENT);

		expect(notebooks).toHaveLength(1);
		expect(notebooks[0]!.studentId).toBe("2026SS_01");
		// The fixture seeds ONE cell whose source spans 4 lines.
		expect(notebooks[0]!.cells).toHaveLength(1);
		expect(notebooks[0]!.cells[0]!.source).toContain("import numpy as np");
	});
});
