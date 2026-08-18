// @vitest-environment node
/**
 * @file API-contract tests for GET/PUT /api/assignments/[id]/scoring
 * (per-assignment scoring config editor endpoints).
 *
 * Real temp DATA_DIR (mkdtemp) with a seeded assignments.yaml (one
 * assignment with a committed scoring_file, one without), the real
 * committed soil scoring file copied into the temp dir, direct handler
 * imports and minimal RequestEvent stubs like the other route suites.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { RequestEvent } from "@sveltejs/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as yaml from "js-yaml";

import {
	GET as getScoring,
	PUT as putScoring,
} from "../../routes/api/assignments/[id]/scoring/+server";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ASSIGNMENTS_YAML = `assignments:
  - id: soil_contamination
    title: Soil Contamination by Factories
    enabled: true
    scoring_file: data/scoring/soil_contamination.yaml
    criteria_files:
      - data/criteria/general.yaml
    dimensions:
      - code_quality_design
  - id: atom_interaction
    title: Atom Interaction
    enabled: true
    criteria_files:
      - data/criteria/general.yaml
    dimensions: []
`;

/** The committed soil scoring file (byte-equality contract — read-only). */
const SOIL_SCORING_SOURCE = "/root/projects/svelte-review-copilot/data/scoring/soil_contamination.yaml";

/** A valid full scoring document for PUT (passes the compile gate). */
const VALID_SCORING: Record<string, unknown> = {
	reference_anchors: {
		A: 1210.91,
		B: -484.95,
		x0: -4.8,
		y0: 986.98,
		L: 684.48,
		r_squared: 0.9794,
		rmse: 25.18,
	},
	evidence_patterns: {
		r2_or_rmse_computed: {
			pattern: "\\bR\\s*(?:\\^2|²|2)\\s*[=:]\\s*[\\d.]+|\\bRMSE\\s*[=:]\\s*[\\d.]+",
			semantics: "test",
			haystack: "output",
		},
	},
	disallowed_libraries: ["tensorflow", "torch"],
};

/** Compile-gate-invalid: the pattern is not a valid regex. */
const BAD_REGEX_SCORING: Record<string, unknown> = {
	evidence_patterns: {
		broken: {
			pattern: "(",
			semantics: "test",
			haystack: "output",
		},
	},
};

/** Compile-gate-invalid: reference_anchors is partial (all-or-nothing). */
const PARTIAL_ANCHORS_SCORING: Record<string, unknown> = {
	reference_anchors: { A: 1210.91 },
};

let dataDir: string;

