/**
 * @file L5 API-contract tests for the assignments routes.
 *
 * Imports the route handlers directly and drives them with minimal Request
 * stubs against a throwaway DATA_DIR (mkdtemp), covering:
 *   GET  /api/assignments                — enabled-only listing, error mapping
 *   GET  /api/assignments/[id]/materials — status scanning, unsafe ids
 *   POST /api/assignments/[id]/materials — multipart persistence, error mapping
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { RequestEvent } from "@sveltejs/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET as listAssignments } from "../../routes/api/assignments/+server";
import { POST as postCriteria } from "../../routes/api/assignments/[id]/criteria/+server";
import {
	DELETE as deleteMaterials,
	GET as getMaterials,
	POST as postMaterials,
} from "../../routes/api/assignments/[id]/materials/+server";

// ---------------------------------------------------------------------------
// Fixtures & helpers
// ---------------------------------------------------------------------------

const ASSIGNMENTS_YAML = `assignments:
  - id: soil_contamination
    title: Soil Contamination by Factories (NumPy, Pandas, SciPy, sklearn)
    enabled: true
    criteria_files:
      - data/criteria/general.yaml
      - data/criteria/soil_contamination.yaml
    scoring_file: data/scoring/soil_contamination.yaml
  - id: atom_interaction
    title: Atom Interaction (Lennard-Jones / User Functions / Pandas / Plotting)
    enabled: true
    criteria_files:
      - data/criteria/general.yaml
      - data/criteria/atom_interaction.yaml
  - id: molecular_dynamics
    title: Molecular Dynamics (OpenMM / NumPy)
    enabled: false
    criteria_files:
      - data/criteria/general.yaml
      - data/criteria/molecular_dynamics.yaml
`;

/** Minimal RequestEvent stub — only what the handlers touch. */
function makeEvent(id: string, formData?: FormData): RequestEvent {
	return {
		params: { id },
		request: {
			formData: async () => {
				if (!formData) throw new Error("no body");
				return formData;
			},
		},
	} as unknown as RequestEvent;
}

/** RequestEvent stub with a real URL (DELETE reads ?name=). */
function makeDeleteEvent(id: string, query = ""): RequestEvent {
	return {
		url: new URL(`http://localhost/api/assignments/${id}/materials${query}`),
		params: { id },
		request: new Request(`http://localhost/api/assignments/${id}/materials${query}`, {
			method: "DELETE",
		}),
	} as unknown as RequestEvent;
}

/** FormData stand-in (jsdom's FormData rejects non-Blob values). */
function formDataWith(files: File[]): FormData {
	const entries = files.map((file, i) => [`file${i}`, file] as [string, File]);
	return { entries: () => entries[Symbol.iterator]() } as unknown as FormData;
}

/** Minimal File stand-in — jsdom's File has no arrayBuffer(). */
function fakeFile(name: string, content = "material content"): File {
	return {
		name,
		arrayBuffer: async () => new TextEncoder().encode(content).buffer,
	} as unknown as File;
}

/** Assert that a handler call rejects with an HttpError of the given status. */
async function expectHttpError(promise: Promise<Response>, status: number): Promise<void> {
	try {
		await promise;
	} catch (err) {
		expect((err as { status?: number }).status).toBe(status);
		return;
	}
	throw new Error(`expected handler to fail with status ${status}, but it succeeded`);
}

// ---------------------------------------------------------------------------
// Setup: isolated DATA_DIR per test
// ---------------------------------------------------------------------------

let dataDir: string;

beforeEach(async () => {
	dataDir = await mkdtemp(path.join(tmpdir(), "assignments-api-"));
	vi.stubEnv("DATA_DIR", dataDir);
});

afterEach(async () => {
	vi.unstubAllEnvs();
	await rm(dataDir, { recursive: true, force: true });
});

/** Path helper: <DATA_DIR>/materials/<assignmentId>/[...parts]. */
function materialsDir(assignmentId: string, ...parts: string[]): string {
	return path.join(dataDir, "materials", assignmentId, ...parts);
}

// ---------------------------------------------------------------------------
// GET /api/assignments
// ---------------------------------------------------------------------------

