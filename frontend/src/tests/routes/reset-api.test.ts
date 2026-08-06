/**
 * @file Route tests — POST /api/submissions/[id]/reset.
 *
 * Covers:
 *   - clears grading + teacherGrade and reverts status to "executed"
 *   - 404 for unknown submissions / assignments
 *
 * Runs against a throwaway DATA_DIR (mkdtemp), same pattern as
 * submissions-lifecycle.test.ts.
 */
// @vitest-environment node
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RequestEvent } from "@sveltejs/kit";

import { POST as resetRoute } from "../../routes/api/submissions/[id]/reset/+server.js";

const ASSIGNMENT = "soil_contamination";

const ASSIGNMENTS_YAML = `assignments:
  - id: ${ASSIGNMENT}
    title: Soil Contamination
    enabled: true
    criteria_files: []
    dimensions: []
`;

let dataDir = "";

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

/** Seed a graded submission with rubric/dimensions/notes + final grade. */
async function seedGradedSubmission(studentId: string) {
	const dir = path.join(dataDir, "submissions", ASSIGNMENT);
	await mkdir(dir, { recursive: true });
	await writeFile(path.join(dir, `${studentId}.ipynb`), "{}");
	const meta = JSON.parse(await readFile(path.join(dir, "metadata.json"), "utf-8"));
	meta[studentId] = {
		id: studentId,
		studentId,
		assignmentId: ASSIGNMENT,
		semester: "2026SS",
		fileName: `${studentId}.ipynb`,
		notebookPath: `submissions/${ASSIGNMENT}/${studentId}.ipynb`,
		status: "graded",
		teacherGrade: 85,
		createdAt: "2026-08-01T00:00:00.000Z",
		updatedAt: "2026-08-01T00:00:00.000Z",
		grading: {
			rubric: { some_criterion: "positive" },
			dimensions: { code_quality_design: 2 },
			feedback: {
				code_formatting: { checked: ["x"], comments: {}, deductions: {}, notes: "" },
			},
			notes: "Top-level note",
			updatedAt: "2026-08-01T00:00:00.000Z",
		},
	};
	await writeFile(path.join(dir, "metadata.json"), JSON.stringify(meta, null, 2));
}

async function readRecord(studentId: string) {
	const dir = path.join(dataDir, "submissions", ASSIGNMENT);
	const meta = JSON.parse(await readFile(path.join(dir, "metadata.json"), "utf-8"));
	return meta[studentId];
}

beforeEach(async () => {
	dataDir = await mkdtemp(path.join(os.tmpdir(), "scipro-reset-"));
	process.env.DATA_DIR = dataDir;
	await mkdir(path.join(dataDir, "submissions", ASSIGNMENT), { recursive: true });
	await mkdir(path.join(dataDir, "criteria"), { recursive: true });
	await writeFile(path.join(dataDir, "assignments.yaml"), ASSIGNMENTS_YAML);
	await writeFile(
		path.join(dataDir, "submissions", ASSIGNMENT, "metadata.json"),
		JSON.stringify({}),
	);
});

afterEach(async () => {
	delete process.env.DATA_DIR;
	if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

describe("POST /api/submissions/[id]/reset", () => {
	it("clears grading + teacherGrade and reverts status to executed", async () => {
		await seedGradedSubmission("2026SS_03");
		const res = await resetRoute(
			makeEvent(`/api/submissions/2026SS_03/reset?assignment=${ASSIGNMENT}`, {
				params: { id: "2026SS_03" },
				request: new Request(`http://localhost/api/submissions/2026SS_03/reset`, {
					method: "POST",
				}),
			}),
		);
		expect(res.status).toBe(200);
		const record = await readRecord("2026SS_03");
		expect(record.status).toBe("executed");
		expect(record.teacherGrade).toBeUndefined();
		expect(record.grading.rubric).toEqual({});
		expect(record.grading.dimensions).toEqual({});
		expect(record.grading.feedback).toBeUndefined();
		expect(record.grading.notes).toBeUndefined();
	});

	it("404s for an unknown submission", async () => {
		await expect(
			resetRoute(
				makeEvent(`/api/submissions/unknown/reset?assignment=${ASSIGNMENT}`, {
					params: { id: "unknown" },
					request: new Request(`http://localhost/api/submissions/unknown/reset`, {
						method: "POST",
					}),
				}),
			),
		).rejects.toMatchObject({ status: 404 });
	});

	it("404s for an unknown assignment", async () => {
		await seedGradedSubmission("2026SS_03");
		await expect(
			resetRoute(
				makeEvent(`/api/submissions/2026SS_03/reset?assignment=nope`, {
					params: { id: "2026SS_03" },
					request: new Request(`http://localhost/api/submissions/2026SS_03/reset`, {
						method: "POST",
					}),
				}),
			),
		).rejects.toMatchObject({ status: 404 });
	});
});
