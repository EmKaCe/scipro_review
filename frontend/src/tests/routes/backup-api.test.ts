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
	// Copilot chat threads ride along in the full backup (Task T.6 guard):
	// copilot/memory/{threads,messages} + the audit log are part of DATA_DIR.
	await mkdir(path.join(dataDir, "copilot", "memory", "threads"), { recursive: true });
	await mkdir(path.join(dataDir, "copilot", "memory", "messages"), { recursive: true });
	await writeFile(
		path.join(dataDir, "copilot", "memory", "threads", "t-1.json"),
		JSON.stringify({
			id: "t-1",
			resourceId: "sub-1",
			title: "Backup conversation",
			createdAt: "2026-08-01T10:00:00.000Z",
			updatedAt: "2026-08-01T12:00:00.000Z",
			metadata: {},
		}),
		"utf-8",
	);
	await writeFile(
		path.join(dataDir, "copilot", "memory", "messages", "t-1.json"),
		JSON.stringify([
			{
				id: "m1",
				threadId: "t-1",
				resourceId: "sub-1",
				role: "user",
				content: { format: 2, parts: [{ type: "text", text: "Review this submission" }] },
				createdAt: "2026-08-01T11:00:00.000Z",
			},
		]),
		"utf-8",
	);
	await mkdir(path.join(dataDir, "copilot"), { recursive: true });
	await writeFile(
		path.join(dataDir, "copilot", "audit.jsonl"),
		'{"ts":"2026-08-01T11:05:00.000Z","threadId":"t-1","tool":"read-notebook","permission":"auto","decision":"auto","ok":true}\n',
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

	it("carries copilot chat threads + audit log through a full round-trip (T.6 guard)", async () => {
		// The whole-DATA_DIR backup zips copilot/memory (threads + messages)
		// and copilot/audit.jsonl — a future exclusion in backup-service.ts
		// must not silently drop chats; this test locks the behavior in.
		const download = await GET();
		const backup = new Uint8Array(await download.arrayBuffer());
		const zip = unzipSync(backup);
		expect(Object.keys(zip)).toContain("copilot/memory/threads/t-1.json");
		expect(Object.keys(zip)).toContain("copilot/memory/messages/t-1.json");
		expect(Object.keys(zip)).toContain("copilot/audit.jsonl");

		// Snapshot the seeded bytes, wipe the whole dir, restore, compare.
		const threadPath = path.join(dataDir, "copilot", "memory", "threads", "t-1.json");
		const messagesPath = path.join(dataDir, "copilot", "memory", "messages", "t-1.json");
		const auditPath = path.join(dataDir, "copilot", "audit.jsonl");
		const threadBytes = await readFile(threadPath);
		const messageBytes = await readFile(messagesPath);
		const auditBytes = await readFile(auditPath);

		await rm(dataDir, { recursive: true, force: true });
		await mkdir(dataDir, { recursive: true });

		const response = await postZip(backup);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { restored: number };
		expect(body.restored).toBeGreaterThanOrEqual(6);

		expect(await readFile(threadPath)).toEqual(threadBytes);
		expect(await readFile(messagesPath)).toEqual(messageBytes);
		expect(await readFile(auditPath)).toEqual(auditBytes);
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
