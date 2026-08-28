// @vitest-environment node
/**
 * @file API-contract tests for POST /api/assignments/[id]/criteria/draft —
 * the TURN-BASED criteria draft pipeline (Task D4).
 *
 * Real temp DATA_DIR (mkdtemp) with a seeded assignments.yaml (an
 * assignment with its own rubric, one with only the shared general.yaml),
 * the real committed criteria + grading_config files copied into the temp
 * dir, direct handler import and minimal RequestEvent stubs — mirroring
 * scoring-draft-api.test.ts. The KI Connect client is mocked at the module
 * level; chatCompletion responses are scripted PER CALL (the pipeline makes
 * multiple calls: Phase 1 skeleton + one Phase 2 call per category + Phase 4
 * consistency), ordered with mockResolvedValueOnce queues.
 *
 * Covered scenarios:
 * - grounding assembled from PDF / key notebook / input data / shared
 *   criteria / dimension contract when NO own rubric exists (the
 *   chicken-and-egg "upload criteria first" 400 is GONE)
 * - existing own rubric → still drafts, includes the rubric summary
 * - per-category turns merged deterministically in skeleton order
 * - consistency pass surfaces coverage notes and applies revisions
 * - validation-gate retry (invalid draft first, valid on retry)
 * - max 3 attempts → 400 with the validation message
 * - general-collision gate still enforced
 * - 404 unknown assignment without calling the LLM
 * - no-write guarantee (full DATA_DIR tree snapshot)
 * - draft round-trips through the criteria loader
 */

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Repo root — resolves portably so CI (runner user, arbitrary checkout dir) can read committed data. */
const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
	"..",
);

import type { RequestEvent } from "@sveltejs/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as yaml from "js-yaml";

import { loadCriteriaFile } from "$lib/server/criteria";

const kiConnectMock = vi.hoisted(() => ({
	chatCompletion: vi.fn(),
}));

vi.mock("$lib/server/ki-connect", () => ({
	getKiConnectClient: () => ({ chatCompletion: kiConnectMock.chatCompletion }),
}));

// pdf-parse v2 exports a PDFParse class; mock it so the assignment-PDF
// grounding leg of the pipeline resolves through pdfParseMock (mirrors the
// pre-evaluation test mock).
const pdfParseMock = vi.hoisted(() => vi.fn());

vi.mock("pdf-parse", () => ({
	PDFParse: class {
		constructor(opts: { data: Uint8Array }) {
			this.opts = opts;
		}
		opts: { data: Uint8Array };
		async getText(): Promise<{ text: string }> {
			return pdfParseMock();
		}
	},
}));

import { POST as postDraft } from "../../routes/api/assignments/[id]/criteria/draft/+server";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ASSIGNMENTS_YAML = `assignments:
  - id: soil_contamination
    title: Soil Contamination by Factories
    enabled: true
    criteria_files:
      - data/criteria/general.yaml
      - data/criteria/soil_contamination.yaml
    dimensions:
      - code_quality_design
      - scientific_programming
  - id: atom_interaction
    title: Atom Interaction
    enabled: true
    criteria_files:
      - data/criteria/general.yaml
      - data/criteria/atom_interaction.yaml
    dimensions:
      - code_quality_design
      - code_execution_results
  - id: no_rubric
    title: No Own Rubric
    enabled: true
    criteria_files:
      - data/criteria/general.yaml
    dimensions: []
`;

/** The committed soil own-rubric criteria file (grounding rubric). */
const SOIL_CRITERIA_SOURCE = path.join(REPO_ROOT, "data/criteria/soil_contamination.yaml");
const ATOM_CRITERIA_SOURCE = path.join(REPO_ROOT, "data/criteria/atom_interaction.yaml");
const GENERAL_CRITERIA_SOURCE = path.join(REPO_ROOT, "data/criteria/general.yaml");
const GENERAL_FEEDBACK_SOURCE = path.join(REPO_ROOT, "data/criteria/general_feedback.yaml");
const FOLLOWING_INSTRUCTIONS_SOURCE = path.join(
	REPO_ROOT,
	"data/criteria/following_instructions.yaml",
);
const GRADING_CONFIG_SOURCE = path.join(REPO_ROOT, "data/grading_config.yaml");

// --- LLM response fixtures (scripted per call, in order) ---

/** Phase 1 skeleton with ONE category. */
const SKELETON_1: Record<string, unknown> = {
	categories: [
		{ key: "pandas", title: "Pandas", rationale: "Checks DataFrame loading and manipulation." },
	],
};

