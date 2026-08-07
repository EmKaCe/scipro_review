/**
 * @file L5 tests for data/settings.yaml (server module + /api/settings).
 *
 * Covers: defaults when the file is missing, env fallback, file merge over
 * defaults, invalid-file surfacing, atomic write + reload, and the API
 * route's GET/PUT validation (secrets are never part of the surface).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { GET, PUT } from "../../routes/api/settings/+server";
import { loadSettings, writeSettings, type AppSettings } from "$lib/server/settings";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FULL: AppSettings = {
	executor: {
		requestTimeoutMs: 45_000,
		notebookTimeoutMs: 180_000,
		cellTimeoutS: 60,
	},
	llm: {
		baseUrl: "https://llm.example/v1",
		model: "test-model",
		timeoutMs: 90_000,
	},
};

// ---------------------------------------------------------------------------
// Setup: temp DATA_DIR per test
// ---------------------------------------------------------------------------

let dataDir: string;

beforeEach(async () => {
	dataDir = await mkdtemp(path.join(os.tmpdir(), "scipro-settings-"));
	process.env.DATA_DIR = dataDir;
});

afterEach(async () => {
	delete process.env.DATA_DIR;
	delete process.env.EXECUTOR_REQUEST_TIMEOUT_MS;
	delete process.env.EXECUTOR_NOTEBOOK_TIMEOUT_MS;
	delete process.env.EXECUTOR_CELL_TIMEOUT_S;
	delete process.env.KI_CONNECT_BASE_URL;
	delete process.env.KI_CONNECT_MODEL;
	delete process.env.KI_CONNECT_TIMEOUT_MS;
	await rm(dataDir, { recursive: true, force: true });
});

function putRequest(body: unknown): Request {
	return new Request("http://localhost/api/settings", {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

describe("settings module", () => {
	it("returns defaults when settings.yaml does not exist", async () => {
		const s = await loadSettings();
		expect(s.executor.requestTimeoutMs).toBe(30_000);
		expect(s.executor.notebookTimeoutMs).toBe(120_000);
		expect(s.executor.cellTimeoutS).toBe(30);
		expect(s.llm.baseUrl).toBe("https://chat.kiconnect.nrw/api/v1");
	});

	it("falls back to env vars when the file is missing", async () => {
		process.env.EXECUTOR_NOTEBOOK_TIMEOUT_MS = "90000";
		process.env.KI_CONNECT_MODEL = "env-model";

		const s = await loadSettings();

		expect(s.executor.notebookTimeoutMs).toBe(90_000);
		expect(s.llm.model).toBe("env-model");
	});

	it("merges file values over env defaults", async () => {
		process.env.EXECUTOR_REQUEST_TIMEOUT_MS = "20000"; // overridden by file
		await writeFile(
			path.join(dataDir, "settings.yaml"),
			"executor:\n  request_timeout_ms: 60000\n",
		);

		const s = await loadSettings();

		expect(s.executor.requestTimeoutMs).toBe(60_000);
		expect(s.executor.notebookTimeoutMs).toBe(120_000); // file leaves it default
	});

	it("round-trips through writeSettings", async () => {
		await writeSettings(FULL);

		const s = await loadSettings();
		expect(s).toEqual(FULL);
	});

	it("surfaces an invalid settings file instead of silently falling back", async () => {
		await writeFile(path.join(dataDir, "settings.yaml"), "executor: [not-an-object]");

		await expect(loadSettings()).rejects.toThrow(/settings.yaml/);
	});
});

// ---------------------------------------------------------------------------
// API route
// ---------------------------------------------------------------------------

describe("/api/settings", () => {
	it("GET returns the current settings", async () => {
		await writeSettings(FULL);

		const resp = await GET();
		expect(resp.status).toBe(200);
		expect(await resp.json()).toEqual(FULL);
	});

	it("PUT persists valid settings and returns them", async () => {
		const resp = await PUT({ request: putRequest(FULL) } as never);
		expect(resp.status).toBe(200);
		expect(await resp.json()).toEqual(FULL);

		// Reload from disk to prove persistence.
		expect(await loadSettings()).toEqual(FULL);
	});

	it("rejects invalid bodies with 400", async () => {
		for (const bad of [
			null,
			{},
			{ executor: {}, llm: {} },
			{
				executor: { requestTimeoutMs: -1, notebookTimeoutMs: 1, cellTimeoutS: 1 },
				llm: { baseUrl: "x", model: "m", timeoutMs: 1 },
			},
			{
				executor: { requestTimeoutMs: 1, notebookTimeoutMs: 1, cellTimeoutS: 1 },
				llm: { baseUrl: "", model: "m", timeoutMs: 1 },
			},
		]) {
			let status: number | null = null;
			try {
				await PUT({ request: putRequest(bad) } as never);
			} catch (err) {
				status = (err as { status?: number }).status ?? null;
			}
			expect(status).toBe(400);
		}
	});

	it("does not persist rejected bodies", async () => {
		const before = await loadSettings();
		try {
			await PUT({ request: putRequest({}) } as never);
		} catch {
			// expected 400
		}

		expect(await loadSettings()).toEqual(before);
	});
});
