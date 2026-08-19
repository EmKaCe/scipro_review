// @vitest-environment node
/**
 * @file API-contract tests for POST /api/assignments/[id]/criteria/draft
 * (LLM-drafted criteria categories for the visual criteria editor).
 *
 * Real temp DATA_DIR (mkdtemp) with a seeded assignments.yaml (an
 * assignment with its own rubric, one with only the shared general.yaml),
 * the real committed criteria files copied into the temp dir, direct handler
 * import and minimal RequestEvent stubs — mirroring
 * scoring-draft-api.test.ts. The KI Connect client is mocked at the module
 * level and returns a canned criteria document.
 */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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
const SOIL_CRITERIA_SOURCE = "/root/projects/svelte-review-copilot/data/criteria/soil_contamination.yaml";
const ATOM_CRITERIA_SOURCE = "/root/projects/svelte-review-copilot/data/criteria/atom_interaction.yaml";

/** The shared general rubric — its category keys must never appear in a draft. */
const GENERAL_CRITERIA_SOURCE = "/root/projects/svelte-review-copilot/data/criteria/general.yaml";

/** A valid full criteria document (passes the validation gate). */
const VALID_DRAFT: Record<string, unknown> = {
	categories: {
		pandas: {
			title: "Pandas",
			additional_notes: true,
			positive: [
				{
					main_point: "The following points were well done",
					sub_points: [{ text: "Functions: good use of Pandas functions.", comment: true }],
				},
			],
			neutral: [],
			negative: [{ main_point: "Data Loading", sub_points: [{ text: "Delimiter: separators correct in read_csv." }] }],
		},
	},
};

/** Validation-gate-invalid: the category is missing its title. */
const BAD_DRAFT: Record<string, unknown> = {
	categories: {
		pandas: {
			additional_notes: true,
			positive: [],
			neutral: [],
			negative: [],
		},
	},
};

/** Structurally valid but collides with a general.yaml category key. */
const COLLISION_DRAFT: Record<string, unknown> = {
	categories: {
		code_formatting: {
			title: "Would collide with general.yaml",
			additional_notes: true,
			positive: [
				{
					main_point: "Good",
					sub_points: [{ text: "Functions: good use of Pandas functions.", comment: true }],
				},
			],
			neutral: [],
			negative: [],
		},
	},
};

let dataDir: string;

beforeEach(async () => {
	dataDir = await mkdtemp(path.join(os.tmpdir(), "scipro-criteria-draft-"));
	vi.stubEnv("DATA_DIR", dataDir);
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

	kiConnectMock.chatCompletion.mockReset();
	kiConnectMock.chatCompletion.mockResolvedValue(VALID_DRAFT);
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

// ---------------------------------------------------------------------------
// POST /api/assignments/[id]/criteria/draft
// ---------------------------------------------------------------------------

describe("POST /api/assignments/[id]/criteria/draft", () => {
	it("returns the validation-gate-validated draft from the LLM", async () => {
		const res = await postDraft(postEvent("soil_contamination"));
		expect(res.status).toBe(200);

		const body = (await res.json()) as { draft: { categories: Record<string, unknown> } };
		expect(body.draft.categories).toEqual(VALID_DRAFT.categories);

		// Contract: temp 0.2, json_object, 60s timeout, PHASE_2_MODEL,
		// system + user prompts (rubric + metadata + skill rules grounded).
		expect(kiConnectMock.chatCompletion).toHaveBeenCalledTimes(1);
		expect(kiConnectMock.chatCompletion).toHaveBeenCalledWith(
			expect.any(String),
			expect.any(String),
			0.2,
			{ type: "json_object" },
			undefined,
			60_000,
			"openai-gpt-oss-120b",
		);
		const [system, user] = kiConnectMock.chatCompletion.mock.calls[0] as [string, string];
		expect(system).toContain("soil_contamination");
		expect(system).toContain("criteria-authoring");
		expect(system).toContain("OBSERVABLE notebook evidence");
		expect(user).toContain("Draft the assignment-specific criteria");
		expect(user).toContain("Soil Contamination by Factories");
		expect(user).toContain("code_quality_design");
	});

	it("404s for an unknown assignment id", async () => {
		await expectApiError(postDraft(postEvent("nope")), 404, 'Assignment "nope" not found');
		// The LLM must never be called for an unknown assignment.
		expect(kiConnectMock.chatCompletion).not.toHaveBeenCalled();
	});

	it("400s when the model draft fails the validation gate", async () => {
		kiConnectMock.chatCompletion.mockResolvedValueOnce(BAD_DRAFT);

		await expectApiError(postDraft(postEvent("soil_contamination")), 400, "title");
	});

	it("400s when the assignment has no own rubric", async () => {
		await expectApiError(
			postDraft(postEvent("no_rubric")),
			400,
			"Assignment has no rubric — upload criteria first",
		);
		expect(kiConnectMock.chatCompletion).not.toHaveBeenCalled();
	});

	it("400s when a drafted category key collides with general.yaml", async () => {
		// Seed the shared general rubric into the temp DATA_DIR so the
		// collision gate actually compares against it.
		await writeFile(
			path.join(dataDir, "criteria", "general.yaml"),
			await readFile(GENERAL_CRITERIA_SOURCE, "utf-8"),
		);
		kiConnectMock.chatCompletion.mockResolvedValueOnce(COLLISION_DRAFT);

		await expectApiError(
			postDraft(postEvent("soil_contamination")),
			400,
			"code_formatting already exists in general.yaml",
		);

		// Never-writes still holds: no new criteria file appears.
		const criteriaDir = path.join(dataDir, "criteria");
		const after = await readdir(criteriaDir);
		expect(after).not.toContain("code_formatting.yaml");
	});

	it("never writes a criteria file (draft is review-only)", async () => {
		// Snapshot the criteria dir before the draft; a successful draft must
		// not create, delete, or mutate any file (and must not touch the
		// registry either).
		const criteriaDir = path.join(dataDir, "criteria");
		const before = await readdir(criteriaDir);

		const res = await postDraft(postEvent("soil_contamination"));
		expect(res.status).toBe(200);

		const after = await readdir(criteriaDir);
		expect(after).toEqual(before);

		const registry = await readRegistry();
		const assignment = registry.assignments.find((a) => a.id === "soil_contamination");
		expect(assignment?.criteria_files).toEqual([
			"data/criteria/general.yaml",
			"data/criteria/soil_contamination.yaml",
		]);

		// The pre-existing committed file stays byte-identical.
		const soilBefore = await readFile(path.join(criteriaDir, "soil_contamination.yaml"), "utf-8");
		await postDraft(postEvent("soil_contamination"));
		const soilAfter = await readFile(path.join(criteriaDir, "soil_contamination.yaml"), "utf-8");
		expect(soilAfter).toBe(soilBefore);
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
