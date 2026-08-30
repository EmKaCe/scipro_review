// @vitest-environment node
/**
 * @file Tests for the T5 one-click reference-assignment seed
 * ($lib/server/onboarding-seed + POST /api/onboarding/seed).
 *
 * Runs against a real temp DATA_DIR fixture (same env-override mechanism as
 * onboarding-status.test.ts): a minimal assignments.yaml with criteria +
 * scoring files written under the temp dir, so the repo's tracked data/ is
 * never touched and process.env.DATA_DIR is restored after every test.
 * Covers: happy path (verify → enable through the shared writer → idempotent
 * second call reports alreadyEnabled) and the broken-install path (missing
 * scoring/criteria file → ok:false, missingFiles populated, registry file
 * untouched).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { REFERENCE_ASSIGNMENT_ID, seedReferenceAssignment } from "$lib/server/onboarding-seed";
import { getAssignmentById } from "$lib/server/assignments";

import { POST } from "../../routes/api/onboarding/seed/+server";

// ---------------------------------------------------------------------------
// Fixtures: minimal registry mirroring the tracked data/assignments.yaml shape
// ---------------------------------------------------------------------------

const ASSIGNMENTS_YAML = `assignments:
  - id: soil_contamination
    title: Soil Contamination by Factories (NumPy, Pandas, SciPy, sklearn)
    enabled: false
    scoring_file: data/scoring/soil_contamination.yaml
    criteria_files:
      - data/criteria/general.yaml
      - data/criteria/soil_contamination.yaml
    dimensions:
      - code_quality_design
`;

let dataDir: string;

/** Write the fixture registry + referenced files under the temp DATA_DIR. */
async function writeFixture(opts: { withScoring?: boolean } = {}): Promise<void> {
	const { withScoring = true } = opts;
	await writeFile(path.join(dataDir, "assignments.yaml"), ASSIGNMENTS_YAML, "utf-8");
	await mkdir(path.join(dataDir, "criteria"), { recursive: true });
	await writeFile(path.join(dataDir, "criteria", "general.yaml"), "categories: {}\n", "utf-8");
	await writeFile(
		path.join(dataDir, "criteria", "soil_contamination.yaml"),
		"categories: {}\n",
		"utf-8",
	);
	if (withScoring) {
		await mkdir(path.join(dataDir, "scoring"), { recursive: true });
		await writeFile(
			path.join(dataDir, "scoring", "soil_contamination.yaml"),
			"anchors: []\n",
			"utf-8",
		);
	}
}

beforeEach(async () => {
	dataDir = await mkdtemp(path.join(os.tmpdir(), "scipro-onboarding-seed-"));
	process.env.DATA_DIR = dataDir;
});

afterEach(async () => {
	delete process.env.DATA_DIR;
	await rm(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

describe("seedReferenceAssignment", () => {
	it("happy path: enables the reference assignment; second call reports alreadyEnabled", async () => {
		await writeFixture();

		const first = await seedReferenceAssignment();
		expect(first).toEqual({
			ok: true,
			assignmentId: REFERENCE_ASSIGNMENT_ID,
			alreadyEnabled: false,
			missingFiles: [],
		});

		// The registry was flipped through the shared writer path.
		expect((await getAssignmentById(REFERENCE_ASSIGNMENT_ID))?.enabled).toBe(true);

		// Idempotent — a second call re-checks integrity and reports alreadyEnabled.
		const second = await seedReferenceAssignment();
		expect(second.ok).toBe(true);
		expect(second.alreadyEnabled).toBe(true);
		expect(second.missingFiles).toEqual([]);
	});

	it("missing scoring file → ok:false, missingFiles populated, registry untouched", async () => {
		await writeFixture({ withScoring: false });

		const before = await readFile(path.join(dataDir, "assignments.yaml"), "utf-8");
		const result = await seedReferenceAssignment();

		expect(result.ok).toBe(false);
		expect(result.assignmentId).toBe(REFERENCE_ASSIGNMENT_ID);
		expect(result.alreadyEnabled).toBe(false);
		expect(result.missingFiles).toEqual(["data/scoring/soil_contamination.yaml"]);

		// Broken install → nothing written: the registry file is byte-identical.
		expect(await readFile(path.join(dataDir, "assignments.yaml"), "utf-8")).toBe(before);
		expect((await getAssignmentById(REFERENCE_ASSIGNMENT_ID))?.enabled).toBe(false);
	});

	it("missing criteria file → ok:false listing the missing path", async () => {
		await writeFixture();
		await rm(path.join(dataDir, "criteria", "soil_contamination.yaml"), { force: true });

		const result = await seedReferenceAssignment();

		expect(result.ok).toBe(false);
		expect(result.missingFiles).toEqual(["data/criteria/soil_contamination.yaml"]);
		expect((await getAssignmentById(REFERENCE_ASSIGNMENT_ID))?.enabled).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// API route
// ---------------------------------------------------------------------------

describe("POST /api/onboarding/seed", () => {
	it("200 with the seed result when the assignment is verified + enabled", async () => {
		await writeFixture();

		const response = await POST();
		expect(response.status).toBe(200);

		const body = (await response.json()) as {
			ok: boolean;
			assignmentId: string;
			alreadyEnabled: boolean;
			missingFiles: string[];
		};
		expect(body.ok).toBe(true);
		expect(body.assignmentId).toBe(REFERENCE_ASSIGNMENT_ID);
		expect(body.alreadyEnabled).toBe(false);
		expect(body.missingFiles).toEqual([]);
	});

	it("422 with the seed result when files are missing (broken install)", async () => {
		await writeFixture({ withScoring: false });

		const response = await POST();
		expect(response.status).toBe(422);

		const body = (await response.json()) as {
			ok: boolean;
			missingFiles: string[];
		};
		expect(body.ok).toBe(false);
		expect(body.missingFiles).toEqual(["data/scoring/soil_contamination.yaml"]);
	});
});