beforeEach(async () => {
	dataDir = await mkdtemp(path.join(os.tmpdir(), "scipro-scoring-editor-"));
	vi.stubEnv("DATA_DIR", dataDir);
	await writeFile(path.join(dataDir, "assignments.yaml"), ASSIGNMENTS_YAML);
	await mkdir(path.join(dataDir, "scoring"), { recursive: true });
	await writeFile(
		path.join(dataDir, "scoring", "soil_contamination.yaml"),
		await readFile(SOIL_SCORING_SOURCE, "utf-8"),
	);
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
	assignments: Array<{ id: string; scoring_file?: string }>;
}> {
	return yaml.load(await readFile(path.join(dataDir, "assignments.yaml"), "utf-8")) as {
		assignments: Array<{ id: string; scoring_file?: string }>;
	};
}

/** Read a scoring file from the temp data dir. */
async function readScoringFile(fileName: string): Promise<{ scoring: Record<string, unknown> }> {
	return yaml.load(
		await readFile(path.join(dataDir, fileName.replace(/^data\//, "")), "utf-8"),
	) as { scoring: Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// GET /api/assignments/[id]/scoring
// ---------------------------------------------------------------------------

describe("GET /api/assignments/[id]/scoring", () => {
	it("returns the committed soil scoring config", async () => {
		const res = await getScoring(getEvent("soil_contamination"));
		expect(res.status).toBe(200);

		const body = (await res.json()) as {
			fileName: string | null;
			content: { reference_anchors?: Record<string, number> } | null;
		};
		expect(body.fileName).toBe("data/scoring/soil_contamination.yaml");
		expect(body.content).not.toBeNull();
		expect(body.content!.reference_anchors?.A).toBe(1210.91);
		expect(body.content!.reference_anchors?.r_squared).toBe(0.9794);
	});

	it("returns null content when no scoring file exists", async () => {
		const res = await getScoring(getEvent("atom_interaction"));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			fileName: "data/scoring/atom_interaction.yaml",
			content: null,
		});
	});

	it("404s for an unknown assignment id", async () => {
		await expectApiError(getScoring(getEvent("nope")), 404, 'Assignment "nope" not found');
	});
});

// ---------------------------------------------------------------------------
// PUT /api/assignments/[id]/scoring
// ---------------------------------------------------------------------------

describe("PUT /api/assignments/[id]/scoring", () => {
	it("validates via the compile gate, persists the YAML, and returns the content", async () => {
		const res = await putScoring(putEvent("soil_contamination", { scoring: VALID_SCORING }));
		expect(res.status).toBe(200);

		const body = (await res.json()) as {
			fileName: string;
			content: Record<string, unknown>;
		};
		expect(body.fileName).toBe("data/scoring/soil_contamination.yaml");
		expect(body.content).toEqual(VALID_SCORING);

		// The file on disk contains the dumped YAML; parsing it back round-trips.
		const onDisk = await readScoringFile("data/scoring/soil_contamination.yaml");
		expect(onDisk.scoring).toEqual(VALID_SCORING);
	});

	it("rejects a bad regex via the compile gate with 400 and leaves the file unchanged", async () => {
		const before = await readFile(
			path.join(dataDir, "scoring", "soil_contamination.yaml"),
			"utf-8",
		);

		await expectApiError(
			putScoring(putEvent("soil_contamination", { scoring: BAD_REGEX_SCORING })),
			400,
			"evidence_patterns.broken",
		);

		const after = await readFile(
			path.join(dataDir, "scoring", "soil_contamination.yaml"),
			"utf-8",
		);
		expect(after).toBe(before);
	});

	it("rejects partial reference_anchors via the compile gate with 400 and leaves the file unchanged", async () => {
		const before = await readFile(
			path.join(dataDir, "scoring", "soil_contamination.yaml"),
			"utf-8",
		);

		await expectApiError(
			putScoring(putEvent("soil_contamination", { scoring: PARTIAL_ANCHORS_SCORING })),
			400,
			"reference_anchors",
		);

		const after = await readFile(
			path.join(dataDir, "scoring", "soil_contamination.yaml"),
			"utf-8",
		);
		expect(after).toBe(before);
	});

	it("no-op guard: semantically identical save does not rewrite the file", async () => {
		// Seed the file with a distinctive hand-written style (folded strings,
		// odd-but-valid formatting) that a yaml.dump would reformat.
		const handWritten = `scoring:
  reference_anchors:
    A: 1210.91
    B: -484.95
    x0: -4.8
    y0: 986.98
    L: 684.48
    r_squared: 0.9794
    rmse: 25.18
  evidence_patterns:
    r2_or_rmse_computed:
      pattern: >-
        \\bR\\s*(?:\\^2|²|2)\\s*[=:]\\s*[\\d.]+|\\bRMSE\\s*[=:]\\s*[\\d.]+
      semantics: test
      haystack: output
  disallowed_libraries:
    - tensorflow
    - torch
`;
		await writeFile(
			path.join(dataDir, "scoring", "soil_contamination.yaml"),
			handWritten,
			"utf-8",
		);

		// Same semantics, different key order — the client round-trip may
		// produce these differences.
		const res = await putScoring(
			putEvent("soil_contamination", {
				scoring: {
					disallowed_libraries: ["tensorflow", "torch"],
					evidence_patterns: {
						r2_or_rmse_computed: {
							pattern: "\\bR\\s*(?:\\^2|²|2)\\s*[=:]\\s*[\\d.]+|\\bRMSE\\s*[=:]\\s*[\\d.]+",
							semantics: "test",
							haystack: "output",
						},
					},
					reference_anchors: {
						A: 1210.91,
						B: -484.95,
						x0: -4.8,
						y0: 986.98,
						L: 684.48,
						r_squared: 0.9794,
						rmse: 25.18,
					},
				},
			}),
		);
		expect(res.status).toBe(200);

		// The file on disk must be byte-identical — no fake git diff.
		const after = await readFile(
			path.join(dataDir, "scoring", "soil_contamination.yaml"),
			"utf-8",
		);
		expect(after).toBe(handWritten);
	});

	it("creates data/scoring/<id>.yaml and wires scoring_file when the assignment has none", async () => {
		const res = await putScoring(putEvent("atom_interaction", { scoring: VALID_SCORING }));
		expect(res.status).toBe(200);

		const body = (await res.json()) as { fileName: string };
		expect(body.fileName).toBe("data/scoring/atom_interaction.yaml");

		const onDisk = await readScoringFile("data/scoring/atom_interaction.yaml");
		expect(onDisk.scoring).toEqual(VALID_SCORING);

		const registry = await readRegistry();
		const assignment = registry.assignments.find((a) => a.id === "atom_interaction");
		expect(assignment?.scoring_file).toBe("data/scoring/atom_interaction.yaml");
	});

	it("404s for an unknown assignment id without writing anything", async () => {
		await expectApiError(
			putScoring(putEvent("nope", { scoring: VALID_SCORING })),
			404,
			'Assignment "nope" not found',
		);
		await expect(readFile(path.join(dataDir, "scoring", "nope.yaml"))).rejects.toThrow();
	});

	it("400s for a missing 'scoring' map", async () => {
		await expectApiError(
			putScoring(putEvent("soil_contamination", { categories: {} })),
			400,
			"'scoring' map",
		);
	});
});