describe("GET /api/assignments", () => {
	it("returns only enabled assignments with id, title, enabled, criteria_files", async () => {
		await writeFile(path.join(dataDir, "assignments.yaml"), ASSIGNMENTS_YAML);

		const res = await listAssignments();
		expect(res.status).toBe(200);

		const body = (await res.json()) as {
			assignments: Array<{
				id: string;
				title: string;
				enabled: boolean;
				criteria_files: string[];
				scoring_file?: string;
			}>;
		};
		expect(body.assignments).toHaveLength(2);
		expect(body.assignments.map((a) => a.id)).toEqual([
			"soil_contamination",
			"atom_interaction",
		]);
		expect(body.assignments[0]).toEqual({
			id: "soil_contamination",
			title: "Soil Contamination by Factories (NumPy, Pandas, SciPy, sklearn)",
			enabled: true,
			criteria_files: ["data/criteria/general.yaml", "data/criteria/soil_contamination.yaml"],
			scoring_file: "data/scoring/soil_contamination.yaml",
		});
		// Assignments without a scoring file omit the field.
		expect(body.assignments[1]).toEqual({
			id: "atom_interaction",
			title: "Atom Interaction (Lennard-Jones / User Functions / Pandas / Plotting)",
			enabled: true,
			criteria_files: ["data/criteria/general.yaml", "data/criteria/atom_interaction.yaml"],
			scoring_file: undefined,
		});
	});

	it("skips malformed entries and keeps valid ones", async () => {
		await writeFile(
			path.join(dataDir, "assignments.yaml"),
			`assignments:
  - id: broken
    title: Missing criteria_files
    enabled: true
  - id: also_broken
    title: 42
    enabled: true
    criteria_files: [data/criteria/general.yaml]
  - id: valid
    title: Valid Assignment
    enabled: true
    criteria_files: [data/criteria/general.yaml]
`,
		);

		const res = await listAssignments();
		const body = (await res.json()) as { assignments: Array<{ id: string }> };
		expect(body.assignments.map((a) => a.id)).toEqual(["valid"]);
	});

	it("fails with 500 and a machine-readable code when assignments.yaml is missing", async () => {
		const res = await listAssignments();
		expect(res.status).toBe(500);
		const body = (await res.json()) as { message?: string; code?: string };
		expect(body.code).toBe("assignments-missing");
		expect(body.message).toMatch(/assignments\.yaml not found/);
	});

	it("fails with 500 on corrupt YAML", async () => {
		await writeFile(path.join(dataDir, "assignments.yaml"), "::: not yaml [");
		await expectHttpError(listAssignments(), 500);
	});

	it("fails with 500 when the 'assignments' list is missing", async () => {
		await writeFile(path.join(dataDir, "assignments.yaml"), "foo: bar\n");
		await expectHttpError(listAssignments(), 500);
	});
});

// ---------------------------------------------------------------------------
// GET /api/assignments/[id]/materials
// ---------------------------------------------------------------------------

describe("GET /api/assignments/[id]/materials", () => {
	it("reports an empty status when no materials exist", async () => {
		const res = await getMaterials(makeEvent("soil_contamination"));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			assignmentId: "soil_contamination",
			hasPdf: false,
			hasKey: false,
			hasInputData: false,
			files: [],
		});
	});

	it("detects pdf, key notebooks, and input_data files with kinds and relative paths", async () => {
		await mkdir(materialsDir("soil_contamination", "input_data"), { recursive: true });
		await writeFile(materialsDir("soil_contamination", "assignment.pdf"), "pdf-bytes");
		await writeFile(materialsDir("soil_contamination", "key.ipynb"), "{}");
		await writeFile(
			materialsDir("soil_contamination", "assignment_soil_contamination_key.ipynb"),
			"{}",
		);
		await writeFile(materialsDir("soil_contamination", "input_data", "soil.csv"), "a,b\n");

		const res = await getMaterials(makeEvent("soil_contamination"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			hasPdf: boolean;
			hasKey: boolean;
			hasInputData: boolean;
			files: Array<{ name: string; kind: string; relativePath: string }>;
		};
		expect(body.hasPdf).toBe(true);
		expect(body.hasKey).toBe(true);
		expect(body.hasInputData).toBe(true);
		expect(body.files).toEqual(
			expect.arrayContaining([
				{
					name: "assignment.pdf",
					kind: "material-file",
					relativePath: "materials/soil_contamination/assignment.pdf",
				},
				{
					name: "key.ipynb",
					kind: "material-file",
					relativePath: "materials/soil_contamination/key.ipynb",
				},
				{
					name: "assignment_soil_contamination_key.ipynb",
					kind: "material-file",
					relativePath:
						"materials/soil_contamination/assignment_soil_contamination_key.ipynb",
				},
				{
					name: "soil.csv",
					kind: "material-data",
					relativePath: "materials/soil_contamination/input_data/soil.csv",
				},
			]),
		);
	});

	it("rejects unsafe assignment ids with 400", async () => {
		await expectHttpError(getMaterials(makeEvent("../evil")), 400);
		await expectHttpError(getMaterials(makeEvent("")), 400);
	});
});