/** Phase 1 skeleton with TWO categories (merge-order test). */
const SKELETON_2: Record<string, unknown> = {
	categories: [
		{ key: "pandas", title: "Pandas", rationale: "DataFrame handling." },
		{ key: "numpy", title: "NumPy", rationale: "Vectorized numerics." },
	],
};

/** Phase 2 result for the "pandas" category (wrapped shape). */
const CATEGORY_PANDAS: Record<string, unknown> = {
	pandas: {
		title: "Pandas",
		additional_notes: true,
		positive: [
			{
				main_point: "The following points were well done",
				dimensions: ["code_quality_design"],
				sub_points: [{ text: "Functions: good use of Pandas functions.", comment: true }],
			},
		],
		neutral: [],
		negative: [
			{
				main_point: "Data Loading",
				dimensions: ["scientific_programming"],
				sub_points: [{ text: "Delimiter: separators correct in read_csv." }],
			},
		],
	},
};

/** Phase 2 result for the "numpy" category (wrapped shape). */
const CATEGORY_NUMPY: Record<string, unknown> = {
	numpy: {
		title: "NumPy",
		additional_notes: false,
		positive: [
			{
				main_point: "Vectorization",
				dimensions: ["scientific_programming"],
				sub_points: [{ text: "Numpy: vectorized operations used." }],
			},
		],
		neutral: [],
		negative: [],
	},
};

/** Phase 4 no-op result. */
const CONSISTENCY_EMPTY: Record<string, unknown> = { notes: [], revisions: [] };

/** Phase 4 result flagging a coverage gap + one well-formed rephrase revision. */
const CONSISTENCY_WITH_NOTE: Record<string, unknown> = {
	notes: [
		"No sub-point maps to the creativity dimension — flagging for the teacher: creativity may score low/default.",
	],
	revisions: [
		{
			category: "pandas",
			main_point: "The following points were well done",
			sub_point: "Functions: good use of Pandas functions.",
			action: "rephrase",
			text: "Functions: good use of Pandas functions including `to_numpy()`.",
		},
	],
};

/** Phase 2 result that FAILS the validation gate (missing title). */
const BAD_CATEGORY: Record<string, unknown> = {
	additional_notes: true,
	positive: [],
	neutral: [],
	negative: [],
};

/** Phase 2 result that collides with a general.yaml category key (BARE
 * category object — valid enough to pass the schema gate so the
 * collision gate is the one that fires). */
const BARE_VALID_CATEGORY: Record<string, unknown> = {
	title: "Would collide with general.yaml",
	additional_notes: true,
	positive: [
		{
			main_point: "Good",
			dimensions: ["code_quality_design"],
			sub_points: [{ text: "Functions: good use of Pandas functions." }],
		},
	],
	neutral: [],
	negative: [],
};

/** Phase 1 skeleton whose key collides with a general.yaml category. */
const SKELETON_COLLISION: Record<string, unknown> = {
	categories: [
		{ key: "code_formatting", title: "Code Formatting", rationale: "Collision probe." },
	],
};

let dataDir: string;

beforeEach(async () => {
	dataDir = await mkdtemp(path.join(os.tmpdir(), "scipro-criteria-draft-"));
	vi.stubEnv("DATA_DIR", dataDir);
	// Pin the draft model: the resolver honors PHASE_2_MODEL before the
	// settings-UI model (fixture settings.yaml carries qwen3-30b).
	vi.stubEnv("PHASE_2_MODEL", "openai-gpt-oss-120b");
	await writeFile(path.join(dataDir, "assignments.yaml"), ASSIGNMENTS_YAML);

	await mkdir(path.join(dataDir, "criteria"), { recursive: true });
	await writeFile(
		path.join(dataDir, "criteria", "soil_contamination.yaml"),
		await readFile(SOIL_CRITERIA_SOURCE, "utf-8"),
	);
	await writeFile(
		path.join(dataDir, "criteria", "atom_interaction.yaml"),
		await readFile(ATOM_CRITERIA_SOURCE, "utf-8"),
	);
	// The shared criteria files (summarized in the grounding + collision gate).
	await writeFile(
		path.join(dataDir, "criteria", "general.yaml"),
		await readFile(GENERAL_CRITERIA_SOURCE, "utf-8"),
	);
	await writeFile(
		path.join(dataDir, "criteria", "general_feedback.yaml"),
		await readFile(GENERAL_FEEDBACK_SOURCE, "utf-8"),
	);
	await writeFile(
		path.join(dataDir, "criteria", "following_instructions.yaml"),
		await readFile(FOLLOWING_INSTRUCTIONS_SOURCE, "utf-8"),
	);
	// The FIXED dimension contract (key + title + max_points).
	await writeFile(
		path.join(dataDir, "grading_config.yaml"),
		await readFile(GRADING_CONFIG_SOURCE, "utf-8"),
	);

	kiConnectMock.chatCompletion.mockReset();
	// Default: a valid full criteria document — makes the plain happy path
	// work (Phase 1 tolerates the { categories: {...} } wrapper). Tests that
	// need specific per-phase responses queue mockResolvedValueOnce entries.
	kiConnectMock.chatCompletion.mockResolvedValue({
		categories: { ...CATEGORY_PANDAS },
	});
	pdfParseMock.mockReset();
	pdfParseMock.mockResolvedValue({ text: "MOCK PDF TEXT" });
});

