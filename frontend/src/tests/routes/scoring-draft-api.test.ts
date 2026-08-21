// @vitest-environment node
/**
 * @file API-contract tests for POST /api/assignments/[id]/scoring/draft
 * (LLM-drafted scoring config for the P7 scoring editor).
 *
 * Real temp DATA_DIR (mkdtemp) with a seeded assignments.yaml (an
 * assignment with own rubric + committed scoring file, one with own rubric
 * but no scoring file, one with only the shared general.yaml), the real
 * committed criteria/scoring files copied into the temp dir, direct handler
 * import and minimal RequestEvent stubs — mirroring
 * scoring-config-api.test.ts. The KI Connect client is mocked at the module
 * level (established pattern: settings-models-api.test.ts / analysis-tools
 * .test.ts) and returns a canned scoring document.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

const kiConnectMock = vi.hoisted(() => ({
	chatCompletion: vi.fn(),
}));

vi.mock("$lib/server/ki-connect", () => ({
	getKiConnectClient: () => ({ chatCompletion: kiConnectMock.chatCompletion }),
}));

import { POST as postDraft } from "../../routes/api/assignments/[id]/scoring/draft/+server";

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

/** The committed soil scoring file (byte-equality contract — read-only). */
const SOIL_SCORING_SOURCE = path.join(REPO_ROOT, "data/scoring/soil_contamination.yaml");
/** The committed soil own-rubric criteria file (grounding rubric). */
const SOIL_CRITERIA_SOURCE = path.join(REPO_ROOT, "data/criteria/soil_contamination.yaml");
const ATOM_CRITERIA_SOURCE = path.join(REPO_ROOT, "data/criteria/atom_interaction.yaml");

/** A valid full scoring document (passes the compile gate). */
const VALID_DRAFT: Record<string, unknown> = {
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
			pattern:
				"\\\\bR\\\\s*(?:\\\\^2|²|2)\\\\s*[=:]\\\\s*[\\\\d.]+|\\\\bRMSE\\\\s*[=:]\\\\s*[\\\\d.]+",
			semantics: "test",
			haystack: "output",
		},
	},
	disallowed_libraries: ["tensorflow", "torch"],
	allowed_libraries: ["numpy", "pandas", "scipy", "sklearn"],
	prompt_anchor_text: {
		dimension_guidance: {
			code_quality_design:
				"0-1: unstructured, 2-3: idiomatic with minor issues, 4-5: clean idiomatic code",
		},
	},
};

/** Compile-gate-invalid: the pattern is not a valid regex. */
const BAD_REGEX_DRAFT: Record<string, unknown> = {
	evidence_patterns: {
		broken: {
			pattern: "(",
			semantics: "test",
			haystack: "output",
		},
	},
};

let dataDir: string;

beforeEach(async () => {
	dataDir = await mkdtemp(path.join(os.tmpdir(), "scipro-scoring-draft-"));
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

	await mkdir(path.join(dataDir, "scoring"), { recursive: true });
	await writeFile(
		path.join(dataDir, "scoring", "soil_contamination.yaml"),
		await readFile(SOIL_SCORING_SOURCE, "utf-8"),
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
	assignments: Array<{ id: string; scoring_file?: string }>;
}> {
	return yaml.load(await readFile(path.join(dataDir, "assignments.yaml"), "utf-8")) as {
		assignments: Array<{ id: string; scoring_file?: string }>;
	};
}

// ---------------------------------------------------------------------------
// POST /api/assignments/[id]/scoring/draft
// ---------------------------------------------------------------------------

describe("POST /api/assignments/[id]/scoring/draft", () => {
	it("returns the compile-gate-validated draft from the LLM", async () => {
		const res = await postDraft(postEvent("soil_contamination"));
		expect(res.status).toBe(200);

		const body = (await res.json()) as { draft: Record<string, unknown> };
		expect(body.draft).toEqual(VALID_DRAFT);

		// The brief contract: temp 0.2, json_object, 60s timeout, PHASE_2_MODEL,
		// system + user prompts (rubric + metadata grounded).
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
		expect(system).toContain("reference_anchors");
		expect(user).toContain("Draft the scoring config for this assignment. Return ONLY JSON.");
		expect(user).toContain("Soil Contamination by Factories");
		expect(user).toContain("code_quality_design");
	});

	it("404s for an unknown assignment id", async () => {
		await expectApiError(postDraft(postEvent("nope")), 404, 'Assignment "nope" not found');
		// The LLM must never be called for an unknown assignment.
		expect(kiConnectMock.chatCompletion).not.toHaveBeenCalled();
	});

	it("400s when the model draft fails the compile gate", async () => {
		kiConnectMock.chatCompletion.mockResolvedValueOnce(BAD_REGEX_DRAFT);

		await expectApiError(
			postDraft(postEvent("soil_contamination")),
			400,
			"evidence_patterns.broken",
		);
	});

	it("400s when the assignment has no own rubric", async () => {
		await expectApiError(
			postDraft(postEvent("no_rubric")),
			400,
			"Assignment has no rubric — upload criteria first",
		);
		expect(kiConnectMock.chatCompletion).not.toHaveBeenCalled();
	});

	it("never writes a scoring file (draft is review-only)", async () => {
		// atom_interaction has an own rubric but no scoring file — a draft
		// call must not create data/scoring/atom_interaction.yaml.
		const res = await postDraft(postEvent("atom_interaction"));
		expect(res.status).toBe(200);

		await expect(
			readFile(path.join(dataDir, "scoring", "atom_interaction.yaml")),
		).rejects.toThrow();

		// The registry must not gain a scoring_file either.
		const registry = await readRegistry();
		const assignment = registry.assignments.find((a) => a.id === "atom_interaction");
		expect(assignment?.scoring_file).toBeUndefined();

		// And the pre-existing committed file stays byte-identical.
		const soilBefore = await readFile(
			path.join(dataDir, "scoring", "soil_contamination.yaml"),
			"utf-8",
		);
		await postDraft(postEvent("soil_contamination"));
		const soilAfter = await readFile(
			path.join(dataDir, "scoring", "soil_contamination.yaml"),
			"utf-8",
		);
		expect(soilAfter).toBe(soilBefore);
	});
});
