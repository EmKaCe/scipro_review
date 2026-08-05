/**
 * @file Route tests — archive/restore + delete submission lifecycle.
 *
 * Covers:
 *   POST /api/submissions/[id]/archive  (archive + restore semantics,
 *                                        archivedFrom round-trip)
 *   DELETE /api/submissions/[id]        (metadata + notebook + results +
 *                                        plagiarism pairs removed)
 *
 * Runs against a throwaway DATA_DIR (mkdtemp), same pattern as
 * submissions-api.test.ts.
 */
// @vitest-environment node
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RequestEvent } from "@sveltejs/kit";

import { DELETE as deleteRoute } from "../../routes/api/submissions/[id]/+server.js";
import { POST as archiveRoute } from "../../routes/api/submissions/[id]/archive/+server.js";

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

function jsonRequest(url: string, body: unknown): Request {
	const absolute = url.startsWith("http") ? url : `http://localhost${url}`;
	return new Request(absolute, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

/** Seed one executed submission with a stored result + a plagiarism cache. */
async function seedSubmission(studentId: string) {
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
		status: "executed",
		createdAt: "2026-08-01T00:00:00.000Z",
		updatedAt: "2026-08-01T00:00:00.000Z",
	};
	await writeFile(path.join(dir, "metadata.json"), JSON.stringify(meta, null, 2));

	const results = JSON.parse(await readFile(path.join(dir, "results.json"), "utf-8"));
	results[studentId] = { success: true, cells: [], totalCells: 2 };
	await writeFile(path.join(dir, "results.json"), JSON.stringify(results, null, 2));

	const plagPath = path.join(dataDir, "plagiarism", `${ASSIGNMENT}.json`);
	const plag = JSON.parse(await readFile(plagPath, "utf-8"));
	plag.pairs.push({
		studentA: studentId,
		studentB: "2026SS_02",
		cellOverlap: 0.75,
		notebookOverlap: 0.75,
		matchedCells: [],
		flags: ["shared_imports"],
		details: { sharedVariableNames: [], sharedComments: [], sharedImports: ["numpy"] },
		reviewStatus: "unreviewed",
	});
	plag.comparedSubmissions = [...new Set([...plag.comparedSubmissions, studentId])];
	plag.totalPairs = (plag.comparedSubmissions.length * (plag.comparedSubmissions.length - 1)) / 2;
	await writeFile(plagPath, JSON.stringify(plag, null, 2));
}

beforeEach(async () => {
	dataDir = await mkdtemp(path.join(os.tmpdir(), "sci-pro-lifecycle-"));
	process.env.DATA_DIR = dataDir;
	await mkdir(path.join(dataDir, "submissions", ASSIGNMENT), { recursive: true });
	await mkdir(path.join(dataDir, "plagiarism"), { recursive: true });
	await writeFile(path.join(dataDir, "assignments.yaml"), ASSIGNMENTS_YAML);
	await writeFile(path.join(dataDir, "submissions", ASSIGNMENT, "metadata.json"), "{}");
	await writeFile(path.join(dataDir, "submissions", ASSIGNMENT, "results.json"), "{}");
	await writeFile(
		path.join(dataDir, "plagiarism", `${ASSIGNMENT}.json`),
		JSON.stringify({
			status: "done",
			assignmentId: ASSIGNMENT,
			generatedAt: "2026-08-01T00:00:00.000Z",
			pairs: [],
			totalPairs: 0,
			comparedSubmissions: [],
		}),
	);
});

afterEach(async () => {
	delete process.env.DATA_DIR;
	await rm(dataDir, { recursive: true, force: true });
});

describe("archive route", () => {
	it("archives a submission, remembers archivedFrom, and restores it", async () => {
		await seedSubmission("2026SS_01");

		const archResp = await archiveRoute(
			makeEvent(`/api/submissions/2026SS_01/archive?assignment=${ASSIGNMENT}`, {
				params: { id: "2026SS_01" },
				request: jsonRequest("/api/submissions/2026SS_01/archive", { action: "archive" }),
			}),
		);
		expect(archResp.status).toBe(200);
		const archived = await archResp.json();
		expect(archived.status).toBe("archived");
		expect(archived.archivedFrom).toBe("executed");

		const restResp = await archiveRoute(
			makeEvent(`/api/submissions/2026SS_01/archive?assignment=${ASSIGNMENT}`, {
				params: { id: "2026SS_01" },
				request: jsonRequest("/api/submissions/2026SS_01/archive", {
					action: "restore",
				}),
			}),
		);
		expect(restResp.status).toBe(200);
		const restored = await restResp.json();
		expect(restored.status).toBe("executed");
		expect(restored.archivedFrom).toBeUndefined();
	});

	it("archiving marks the student's plagiarism pairs ignored; restore returns them to unreviewed", async () => {
		await seedSubmission("2026SS_01");

		await archiveRoute(
			makeEvent(`/api/submissions/2026SS_01/archive?assignment=${ASSIGNMENT}`, {
				params: { id: "2026SS_01" },
				request: jsonRequest("/api/submissions/2026SS_01/archive", { action: "archive" }),
			}),
		);
		let plag = JSON.parse(
			await readFile(path.join(dataDir, "plagiarism", `${ASSIGNMENT}.json`), "utf-8"),
		);
		expect(plag.pairs[0].reviewStatus).toBe("ignored");

		await archiveRoute(
			makeEvent(`/api/submissions/2026SS_01/archive?assignment=${ASSIGNMENT}`, {
				params: { id: "2026SS_01" },
				request: jsonRequest("/api/submissions/2026SS_01/archive", {
					action: "restore",
				}),
			}),
		);
		plag = JSON.parse(
			await readFile(path.join(dataDir, "plagiarism", `${ASSIGNMENT}.json`), "utf-8"),
		);
		expect(plag.pairs[0].reviewStatus).toBe("unreviewed");
	});
});

describe("delete route", () => {
	it("removes metadata, notebook file, results entry, and plagiarism pairs", async () => {
		await seedSubmission("2026SS_01");

		const resp = await deleteRoute(
			makeEvent(`/api/submissions/2026SS_01?assignment=${ASSIGNMENT}`, {
				params: { id: "2026SS_01" },
				request: new Request("http://localhost/api/submissions/2026SS_01", {
					method: "DELETE",
				}),
			}),
		);
		expect(resp.status).toBe(200);
		const body = await resp.json();
		expect(body.deleted).toBe("2026SS_01");

		const meta = JSON.parse(
			await readFile(path.join(dataDir, "submissions", ASSIGNMENT, "metadata.json"), "utf-8"),
		);
		expect(meta["2026SS_01"]).toBeUndefined();

		const notebook = path.join(dataDir, "submissions", ASSIGNMENT, "2026SS_01.ipynb");
		await expect(readFile(notebook, "utf-8")).rejects.toMatchObject({ code: "ENOENT" });

		const results = JSON.parse(
			await readFile(path.join(dataDir, "submissions", ASSIGNMENT, "results.json"), "utf-8"),
		);
		expect(results["2026SS_01"]).toBeUndefined();

		const plag = JSON.parse(
			await readFile(path.join(dataDir, "plagiarism", `${ASSIGNMENT}.json`), "utf-8"),
		);
		expect(plag.pairs).toHaveLength(0);
		expect(plag.comparedSubmissions).not.toContain("2026SS_01");
	});

	it("404s for an unknown submission", async () => {
		await expect(
			deleteRoute(
				makeEvent(`/api/submissions/2026SS_99?assignment=${ASSIGNMENT}`, {
					params: { id: "2026SS_99" },
					request: new Request("http://localhost/api/submissions/2026SS_99", {
						method: "DELETE",
					}),
				}),
			),
		).rejects.toMatchObject({ status: 404 });
	});
});
