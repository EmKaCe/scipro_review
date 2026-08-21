/**
 * @file Unit tests for the copilot reference + ops-read tools
 * (reference-tools.ts).
 *
 * Each test registers the four tools into a fresh createRegistry() (never the
 * agent singleton) and points DATA_DIR at a temp dir containing the fixtures:
 * a tiny key notebook under materials/, a plagiarism cache file, in-memory
 * process-progress state via the module's exported setters, and executor logs
 * via a mocked $lib/server/executor-client.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createRegistry, type ToolContext } from "$lib/server/copilot/registry";
import { registerReferenceTools } from "$lib/server/copilot/tools/reference-tools";
import {
	beginProcessRun,
	endProcessRun,
	resetProcessRun,
	updateProcessRun,
} from "$lib/server/process-progress";
import { writePlagiarismResult, type PlagiarismResult } from "$lib/server/plagiarism/cache";

// ---------------------------------------------------------------------------
// Executor-client mock (the only networked dependency of the tools)
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
	fetchLogs: vi.fn(),
	getExecutorClient: vi.fn(),
}));

vi.mock("$lib/server/executor-client", () => ({
	getExecutorClient: mocks.getExecutorClient,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let dataDir: string;
let registry: ReturnType<typeof createRegistry>;

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
	return { signal: new AbortController().signal, ...overrides };
}

/** Minimal valid Jupyter notebook JSON with the given cells. */
function notebookJson(cells: unknown[]): string {
	return JSON.stringify({
		cells,
		metadata: {
			kernelspec: { display_name: "Python 3", language: "python", name: "python3" },
			language_info: { name: "python" },
		},
		nbformat: 4,
		nbformat_minor: 5,
	});
}

/** Write a key.ipynb fixture under materials/<assignmentId>/. */
async function writeKeyNotebook(assignmentId: string, cells: unknown[]): Promise<void> {
	const dir = path.join(dataDir, "materials", assignmentId);
	await mkdir(dir, { recursive: true });
	await writeFile(path.join(dir, "key.ipynb"), notebookJson(cells), "utf-8");
}

function mdCell(source: string[]): unknown {
	return { cell_type: "markdown", metadata: {}, source };
}

function codeCell(source: string[]): unknown {
	return {
		cell_type: "code",
		execution_count: null,
		metadata: {},
		outputs: [],
		source,
	};
}

function keyCells(): unknown[] {
	return [
		mdCell(["# Assignment Key\n", "Intended solution for the soil contamination task."]),
		codeCell(["import pandas as pd\n", "df = pd.read_csv('data.csv')\n", "print(df.head())\n"]),
		codeCell(Array.from({ length: 50 }, (_, i) => `line ${i + 1}\n`)),
	];
}

/** Write a plagiarism cache fixture matching the real file layout. */
async function writePlagiarismFixture(assignmentId: string): Promise<void> {
	const result: PlagiarismResult = {
		status: "done",
		assignmentId,
		generatedAt: "2026-08-08T12:00:00.000Z",
		pairs: [
			{
				studentA: "2026SS_01",
				studentB: "2026SS_02",
				cellOverlap: 0.7,
				notebookOverlap: 0.55,
				matchedCells: [{ cellIndexA: 0, cellIndexB: 1, similarity: 0.9 }],
				flags: ["shared_imports"],
				details: {
					cellCountDiff: 0,
					sharedVariableNames: [],
					sharedComments: [],
					sharedImports: ["pandas"],
				},
			},
			{
				studentA: "2026SS_03",
				studentB: "2026SS_04",
				cellOverlap: 0.2,
				notebookOverlap: 0.1,
				matchedCells: [],
				flags: [],
				details: {
					cellCountDiff: 1,
					sharedVariableNames: [],
					sharedComments: [],
					sharedImports: [],
				},
				reviewStatus: "dismissed",
			},
		],
		totalPairs: 6,
		comparedSubmissions: ["2026SS_01", "2026SS_02", "2026SS_03", "2026SS_04"],
		semanticChecked: true,
	};
	await writePlagiarismResult(assignmentId, result);
}