// ---------------------------------------------------------------------------
// POST /api/assignments/[id]/materials
// ---------------------------------------------------------------------------

describe("POST /api/assignments/[id]/materials", () => {
	it("persists a pdf to the materials root and reports hasPdf", async () => {
		const res = await postMaterials(
			makeEvent(
				"soil_contamination",
				formDataWith([fakeFile("assignment_soil_contamination.pdf")]),
			),
		);
		expect(res.status).toBe(200);

		const body = (await res.json()) as {
			status: { hasPdf: boolean };
			uploaded: Array<{ name: string; kind: string; replaced: boolean; bytes: number }>;
		};
		expect(body.status.hasPdf).toBe(true);
		expect(body.uploaded).toEqual([
			{
				name: "assignment_soil_contamination.pdf",
				kind: "material-file",
				replaced: false,
				bytes: 16,
			},
		]);

		const stored = await readFile(
			materialsDir("soil_contamination", "assignment_soil_contamination.pdf"),
			"utf-8",
		);
		expect(stored).toBe("material content");
	});

	it("persists key.ipynb as a material file and reports hasKey", async () => {
		const res = await postMaterials(
			makeEvent("soil_contamination", formDataWith([fakeFile("key.ipynb")])),
		);
		expect(res.status).toBe(200);

		const body = (await res.json()) as { status: { hasKey: boolean } };
		expect(body.status.hasKey).toBe(true);

		await expect(
			readFile(materialsDir("soil_contamination", "key.ipynb"), "utf-8"),
		).resolves.toBe("material content");
	});

	it("routes data files into input_data/", async () => {
		const res = await postMaterials(
			makeEvent("soil_contamination", formDataWith([fakeFile("soil_samples.csv")])),
		);
		expect(res.status).toBe(200);

		const body = (await res.json()) as {
			status: { hasInputData: boolean };
			uploaded: Array<{ name: string; kind: string; replaced: boolean; bytes: number }>;
		};
		expect(body.status.hasInputData).toBe(true);
		expect(body.uploaded).toEqual([
			{ name: "soil_samples.csv", kind: "material-data", replaced: false, bytes: 16 },
		]);

		await expect(
			readFile(materialsDir("soil_contamination", "input_data", "soil_samples.csv"), "utf-8"),
		).resolves.toBe("material content");
	});

	it("re-uploading the same file replaces it and reports replaced: true", async () => {
		const first = await postMaterials(
			makeEvent("soil_contamination", formDataWith([fakeFile("key.ipynb", "v1")])),
		);
		const second = await postMaterials(
			makeEvent("soil_contamination", formDataWith([fakeFile("key.ipynb", "v2")])),
		);

		const firstBody = (await first.json()) as { uploaded: Array<{ replaced: boolean }> };
		const secondBody = (await second.json()) as { uploaded: Array<{ replaced: boolean }> };
		expect(firstBody.uploaded[0]!.replaced).toBe(false);
		expect(secondBody.uploaded[0]!.replaced).toBe(true);

		await expect(
			readFile(materialsDir("soil_contamination", "key.ipynb"), "utf-8"),
		).resolves.toBe("v2");
	});

	it("rejects an empty multipart body with 400", async () => {
		await expectHttpError(
			postMaterials(makeEvent("soil_contamination", formDataWith([]))),
			400,
		);
	});

	it("rejects student-submission filenames with 400", async () => {
		await expectHttpError(
			postMaterials(
				makeEvent("soil_contamination", formDataWith([fakeFile("2026SS_03.ipynb")])),
			),
			400,
		);
	});
});

// ---------------------------------------------------------------------------
// DELETE /api/assignments/[id]/materials
// ---------------------------------------------------------------------------

