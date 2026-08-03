// @vitest-environment node
/**
 * @file L5 API-contract tests for /api/backup (teacher backup zip).
 *
 * Runs in the node environment: the route exercises undici's multipart
 * formData()/File machinery, which jsdom's Request polyfill does not
 * implement. Real temp DATA_DIR, real GET/POST handlers, real fflate zip
 * round-trip. Covers: download contains the data files, restore brings back
 * overwritten content, traversal-guard rejection, empty-file rejection.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { unzipSync, zipSync } from "fflate";

import { GET, POST } from "../../routes/api/backup/+server";

let dataDir: string;

beforeEach(async () => {
	dataDir = await mkdtemp(path.join(os.tmpdir(), "scipro-backup-"));
	process.env.DATA_DIR = dataDir;
	await mkdir(path.join(dataDir, "submissions", "soil_contamination"), { recursive: true });
	await mkdir(path.join(dataDir, "plagiarism"), { recursive: true });
	await writeFile(path.join(dataDir, "assignments.yaml"), "assignments: []\n", "utf-8");
	await writeFile(
		path.join(dataDir, "submissions", "soil_contamination", "2026SS_01.ipynb"),
		JSON.stringify({ cells: [], metadata: { original: "v1" } }),
		"utf-8",
	);
	await writeFile(
		path.join(dataDir, "plagiarism", "soil_contamination.json"),
		JSON.stringify({ pairs: [] }),
		"utf-8",
	);
});

afterEach(async () => {
	await rm(dataDir, { recursive: true, force: true });
	delete process.env.DATA_DIR;
});

async function postZip(bytes: Uint8Array): Promise<Response> {
	const form = new FormData();
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	form.append("file", new File([copy], "backup.zip", { type: "application/zip" }));
	const request = new Request("http://localhost/api/backup", { method: "POST", body: form });
	return POST({ request } as never);
}

describe("GET /api/backup", () => {
	it("downloads a zip containing the data files", async () => {
		const response = await GET();
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("application/zip");
		expect(response.headers.get("content-disposition")).toContain("sci-pro-teacher-backup-");

		const raw = await response.arrayBuffer();
		const zip = unzipSync(new Uint8Array(raw));
		expect(Object.keys(zip)).toContain("assignments.yaml");
		expect(Object.keys(zip)).toContain("submissions/soil_contamination/2026SS_01.ipynb");
		expect(Object.keys(zip)).toContain("plagiarism/soil_contamination.json");
	});
});

describe("POST /api/backup", () => {
	it("restores overwritten files from the zip", async () => {
		// Snapshot a backup first, THEN corrupt the file on disk.
		const download = await GET();
		const backup = new Uint8Array(await download.arrayBuffer());

		const notebookPath = path.join(
			dataDir,
			"submissions",
			"soil_contamination",
			"2026SS_01.ipynb",
		);
		const original = await readFile(notebookPath, "utf-8");
		await writeFile(notebookPath, "CORRUPTED", "utf-8");

		const response = await postZip(backup);

		expect(response.status).toBe(200);
		const body = (await response.json()) as { restored: number };
		expect(body.restored).toBeGreaterThanOrEqual(3);
		expect(await readFile(notebookPath, "utf-8")).toBe(original);
	});

	it("rejects zips with traversal entries", async () => {
		const evil = zipSync({ "../evil.txt": new TextEncoder().encode("pwned") });
		await expect(postZip(evil)).rejects.toMatchObject({ status: 400 });
	});

	it("rejects empty uploads", async () => {
		await expect(postZip(new Uint8Array(0))).rejects.toMatchObject({ status: 400 });
	});
});
