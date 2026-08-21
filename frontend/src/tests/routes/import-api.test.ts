/**
 * @file L5 API-contract tests for POST /api/submissions/[id]/import.
 *
 * Real temp DATA_DIR (assignments.yaml + metadata.json on disk) and real
 * Request/Response objects, same conventions as submissions-api.test.ts.
 * The import endpoint takes a JSON envelope (no multipart), so the default
 * jsdom environment is fine here.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RequestEvent } from "@sveltejs/kit";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildGradingYaml } from "$lib/server/export-service";
import { upsertSubmission } from "$lib/server/metadata";

import { POST as importPOST } from "../../routes/api/submissions/[id]/import/+server";

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
  - id: molecular_dynamics
    title: Molecular Dynamics
    enabled: false
    criteria_files: []
    dimensions: []
`;

const ASSIGNMENT = "soil_contamination";

const notebookPath = (studentId: string) => `submissions/${ASSIGNMENT}/${studentId}.ipynb`;

let dataDir: string;

beforeEach(async () => {
	dataDir = await mkdtemp(path.join(os.tmpdir(), "scipro-import-"));
	process.env.DATA_DIR = dataDir;
	await mkdir(path.join(dataDir, "submissions", ASSIGNMENT), { recursive: true });
	await writeFile(path.join(dataDir, "assignments.yaml"), ASSIGNMENTS_YAML);
});

afterEach(async () => {
	delete process.env.DATA_DIR;
	await rm(dataDir, { recursive: true, force: true });
});

/** Minimal RequestEvent stub (the route only touches url/params/request). */
function makeEvent(
	url: string,
	opts: { params?: Record<string, string>; request?: Request } = {},
): RequestEvent {
	const absolute = url.startsWith("http") ? url : `http://localhost${url}`;
	return {
		url: new URL(absolute),
		params: opts.params ?? {},
		request: opts.request ?? new Request(absolute, { method: "GET" }),
	} as unknown as RequestEvent;
}

function jsonRequest(url: string, body: unknown): Request {
	const absolute = url.startsWith("http") ? url : `http://localhost${url}`;
	return new Request(absolute, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

async function readJson(resp: Response): Promise<Record<string, never>> {
	// Read-only JSON fixture body — values only flow into expect(); never
	// keeps every access type-safe without `any`.
	return (await resp.json()) as Record<string, never>;
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

async function seedSubmission(
	studentId: string,
	status: "pending" | "executing" | "executed" | "error" | "graded" = "executed",
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
// POST /api/submissions/[id]/import
// ---------------------------------------------------------------------------

describe("POST /api/submissions/[id]/import", () => {
	it("applies an exported teacher YAML and returns the updated record", async () => {
		const seeded = await seedSubmission("2026SS_03", "executed", {
			grading: {
				rubric: { data_quality: "complete" },
				dimensions: { code_quality_design: 1.5 },
				feedback: {
					code_formatting: {
						checked: ["blank lines - consistent"],
						comments: { "blank lines - consistent": "add blank lines" },
						deductions: { "blank lines - consistent": 0.5 },
						notes: "formatting pass",
					},
				},
				notes: "Good work",
				updatedAt: new Date().toISOString(),
			},
		});
		const yaml = buildGradingYaml({ ...seeded, teacherGrade: 12, status: "graded" });

		const url = `/api/submissions/2026SS_03/import?assignment=${ASSIGNMENT}`;
		const body = await readJson(
			await importPOST(
				makeEvent(url, {
					params: { id: "2026SS_03" },
					request: jsonRequest(url, { yaml }),
				}),
			),
		);

		expect(body.status).toBe("graded");
		expect(body.teacherGrade).toBe(12);
		expect(body.grading).toMatchObject({
			rubric: { data_quality: "complete" },
			dimensions: { code_quality_design: 1.5 },
			notes: "Good work",
			feedback: {
				code_formatting: {
					checked: ["blank lines - consistent"],
					comments: { "blank lines - consistent": "add blank lines" },
					deductions: { "blank lines - consistent": 0.5 },
					notes: "formatting pass",
				},
			},
		});
	});

	it("400s malformed teacher YAML with the ImportError message", async () => {
		await seedSubmission("2026SS_03", "executed");

		const url = `/api/submissions/2026SS_03/import?assignment=${ASSIGNMENT}`;

		// YAML syntax error.
		await expectApiError(
			importPOST(
				makeEvent(url, {
					params: { id: "2026SS_03" },
					request: jsonRequest(url, { yaml: "student_id: [unclosed" }),
				}),
			),
			400,
			"Invalid YAML",
		);

		// Valid YAML, invalid field shape.
		await expectApiError(
			importPOST(
				makeEvent(url, {
					params: { id: "2026SS_03" },
					request: jsonRequest(url, {
						yaml: "student_id: 2026SS_03\nassignment: soil_contamination\nscores: [1, 2]",
					}),
				}),
			),
			400,
			"scores",
		);
	});

	it("400s missing, empty or non-string yaml bodies", async () => {
		await seedSubmission("2026SS_03", "executed");
		const url = `/api/submissions/2026SS_03/import?assignment=${ASSIGNMENT}`;

		await expectApiError(
			importPOST(
				makeEvent(url, {
					params: { id: "2026SS_03" },
					request: jsonRequest(url, {}),
				}),
			),
			400,
			"yaml",
		);
		await expectApiError(
			importPOST(
				makeEvent(url, {
					params: { id: "2026SS_03" },
					request: jsonRequest(url, { yaml: "" }),
				}),
			),
			400,
			"yaml",
		);
		await expectApiError(
			importPOST(
				makeEvent(url, {
					params: { id: "2026SS_03" },
					request: jsonRequest(url, { yaml: 42 }),
				}),
			),
			400,
			"yaml",
		);
	});

	it("404s unknown submissions and unknown assignments", async () => {
		const url = `/api/submissions/2026SS_99/import?assignment=${ASSIGNMENT}`;
		await expectApiError(
			importPOST(
				makeEvent(url, {
					params: { id: "2026SS_99" },
					request: jsonRequest(url, { yaml: "student_id: 2026SS_99" }),
				}),
			),
			404,
			"2026SS_99",
		);

		const badAssignment = `/api/submissions/2026SS_01/import?assignment=does_not_exist`;
		await expectApiError(
			importPOST(
				makeEvent(badAssignment, {
					params: { id: "2026SS_01" },
					request: jsonRequest(badAssignment, { yaml: "student_id: 2026SS_01" }),
				}),
			),
			404,
			'Assignment "does_not_exist" not found',
		);
	});
});
