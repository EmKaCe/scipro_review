// @vitest-environment node
/**
 * @file API-contract tests for GET/PUT /api/assignments/[id]/criteria
 * (visual criteria editor endpoints).
 *
 * Real temp DATA_DIR (mkdtemp) with a seeded assignments.yaml (one
 * assignment with its own soil file, one with only general.yaml), plus a
 * minimal general.yaml and a soil fixture on disk; direct handler imports
 * and minimal RequestEvent stubs like the other route suites.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { RequestEvent } from "@sveltejs/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as yaml from "js-yaml";

import {
	GET as getCriteria,
	PUT as putCriteria,
} from "../../routes/api/assignments/[id]/criteria/+server";

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
  - id: atom_interaction
    title: Atom Interaction
    enabled: true
    criteria_files:
      - data/criteria/general.yaml
    dimensions: []
`;

/** A small valid general.yaml — its keys collide with PUTs using them. */
const GENERAL_YAML = `categories:
  code_formatting:
    title: Code Formatting
    additional_notes: true
    positive: []
    neutral: []
    negative: []
`;

/** The assignment's own soil criteria file (pandas + numpy, no general keys). */
const SOIL_YAML = `categories:
  pandas:
    title: Pandas
    additional_notes: true
    positive:
    - main_point: The following points were well done
      sub_points:
      - text: 'Functions: good use of Pandas functions.'
    neutral: []
    negative:
    - main_point: Data Loading
      sub_points:
      - text: 'Delimiter: incorrectly specified the separator.'
  numpy:
    title: NumPy
    additional_notes: false
    positive: []
    neutral: []
    negative: []
`;

/** A valid full document for PUT: two categories, all sentiments, flags. */
const VALID_CATEGORIES: Record<string, unknown> = {
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
		negative: [
			{
				main_point: "Data Loading",
				sub_points: [
					{
						text: "Delimiter: incorrectly specified the separator.",
						point_deduction: true,
					},
				],
			},
		],
	},
	numpy: {
		title: "NumPy",
		additional_notes: false,
		positive: [],
		neutral: [],
		negative: [],
	},
};

/** Schema-invalid: the category is missing its title. */
const INVALID_CATEGORIES: Record<string, unknown> = {
	pandas: {
		additional_notes: true,
		positive: [],
		neutral: [],
		negative: [],
	},
};

/** Valid schema but the category key collides with general.yaml. */
const COLLIDING_CATEGORIES: Record<string, unknown> = {
	code_formatting: {
		title: "Code Formatting",
		additional_notes: true,
		positive: [],
		neutral: [],
		negative: [],
	},
};

let dataDir: string;

beforeEach(async () => {
	dataDir = await mkdtemp(path.join(os.tmpdir(), "scipro-criteria-editor-"));
	vi.stubEnv("DATA_DIR", dataDir);
	await writeFile(path.join(dataDir, "assignments.yaml"), ASSIGNMENTS_YAML);
	await mkdir(path.join(dataDir, "criteria"), { recursive: true });
	await writeFile(path.join(dataDir, "criteria", "general.yaml"), GENERAL_YAML);
	await writeFile(path.join(dataDir, "criteria", "soil_contamination.yaml"), SOIL_YAML);
});