afterEach(async () => {
	vi.unstubAllEnvs();
	await rm(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal RequestEvent stub for the POST handler. */
function postEvent(id: string): RequestEvent {
	return { params: { id } } as unknown as RequestEvent;
}

/** Assert a handler rejects with a SvelteKit HttpError (status + body.message). */
async function expectApiError(
	promise: Promise<unknown>,
	status: number,
	messagePart?: string,
): Promise<void> {
	try {
		await promise;
	} catch (err) {
		const e = err as { status?: number; body?: { message?: string } };
		expect(e.status).toBe(status);
		if (messagePart !== undefined) {
			expect(e.body?.message).toContain(messagePart);
		}
		return;
	}
	expect.unreachable(`expected handler to fail with ${status}`);
}

/** Read the persisted assignments.yaml registry. */
async function readRegistry(): Promise<{
	assignments: Array<{ id: string; criteria_files: string[] }>;
}> {
	return yaml.load(await readFile(path.join(dataDir, "assignments.yaml"), "utf-8")) as {
		assignments: Array<{ id: string; criteria_files: string[] }>;
	};
}

/** Recursive snapshot of a directory tree (relative path -> file content). */
async function snapshotTree(root: string): Promise<Record<string, string>> {
	const out: Record<string, string> = {};
	async function walk(dir: string, rel: string): Promise<void> {
		const entries = await readdir(dir, { withFileTypes: true });
		for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			const r = rel ? `${rel}/${e.name}` : e.name;
			if (e.isDirectory()) {
				await walk(path.join(dir, e.name), r);
			} else {
				out[r] = await readFile(path.join(dir, e.name), "utf-8");
			}
		}
	}
	await walk(root, "");
	return out;
}

/** Script the per-call chatCompletion queue (consumed in order). */
function queueChat(...responses: Record<string, unknown>[]): void {
	for (const response of responses) {
		kiConnectMock.chatCompletion.mockResolvedValueOnce(response);
	}
}

// ---------------------------------------------------------------------------
// POST /api/assignments/[id]/criteria/draft
// ---------------------------------------------------------------------------

describe("POST /api/assignments/[id]/criteria/draft (turn-based pipeline)", () => {
	it("grounds the draft from PDF + key notebook + input data + shared criteria when no own rubric exists (chicken-and-egg fixed)", async () => {
		// Seed the full assignment material context for the no_rubric
		// assignment: assignment PDF (mocked pdf-parse), reference key
		// notebook, and an input_data directory.
		const materials = path.join(dataDir, "materials", "no_rubric");
		await mkdir(path.join(materials, "input_data"), { recursive: true });
		await writeFile(path.join(materials, "input_data", "data_2026.csv"), "a,b\n1,2\n");
		await writeFile(path.join(materials, "input_data", "sites.csv"), "s\nx\n");
		await writeFile(
			path.join(materials, "key.ipynb"),
			JSON.stringify({
				cells: [
					{ cell_type: "markdown", source: ["KEY NOTEBOOK: load and clean the data"] },
					{ cell_type: "code", source: ["KEY_MARKER_PLOT = df.plot()"] },
				],
			}),
		);
		await writeFile(path.join(materials, "assignment.pdf"), "fake pdf bytes");
		pdfParseMock.mockResolvedValue({
			text: "SOIL CONTAMINATION TASK SHEET\nLoad the CSV, fit the model, report R2.",
		});

		queueChat(SKELETON_1, CATEGORY_PANDAS, CONSISTENCY_EMPTY);

		const res = await postDraft(postEvent("no_rubric"));
		expect(res.status).toBe(200);

		const body = (await res.json()) as {
			draft: { categories: Record<string, unknown> };
			notes: string[];
		};
		expect(body.draft.categories.pandas).toBeDefined();

		// Contract: 3 turns — Phase 1 skeleton, Phase 2 (one category),
		// Phase 4 consistency. Temp 0.2, json_object, 60s, PHASE_2_MODEL.
		expect(kiConnectMock.chatCompletion).toHaveBeenCalledTimes(3);
		expect(kiConnectMock.chatCompletion).toHaveBeenNthCalledWith(
			1,
			expect.any(String),
			expect.any(String),
			0.2,
			{ type: "json_object" },
			undefined,
			60_000,
			"openai-gpt-oss-120b",
		);

		// The system prompt carries the dimension-attribution contract + the
		// quantifiable-criteria rules (rules 1-8, including the ADDED
		// dimension rules).
		const [system, user] = kiConnectMock.chatCompletion.mock.calls[0] as [string, string];
		expect(system).toContain("dimension-attributed rubric");
		expect(system).toContain("code_quality_design");
		expect(system).toContain("OBSERVABLE notebook evidence");
		expect(system).toContain("DIMENSION ATTRIBUTION (mandatory)");
		expect(system).not.toContain("PREVIOUS DRAFT REJECTED");

		// The Phase 1 user prompt carries the full grounding: assignment
		// metadata, PDF text, key summary, input-data files, shared criteria
		// summaries, and the FIXED dimension contract.
		expect(user).toContain("no_rubric");
		expect(user).toContain("SOIL CONTAMINATION TASK SHEET");
		expect(user).toContain("key.ipynb");
		expect(user).toContain("KEY NOTEBOOK: load and clean the data");
		expect(user).toContain("data_2026.csv");
		expect(user).toContain("sites.csv");
		// Shared criteria summaries (what already applies, must not duplicate).
		expect(user).toContain("data/criteria/general_feedback.yaml");
		expect(user).toContain("data/criteria/following_instructions.yaml");
		expect(user).toContain("code_formatting");
		// The FIXED dimension contract (key: title (max N points)).
		expect(user).toContain("code_quality_design: Code Quality & Design (max 6 points)");
		expect(user).toContain("creativity: Creativity (max 4 points)");
		// Skeleton constraints.
		expect(user).toContain("5-9");
	});

	it("still drafts with an existing own rubric, including its summary as grounding", async () => {
		queueChat(SKELETON_1, CATEGORY_PANDAS, CONSISTENCY_EMPTY);

		const res = await postDraft(postEvent("soil_contamination"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { draft: { categories: Record<string, unknown> } };
		expect(body.draft.categories.pandas).toBeDefined();

		const [, user] = kiConnectMock.chatCompletion.mock.calls[0] as [string, string];
		// Own-rubric summary (a distinctive soil sub-point) + shared criteria.
		expect(user).toContain("soil_contamination.yaml");
		expect(user).toContain(
			"Functions: good use of `to_numpy()` when passing coordinates to `curve_fit`.",
		);
		expect(user).toContain("code_formatting");
		expect(kiConnectMock.chatCompletion).toHaveBeenCalledTimes(3);
	});

	it("merges per-category turns deterministically in skeleton order", async () => {
		queueChat(SKELETON_2, CATEGORY_PANDAS, CATEGORY_NUMPY, CONSISTENCY_EMPTY);

		const res = await postDraft(postEvent("soil_contamination"));
		expect(res.status).toBe(200);

		const body = (await res.json()) as { draft: { categories: Record<string, unknown> } };
		// Both categories present, in skeleton order.
		expect(Object.keys(body.draft.categories)).toEqual(["pandas", "numpy"]);
		expect((body.draft.categories.pandas as { title: string }).title).toBe("Pandas");
		expect((body.draft.categories.numpy as { title: string }).title).toBe("NumPy");
		expect(kiConnectMock.chatCompletion).toHaveBeenCalledTimes(4);

		// The second Phase 2 turn sees the already-drafted pandas category.
		const [, secondTurnUser] = kiConnectMock.chatCompletion.mock.calls[2] as [string, string];
		expect(secondTurnUser).toContain("ALREADY-DRAFTED CATEGORIES");
		expect(secondTurnUser).toContain("pandas");
		expect(secondTurnUser).toContain("MAY override");
	});

	it("consistency pass surfaces coverage notes and applies well-formed revisions", async () => {
		queueChat(SKELETON_1, CATEGORY_PANDAS, CONSISTENCY_WITH_NOTE);

		const res = await postDraft(postEvent("soil_contamination"));
		expect(res.status).toBe(200);

		const body = (await res.json()) as {
			draft: { categories: Record<string, unknown> };
			notes: string[];
		};
		// Coverage gap surfaced, never silent.
		expect(body.notes.some((n) => n.includes("creativity"))).toBe(true);
		// The deterministic one-round revision was applied.
		const pandas = body.draft.categories.pandas as {
			positive: Array<{ sub_points: Array<{ text: string }> }>;
		};
		expect(pandas.positive[0].sub_points[0].text).toBe(
			"Functions: good use of Pandas functions including `to_numpy()`.",
		);
		expect(kiConnectMock.chatCompletion).toHaveBeenCalledTimes(3);
	});

	it("retries the WHOLE draft on validation-gate failure and passes on the retry", async () => {
		queueChat(
			// Attempt 1: Phase 2 emits a category missing its title → gate rejects.
			SKELETON_1,
			BAD_CATEGORY,
			CONSISTENCY_EMPTY,
			// Attempt 2: valid draft.
			SKELETON_1,
			CATEGORY_PANDAS,
			CONSISTENCY_EMPTY,
		);

		const res = await postDraft(postEvent("soil_contamination"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { draft: { categories: Record<string, unknown> } };
		expect(body.draft.categories.pandas).toBeDefined();

		// 3 turns per attempt × 2 attempts.
		expect(kiConnectMock.chatCompletion).toHaveBeenCalledTimes(6);
		// The retry round's system prompt carries the exact rejection message.
		const [retrySystem] = kiConnectMock.chatCompletion.mock.calls[3] as [string, string];
		expect(retrySystem).toContain("PREVIOUS DRAFT REJECTED");
		expect(retrySystem).toContain("title must be a string");
	});

	it("400s with the validation message after max (3) attempts", async () => {
		// Every attempt fails the gate the same way: valid skeleton, then a
		// Phase 2 category missing its title → gate rejects → whole-draft
		// retry ×3 → 400 with the final validation message. Script all three
		// attempts (the once-queue must cover Phase 1 on every retry).
		for (let i = 0; i < 3; i++) {
			queueChat(SKELETON_1, BAD_CATEGORY, CONSISTENCY_EMPTY);
		}

		await expectApiError(
			postDraft(postEvent("soil_contamination")),
			400,
			"title must be a string",
		);
		// 3 attempts × (Phase 1 + Phase 2 + Phase 4).
		expect(kiConnectMock.chatCompletion).toHaveBeenCalledTimes(9);
		// The last attempt's system prompt still carries the rejection message.
		const [lastSystem] = kiConnectMock.chatCompletion.mock.calls[8] as [string, string];
		expect(lastSystem).toContain("PREVIOUS DRAFT REJECTED");
	});

	it("400s when a drafted category key collides with general.yaml (gate still enforced)", async () => {
		// The skeleton proposes the colliding key — every attempt drafts
		// "code_formatting" and the collision gate rejects the result.
		for (let i = 0; i < 3; i++) {
			queueChat(SKELETON_COLLISION, BARE_VALID_CATEGORY, CONSISTENCY_EMPTY);
		}

		await expectApiError(
			postDraft(postEvent("soil_contamination")),
			400,
			"code_formatting already exists in general.yaml",
		);
		expect(kiConnectMock.chatCompletion).toHaveBeenCalledTimes(9);
	});

	it("404s for an unknown assignment id without calling the LLM", async () => {
		await expectApiError(postDraft(postEvent("nope")), 404, 'Assignment "nope" not found');
		expect(kiConnectMock.chatCompletion).not.toHaveBeenCalled();
	});

	it("never writes any file under DATA_DIR (draft is review-only)", async () => {
		const before = await snapshotTree(dataDir);

		const res = await postDraft(postEvent("soil_contamination"));
		expect(res.status).toBe(200);

		const after = await snapshotTree(dataDir);
		expect(after).toEqual(before);

		const registry = await readRegistry();
		const assignment = registry.assignments.find((a) => a.id === "soil_contamination");
		expect(assignment?.criteria_files).toEqual([
			"data/criteria/general.yaml",
			"data/criteria/soil_contamination.yaml",
		]);
	});

	it("drafted document loads through the criteria loader and round-trips", async () => {
		const res = await postDraft(postEvent("soil_contamination"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			draft: { categories: Record<string, unknown> };
		};

		// Simulate the teacher's save: persist the draft to a criteria file,
		// then load it back through the server loader.
		await writeFile(
			path.join(dataDir, "criteria", "check.yaml"),
			yaml.dump({ categories: body.draft.categories }),
			"utf-8",
		);
		const loaded = await loadCriteriaFile("data/criteria/check.yaml");
		expect(loaded).not.toBeNull();
		expect(loaded!.categories).toEqual(body.draft.categories);
	});
});