beforeEach(async () => {
	dataDir = await mkdtemp(path.join(os.tmpdir(), "scipro-ref-tools-"));
	process.env.DATA_DIR = dataDir;
	registry = createRegistry();
	registerReferenceTools(registry);
	resetProcessRun();
	mocks.fetchLogs.mockReset();
	mocks.getExecutorClient.mockReset();
	mocks.getExecutorClient.mockReturnValue({ fetchLogs: mocks.fetchLogs });
});

afterEach(async () => {
	await rm(dataDir, { recursive: true, force: true });
	delete process.env.DATA_DIR;
	resetProcessRun();
	vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("registerReferenceTools", () => {
	it("registers the four tools with permission auto and kebab-case names", () => {
		const names = registry
			.list()
			.map((tool) => tool.name)
			.sort();
		expect(names).toEqual([
			"get-executor-logs",
			"get-pipeline-status",
			"get-plagiarism-report",
			"get-reference-key",
		]);
		for (const tool of registry.list()) {
			expect(tool.permission).toBe("auto");
			expect(tool.destructive).toBeUndefined();
		}
	});
});

describe("get-reference-key", () => {
	it("returns bounded per-cell summaries (preview, type, markdown text)", async () => {
		await writeKeyNotebook("soil", keyCells());

		const result = (await registry.run(
			"get-reference-key",
			{ assignmentId: "soil" },
			makeContext(),
		)) as Record<string, unknown>;

		expect(result["found"]).toBe(true);
		expect(result["assignmentId"]).toBe("soil");
		expect(result["note"]).toBeUndefined();
		expect(result["cellCount"]).toBe(3);

		const cells = result["cells"] as Array<Record<string, unknown>>;
		expect(cells).toHaveLength(3);
		expect(cells[0]).toMatchObject({
			index: 0,
			cell_type: "markdown",
			sourceTruncated: false,
		});
		expect(cells[0]!["sourcePreview"]).toContain("# Assignment Key");
		expect(cells[0]!["text"]).toContain("Intended solution");

		expect(cells[1]).toMatchObject({
			index: 1,
			cell_type: "code",
			sourceTruncated: false,
		});
		expect(cells[1]!["sourcePreview"]).toContain("import pandas as pd");
		// text is only attached to markdown cells
		expect(cells[1]!["text"]).toBeUndefined();
	});

	it("truncates long cell sources to ~40 lines with a marker and never returns the raw file", async () => {
		await writeKeyNotebook("soil", keyCells());

		const result = (await registry.run(
			"get-reference-key",
			{ assignmentId: "soil" },
			makeContext(),
		)) as { cells: Array<Record<string, unknown>> };

		const longCell = result.cells[2]!;
		expect(longCell["sourceTruncated"]).toBe(true);
		const preview = longCell["sourcePreview"] as string;
		expect(preview).toContain("line 40");
		expect(preview).toContain("… (truncated)");
		expect(preview).not.toContain("line 41");
		expect(preview).not.toContain("line 50");
		// bounded: preview lines + the marker line
		expect(preview.split("\n").length).toBeLessThanOrEqual(41);
	});

	it("returns a top-level note with an empty structure when the key is missing", async () => {
		const result = (await registry.run(
			"get-reference-key",
			{ assignmentId: "soil" },
			makeContext(),
		)) as Record<string, unknown>;

		expect(result["found"]).toBe(false);
		expect(result["note"]).toContain("not found");
		expect(result["cellCount"]).toBe(0);
		expect(result["cells"]).toEqual([]);
	});
});

describe("get-plagiarism-report", () => {
	it("returns per-pair summaries with derived severity + review status and unreviewedCount", async () => {
		await writePlagiarismFixture("soil");

		const result = (await registry.run(
			"get-plagiarism-report",
			{ assignmentId: "soil" },
			makeContext(),
		)) as Record<string, unknown>;

		expect(result["found"]).toBe(true);
		expect(result["status"]).toBe("done");
		expect(result["generatedAt"]).toBe("2026-08-08T12:00:00.000Z");
		expect(result["totalPairs"]).toBe(6);
		expect(result["comparedSubmissions"]).toEqual([
			"2026SS_01",
			"2026SS_02",
			"2026SS_03",
			"2026SS_04",
		]);
		expect(result["semanticChecked"]).toBe(true);

		const pairs = result["pairs"] as Array<Record<string, unknown>>;
		expect(pairs).toHaveLength(2);
		// pair 1: cellOverlap 0.7 >= 0.6 → high; no reviewStatus → unreviewed
		expect(pairs[0]).toEqual({
			studentA: "2026SS_01",
			studentB: "2026SS_02",
			severity: "high",
			cellOverlap: 0.7,
			notebookOverlap: 0.55,
			reviewStatus: "unreviewed",
		});
		// pair 2: cellOverlap 0.2 (>= 0.15, below flag) → low; dismissed
		expect(pairs[1]).toMatchObject({
			studentA: "2026SS_03",
			studentB: "2026SS_04",
			severity: "low",
			notebookOverlap: 0.1,
			reviewStatus: "dismissed",
		});
		expect(result["unreviewedCount"]).toBe(1);
	});

	it("returns a note + empty pairs when no check has been run", async () => {
		const result = (await registry.run(
			"get-plagiarism-report",
			{ assignmentId: "soil" },
			makeContext(),
		)) as Record<string, unknown>;

		expect(result["found"]).toBe(false);
		expect(result["note"]).toContain("No plagiarism results cached");
		expect(result["pairs"]).toEqual([]);
		expect(result["unreviewedCount"]).toBe(0);
	});
});

describe("get-pipeline-status", () => {
	it("returns the idle shape when no batch is running", async () => {
		const result = (await registry.run("get-pipeline-status", {}, makeContext())) as Record<
			string,
			unknown
		>;

		expect(result).toEqual({
			running: false,
			assignmentId: null,
			done: 0,
			total: 0,
			currentNotebook: null,
			currentElapsedMs: null,
			totalElapsedMs: null,
			autoFixCounts: null,
		});
	});

	it("reports running state with done/total, current notebook, elapsed and autofix counts", async () => {
		beginProcessRun("soil", 3);
		updateProcessRun({
			done: 1,
			currentStudentId: "2026SS_01",
			startedAt: Date.now() - 120_000,
			currentStartedAt: Date.now() - 5_000,
			autofixAttempts: 2,
			autofixSucceeded: 1,
		});

		const result = (await registry.run("get-pipeline-status", {}, makeContext())) as Record<
			string,
			unknown
		>;

		expect(result["running"]).toBe(true);
		expect(result["assignmentId"]).toBe("soil");
		expect(result["done"]).toBe(1);
		expect(result["total"]).toBe(3);
		expect(result["currentNotebook"]).toBe("2026SS_01");
		expect(result["currentElapsedMs"] as number).toBeGreaterThan(4_000);
		expect(result["currentElapsedMs"] as number).toBeLessThan(20_000);
		expect(result["totalElapsedMs"] as number).toBeGreaterThan(110_000);
		expect(result["autoFixCounts"]).toEqual({ attempts: 2, succeeded: 1 });
	});

	it("keeps final tallies after the run ends but clears current state", async () => {
		beginProcessRun("soil", 3);
		updateProcessRun({ done: 3, autofixAttempts: 4, autofixSucceeded: 3 });
		endProcessRun();

		const result = (await registry.run("get-pipeline-status", {}, makeContext())) as Record<
			string,
			unknown
		>;

		expect(result["running"]).toBe(false);
		expect(result["done"]).toBe(3);
		expect(result["total"]).toBe(3);
		expect(result["currentNotebook"]).toBeNull();
		expect(result["currentElapsedMs"]).toBeNull();
		expect(result["autoFixCounts"]).toEqual({ attempts: 4, succeeded: 3 });
	});
});

describe("get-executor-logs", () => {
	it("clamps a requested limit of 5000 down to 1000", async () => {
		mocks.fetchLogs.mockResolvedValue({
			entries: [{ id: 1, ts: 123, level: "info", logger: "runner", message: "hello" }],
			truncated: false,
		});

		const result = (await registry.run(
			"get-executor-logs",
			{ limit: 5000 },
			makeContext(),
		)) as Record<string, unknown>;

		expect(mocks.fetchLogs).toHaveBeenCalledWith(1000);
		expect(result["entries"]).toHaveLength(1);
		expect(result["truncated"]).toBe(false);
		expect(result["limit"]).toBe(1000);
	});

	it("defaults to 200 when no limit is given", async () => {
		mocks.fetchLogs.mockResolvedValue({ entries: [], truncated: false });

		await registry.run("get-executor-logs", {}, makeContext());

		expect(mocks.fetchLogs).toHaveBeenCalledWith(200);
	});
});