afterEach(async () => {
	vi.unstubAllEnvs();
	await rm(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal RequestEvent stub for the GET handler. */
function getEvent(id: string): RequestEvent {
	return { params: { id } } as unknown as RequestEvent;
}

/** Build a RequestEvent stub whose request.json() returns the body. */
function putEvent(id: string, body: unknown): RequestEvent {
	return {
		params: { id },
		request: {
			json: async () => body,
		},
	} as unknown as RequestEvent;
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

/** Parse a criteria file from the temp data dir. */
async function readCriteria(fileName: string): Promise<{ categories: Record<string, unknown> }> {
	return yaml.load(
		await readFile(path.join(dataDir, fileName.replace(/^data\//, "")), "utf-8"),
	) as {
		categories: Record<string, unknown>;
	};
}

// ---------------------------------------------------------------------------
// GET /api/assignments/[id]/criteria
// ---------------------------------------------------------------------------

describe("GET /api/assignments/[id]/criteria", () => {
	it("returns the assignment's own criteria file, excluding general.yaml categories", async () => {
		const res = await getCriteria(getEvent("soil_contamination"));
		expect(res.status).toBe(200);

		const body = (await res.json()) as {
			fileName: string | null;
			content: { categories: Record<string, unknown> } | null;
		};
		expect(body.fileName).toBe("data/criteria/soil_contamination.yaml");
		expect(body.content).not.toBeNull();
		expect(Object.keys(body.content!.categories).sort()).toEqual(["numpy", "pandas"]);
		expect(body.content!.categories).not.toHaveProperty("code_formatting");
	});

	it("returns null content when only general.yaml is in criteria_files", async () => {
		const res = await getCriteria(getEvent("atom_interaction"));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ fileName: null, content: null });
	});

	it("404s for an unknown assignment id", async () => {
		await expectApiError(getCriteria(getEvent("nope")), 404, 'Assignment "nope" not found');
	});
});

// ---------------------------------------------------------------------------
// PUT /api/assignments/[id]/criteria
// ---------------------------------------------------------------------------

describe("PUT /api/assignments/[id]/criteria", () => {
	it("validates, persists the YAML, and returns the round-tripped content", async () => {
		const res = await putCriteria(
			putEvent("soil_contamination", { categories: VALID_CATEGORIES }),
		);
		expect(res.status).toBe(200);

		const body = (await res.json()) as {
			fileName: string;
			content: { categories: Record<string, unknown> };
		};
		expect(body.fileName).toBe("data/criteria/soil_contamination.yaml");
		expect(body.content.categories).toEqual(VALID_CATEGORIES);

		// The file on disk contains the dumped YAML; parsing it back round-trips.
		const onDisk = await readCriteria("data/criteria/soil_contamination.yaml");
		expect(onDisk.categories).toEqual(body.content.categories);
	});

	it("rejects schema-invalid categories with 400 and leaves the file unchanged", async () => {
		const before = await readFile(
			path.join(dataDir, "criteria", "soil_contamination.yaml"),
			"utf-8",
		);

		await expectApiError(
			putCriteria(putEvent("soil_contamination", { categories: INVALID_CATEGORIES })),
			400,
			"title",
		);

		const after = await readFile(
			path.join(dataDir, "criteria", "soil_contamination.yaml"),
			"utf-8",
		);
		expect(after).toBe(before);
	});

	it("rejects a category key that collides with general.yaml with 400 and leaves the file unchanged", async () => {
		const before = await readFile(
			path.join(dataDir, "criteria", "soil_contamination.yaml"),
			"utf-8",
		);

		await expectApiError(
			putCriteria(putEvent("soil_contamination", { categories: COLLIDING_CATEGORIES })),
			400,
			"code_formatting already exists in general.yaml",
		);

		const after = await readFile(
			path.join(dataDir, "criteria", "soil_contamination.yaml"),
			"utf-8",
		);
		expect(after).toBe(before);
	});

	it("no-op guard: semantically identical save does not rewrite the file", async () => {
		// Seed the file with a distinctive hand-written style (folded strings,
		// odd-but-valid formatting) that a yaml.dump would reformat.
		const handWritten = `categories:
  pandas:
    title: Pandas
    additional_notes: true
    positive:
      - main_point: The following points were well done
        sub_points:
          - text: >-
              Functions: good use of Pandas functions.
    neutral: []
    negative: []
`;
		await writeFile(
			path.join(dataDir, "criteria", "soil_contamination.yaml"),
			handWritten,
			"utf-8",
		);

		// Same semantics, different key order / absent-vs-false booleans —
		// the client round-trip may produce these differences.
		const res = await putCriteria(
			putEvent("soil_contamination", {
				categories: {
					pandas: {
						title: "Pandas",
						additional_notes: true,
						positive: [
							{
								main_point: "The following points were well done",
								sub_points: [{ text: "Functions: good use of Pandas functions." }],
							},
						],
						neutral: [],
						negative: [],
					},
				},
			}),
		);
		expect(res.status).toBe(200);

		// The file on disk must be byte-identical — no fake git diff.
		const after = await readFile(
			path.join(dataDir, "criteria", "soil_contamination.yaml"),
			"utf-8",
		);
		expect(after).toBe(handWritten);
	});

	it("no-op guard: a real edit does rewrite the file", async () => {
		// Change the sub-point text — the file must be updated.
		const res = await putCriteria(
			putEvent("soil_contamination", {
				categories: {
					pandas: {
						title: "Pandas",
						additional_notes: true,
						positive: [
							{
								main_point: "The following points were well done",
								sub_points: [{ text: "CHANGED text" }],
							},
						],
						neutral: [],
						negative: [],
					},
				},
			}),
		);
		expect(res.status).toBe(200);

		const onDisk = await readCriteria("data/criteria/soil_contamination.yaml");
		expect(onDisk.categories.pandas).toMatchObject({
			positive: [{ sub_points: [{ text: "CHANGED text" }] }],
		});
	});

	it("creates data/criteria/<id>.yaml and appends it to criteria_files when no own file exists", async () => {
		const res = await putCriteria(
			putEvent("atom_interaction", { categories: VALID_CATEGORIES }),
		);
		expect(res.status).toBe(200);

		const body = (await res.json()) as { fileName: string };
		expect(body.fileName).toBe("data/criteria/atom_interaction.yaml");

		const onDisk = await readCriteria("data/criteria/atom_interaction.yaml");
		expect(onDisk.categories).toEqual(VALID_CATEGORIES);

		const registry = await readRegistry();
		const assignment = registry.assignments.find((a) => a.id === "atom_interaction");
		expect(assignment?.criteria_files).toEqual([
			"data/criteria/general.yaml",
			"data/criteria/atom_interaction.yaml",
		]);
	});

	it("404s for an unknown assignment id without writing anything", async () => {
		await expectApiError(
			putCriteria(putEvent("nope", { categories: VALID_CATEGORIES })),
			404,
			'Assignment "nope" not found',
		);
		await expect(readFile(path.join(dataDir, "criteria", "nope.yaml"))).rejects.toThrow();
	});
});
