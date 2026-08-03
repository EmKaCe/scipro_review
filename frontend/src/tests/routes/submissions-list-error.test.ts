/**
 * @file L5 API-contract test: GET /api/submissions passes the per-submission
 * execution error message through to the dashboard rows (SubmissionMeta.error,
 * Phase 3f C2).
 *
 * Real temp DATA_DIR (assignments.yaml + metadata.json on disk) and real
 * Request/Response objects — same conventions as submissions-api.test.ts.
 * The list route spreads the stored record, so a record with `error` set
 * must surface it verbatim; records without one must not fabricate it.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RequestEvent } from "@sveltejs/kit";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { upsertSubmission } from "$lib/server/metadata";

import { GET as listGET } from "../../routes/api/submissions/+server";

// ---------------------------------------------------------------------------
// Fixtures & helpers
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

const ASSIGNMENT = "soil_contamination";

const notebookPath = (studentId: string) => `submissions/${ASSIGNMENT}/${studentId}.ipynb`;

let dataDir: string;

beforeEach(async () => {
	dataDir = await mkdtemp(path.join(os.tmpdir(), "scipro-list-error-"));
	process.env.DATA_DIR = dataDir;
	await mkdir(path.join(dataDir, "submissions", ASSIGNMENT), { recursive: true });
	await writeFile(path.join(dataDir, "assignments.yaml"), ASSIGNMENTS_YAML);
});

afterEach(async () => {
	delete process.env.DATA_DIR;
	await rm(dataDir, { recursive: true, force: true });
});

/** Minimal RequestEvent stub (the list route only touches url/params/request). */
function makeEvent(url: string): RequestEvent {
	const absolute = url.startsWith("http") ? url : `http://localhost${url}`;
	return {
		url: new URL(absolute),
		params: {},
		request: new Request(absolute, { method: "GET" }),
	} as unknown as RequestEvent;
}

async function readJson(resp: Response): Promise<Record<string, never>> {
	// Read-only JSON fixture body — values only flow into expect(); never
	// keeps every access type-safe without `any`.
	return (await resp.json()) as Record<string, never>;
}

async function seedSubmission(
	studentId: string,
	status: "pending" | "executing" | "executed" | "error" | "graded" = "pending",
	extra: Record<string, unknown> = {},
) {
	return upsertSubmission(ASSIGNMENT, studentId, {
		semester: "2026SS",
		fileName: `${studentId}.ipynb`,
		notebookPath: notebookPath(studentId),
		status,
		...extra,
	});
}

// ---------------------------------------------------------------------------
// GET /api/submissions — error passthrough
// ---------------------------------------------------------------------------

describe("GET /api/submissions — error passthrough (C2)", () => {
	it("returns the stored error message for failed submissions", async () => {
		await seedSubmission("2026SS_01", "error", { error: "Cell 2 failed: ZeroDivisionError" });

		const body = await readJson(await listGET(makeEvent("/api/submissions")));

		const [failed] = body.submissions as Array<Record<string, unknown>>;
		expect(failed.studentId).toBe("2026SS_01");
		expect(failed.status).toBe("error");
		expect(failed.error).toBe("Cell 2 failed: ZeroDivisionError");
	});

	it("omits error for records without one", async () => {
		await seedSubmission("2026SS_02", "executed");

		const body = await readJson(await listGET(makeEvent("/api/submissions")));

		const [clean] = body.submissions as Array<Record<string, unknown>>;
		expect(clean.status).toBe("executed");
		expect(clean.error).toBeUndefined();
	});
});
