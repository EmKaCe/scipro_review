// @vitest-environment node
/**
 * @file API-contract tests for POST /api/assignments/[id]/criteria
 * (Phase 3g Task 5): validated criteria YAML upload.
 *
 * Real temp DATA_DIR (mkdtemp) with a seeded assignments.yaml and a small
 * general.yaml; direct handler imports and minimal RequestEvent stubs like
 * the other route suites.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { RequestEvent } from "@sveltejs/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as yaml from "js-yaml";

import { POST as uploadCriteria } from "../../routes/api/assignments/[id]/criteria/+server";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ASSIGNMENTS_YAML = `assignments:
  - id: soil_contamination
    title: Soil Contamination by Factories
    enabled: true
    criteria_files:
      - data/criteria/general.yaml
    dimensions:
      - code_quality_design
`;

/** A small valid general.yaml — its keys collide with uploads using them. */
const GENERAL_YAML = `categories:
  code_formatting:
    title: Code Formatting
    additional_notes: true
    positive: []
    neutral: []
    negative: []
`;

/** A valid assignment-specific criteria document. */
const VALID_CRITERIA_YAML = `categories:
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
`;

/** Schema-invalid: the category is missing its title. */
const INVALID_CRITERIA_YAML = `categories:
  pandas:
    additional_notes: true
    positive: []
    neutral: []
    negative: []
`;

/** Valid schema but the category key collides with general.yaml. */
const COLLIDING_CRITERIA_YAML = `categories:
  code_formatting:
    title: Code Formatting
    additional_notes: true
    positive: []
    neutral: []
    negative: []
`;

let dataDir: string;

beforeEach(async () => {
	dataDir = await mkdtemp(path.join(os.tmpdir(), "scipro-criteria-upload-"));
	vi.stubEnv("DATA_DIR", dataDir);
	await writeFile(path.join(dataDir, "assignments.yaml"), ASSIGNMENTS_YAML);
	await mkdir(path.join(dataDir, "criteria"), { recursive: true });
	await writeFile(path.join(dataDir, "criteria", "general.yaml"), GENERAL_YAML);
});

afterEach(async () => {
	vi.unstubAllEnvs();
	await rm(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a multipart RequestEvent stub with one `file` entry. */
function uploadEvent(id: string, fileName: string, content: string): RequestEvent {
	const form = new FormData();
	form.append("file", new File([content], fileName, { type: "text/yaml" }));
	return {
		params: { id },
		request: {
			formData: async () => form,
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
async function readRegistry(): Promise<{ assignments: Array<{ criteria_files: string[] }> }> {
	return yaml.load(await readFile(path.join(dataDir, "assignments.yaml"), "utf-8")) as {
		assignments: Array<{ criteria_files: string[] }>;
	};
}

// ---------------------------------------------------------------------------
// POST /api/assignments/[id]/criteria
// ---------------------------------------------------------------------------

describe("POST /api/assignments/[id]/criteria", () => {
	it("validates and persists the file, appends it to criteria_files, responds 201", async () => {
		const res = await uploadCriteria(
			uploadEvent("soil_contamination", "soil_v2.yaml", VALID_CRITERIA_YAML),
		);
		expect(res.status).toBe(201);

		const body = (await res.json()) as { fileName: string; criteria_files: string[] };
		expect(body).toEqual({
			fileName: "data/criteria/soil_v2.yaml",
			criteria_files: ["data/criteria/general.yaml", "data/criteria/soil_v2.yaml"],
		});

		// The file really exists under <DATA_DIR>/criteria/ with the raw content.
		await expect(
			readFile(path.join(dataDir, "criteria", "soil_v2.yaml"), "utf-8"),
		).resolves.toBe(VALID_CRITERIA_YAML);

		// The registry now includes the appended path.
		const registry = await readRegistry();
		expect(registry.assignments[0]?.criteria_files).toEqual([
			"data/criteria/general.yaml",
			"data/criteria/soil_v2.yaml",
		]);
	});

	it("rejects schema-invalid YAML with 400 and writes no file", async () => {
		await expectApiError(
			uploadCriteria(uploadEvent("soil_contamination", "broken.yaml", INVALID_CRITERIA_YAML)),
			400,
			"title",
		);

		await expect(readFile(path.join(dataDir, "criteria", "broken.yaml"))).rejects.toThrow();

		const registry = await readRegistry();
		expect(registry.assignments[0]?.criteria_files).toEqual(["data/criteria/general.yaml"]);
	});

	it("rejects a category key that collides with general.yaml with 400", async () => {
		await expectApiError(
			uploadCriteria(uploadEvent("soil_contamination", "dupe.yaml", COLLIDING_CRITERIA_YAML)),
			400,
			"code_formatting already exists in general.yaml",
		);

		await expect(readFile(path.join(dataDir, "criteria", "dupe.yaml"))).rejects.toThrow();

		const registry = await readRegistry();
		expect(registry.assignments[0]?.criteria_files).toEqual(["data/criteria/general.yaml"]);
	});

	it("does not duplicate criteria_files when the same file is uploaded again", async () => {
		// First upload appends once…
		const first = await uploadCriteria(
			uploadEvent("soil_contamination", "soil_v2.yaml", VALID_CRITERIA_YAML),
		);
		expect(first.status).toBe(201);

		// …a re-upload of the same file must not append a second entry.
		const second = await uploadCriteria(
			uploadEvent("soil_contamination", "soil_v2.yaml", VALID_CRITERIA_YAML),
		);
		expect(second.status).toBe(201);
		const body = (await second.json()) as { criteria_files: string[] };
		expect(body.criteria_files).toEqual([
			"data/criteria/general.yaml",
			"data/criteria/soil_v2.yaml",
		]);

		const registry = await readRegistry();
		expect(registry.assignments[0]?.criteria_files).toEqual([
			"data/criteria/general.yaml",
			"data/criteria/soil_v2.yaml",
		]);
	});

	it("rejects a non-.yaml file with 400", async () => {
		await expectApiError(
			uploadCriteria(uploadEvent("soil_contamination", "criteria.txt", VALID_CRITERIA_YAML)),
			400,
			"Expected a .yaml criteria file",
		);
	});

	it("404s for an unknown assignment id", async () => {
		await expectApiError(
			uploadCriteria(uploadEvent("nope", "criteria.yaml", VALID_CRITERIA_YAML)),
			404,
			'Assignment "nope" not found',
		);

		await expect(readFile(path.join(dataDir, "criteria", "criteria.yaml"))).rejects.toThrow();
	});

	it("skips the general.yaml collision check when general.yaml is missing on disk", async () => {
		// Remove general.yaml — the upload with a colliding key must still succeed.
		await rm(path.join(dataDir, "criteria", "general.yaml"));

		const res = await uploadCriteria(
			uploadEvent("soil_contamination", "standalone.yaml", COLLIDING_CRITERIA_YAML),
		);
		expect(res.status).toBe(201);
		await expect(
			readFile(path.join(dataDir, "criteria", "standalone.yaml"), "utf-8"),
		).resolves.toBe(COLLIDING_CRITERIA_YAML);
	});
});