describe("DELETE /api/assignments/[id]/materials", () => {
	it("deletes a single material file and reports the updated status", async () => {
		await mkdir(materialsDir("soil_contamination", "input_data"), { recursive: true });
		await writeFile(materialsDir("soil_contamination", "assignment.pdf"), "pdf");
		await writeFile(materialsDir("soil_contamination", "input_data", "soil.csv"), "a,b\n");

		const res = await deleteMaterials(makeDeleteEvent("soil_contamination", "?name=soil.csv"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			removed: string[];
			status: { hasInputData: boolean; files: Array<{ name: string }> };
		};
		expect(body.removed).toEqual(["soil.csv"]);
		expect(body.status.hasInputData).toBe(false);
		expect(body.status.files.map((f) => f.name)).toEqual(["assignment.pdf"]);

		// The file is really gone; the sibling material remains.
		await expect(
			readFile(materialsDir("soil_contamination", "input_data", "soil.csv")),
		).rejects.toThrow();
		await expect(
			readFile(materialsDir("soil_contamination", "assignment.pdf"), "utf-8"),
		).resolves.toBe("pdf");
	});

	it("clears the whole materials directory when no name is given", async () => {
		await mkdir(materialsDir("soil_contamination", "input_data"), { recursive: true });
		await writeFile(materialsDir("soil_contamination", "assignment.pdf"), "pdf");
		await writeFile(materialsDir("soil_contamination", "input_data", "soil.csv"), "a,b\n");

		const res = await deleteMaterials(makeDeleteEvent("soil_contamination"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			removed: string[];
			status: { hasPdf: boolean; hasInputData: boolean; files: unknown[] };
		};
		expect(body.status).toEqual({
			assignmentId: "soil_contamination",
			hasPdf: false,
			hasKey: false,
			hasInputData: false,
			files: [],
		});
	});

	it("rejects path traversal names with 400", async () => {
		await expectHttpError(
			deleteMaterials(makeDeleteEvent("soil_contamination", "?name=../assignments.yaml")),
			400,
		);
	});

	it("404s for a missing file", async () => {
		await expectHttpError(
			deleteMaterials(makeDeleteEvent("soil_contamination", "?name=nope.pdf")),
			404,
		);
	});
});

// ---------------------------------------------------------------------------
// POST /api/assignments/[id]/criteria
// ---------------------------------------------------------------------------

describe("POST /api/assignments/[id]/criteria", () => {
	const VALID_CRITERIA_YAML = `categories:
  pandas:
    title: Pandas
    additional_notes: true
    positive: []
    neutral: []
    negative: []
`;

	// Seed the registry + general.yaml for this suite only (the sibling
	// suites intentionally start with an empty DATA_DIR).
	beforeEach(async () => {
		await writeFile(path.join(dataDir, "assignments.yaml"), ASSIGNMENTS_YAML);
		await mkdir(path.join(dataDir, "criteria"), { recursive: true });
		await writeFile(
			path.join(dataDir, "criteria", "general.yaml"),
			`categories:
  code_formatting:
    title: Code Formatting
    additional_notes: true
    positive: []
    neutral: []
    negative: []
`,
		);
	});

	/** Multipart RequestEvent stub with one `file` entry. */
	function criteriaEvent(id: string, fileName: string, content: string): RequestEvent {
		const form = new FormData();
		form.append("file", new File([content], fileName, { type: "text/yaml" }));
		return {
			params: { id },
			request: {
				formData: async () => form,
			},
		} as unknown as RequestEvent;
	}

	it("validates and persists the file, appends it to criteria_files, responds 201", async () => {
		const res = await postCriteria(
			criteriaEvent("soil_contamination", "soil_v2.yaml", VALID_CRITERIA_YAML),
		);
		expect(res.status).toBe(201);

		const body = (await res.json()) as { fileName: string; criteria_files: string[] };
		expect(body).toEqual({
			fileName: "data/criteria/soil_v2.yaml",
			criteria_files: [
				"data/criteria/general.yaml",
				"data/criteria/soil_contamination.yaml",
				"data/criteria/soil_v2.yaml",
			],
		});

		await expect(
			readFile(path.join(dataDir, "criteria", "soil_v2.yaml"), "utf-8"),
		).resolves.toBe(VALID_CRITERIA_YAML);
	});

	it("rejects schema-invalid YAML with 400 and writes no file", async () => {
		await expectHttpError(
			postCriteria(
				criteriaEvent(
					"soil_contamination",
					"broken.yaml",
					"categories:\n  pandas:\n    positive: []\n",
				),
			),
			400,
		);

		await expect(readFile(path.join(dataDir, "criteria", "broken.yaml"))).rejects.toThrow();
	});

	it("rejects a category key colliding with general.yaml with 400", async () => {
		await expectHttpError(
			postCriteria(
				criteriaEvent(
					"soil_contamination",
					"dupe.yaml",
					`categories:
  code_formatting:
    title: Code Formatting
    additional_notes: true
    positive: []
    neutral: []
    negative: []
`,
				),
			),
			400,
		);
	});

	it("rejects a non-.yaml file with 400", async () => {
		await expectHttpError(
			postCriteria(criteriaEvent("soil_contamination", "criteria.txt", VALID_CRITERIA_YAML)),
			400,
		);
	});

	it("404s for an unknown assignment id", async () => {
		await expectHttpError(
			postCriteria(criteriaEvent("nope", "criteria.yaml", VALID_CRITERIA_YAML)),
			404,
		);
	});
});
