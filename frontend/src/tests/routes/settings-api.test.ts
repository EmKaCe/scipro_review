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

import { GET, PATCH, PUT } from "../../routes/api/settings/+server";
import { loadSettings, writeSettings, type AppSettings } from "$lib/server/settings";
import { setApiKey } from "$lib/server/api-key-store";
import { resolveLastMessagesDefault } from "$lib/server/copilot/model-context";

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
	copilot: {
		mode: "ask",
		allowedTools: ["analyze-code"],
		denyTools: [],
		approvalTtlSeconds: 60,
		sessionCap: 20,
		lastMessages: 16,
		autoCompact: true,
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
	delete process.env.KI_CONNECT_API_KEY;
	setApiKey("");
	await rm(dataDir, { recursive: true, force: true });
});

function putRequest(body: unknown): Request {
	return new Request("http://localhost/api/settings", {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

function patchRequest(body: unknown): Request {
	return new Request("http://localhost/api/settings", {
		method: "PATCH",
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

	it("resolves copilot.lastMessages from the model when the yaml omits it", async () => {
		await writeFile(path.join(dataDir, "settings.yaml"), "llm:\n  model: test-model\n");

		const s = await loadSettings();
		expect(s.copilot.lastMessages).toBe(resolveLastMessagesDefault("test-model"));
		// The default-model path is the same: unknown 32K context -> 16.
		expect(resolveLastMessagesDefault("test-model")).toBe(16);
	});

	it("keeps an explicit last_messages from the yaml", async () => {
		await writeFile(path.join(dataDir, "settings.yaml"), "copilot:\n  last_messages: 7\n");

		const s = await loadSettings();
		expect(s.copilot.lastMessages).toBe(7);
	});

	it("defaults copilot.autoCompact to true when the yaml omits it (V.1)", async () => {
		// No settings.yaml at all → defaults.
		expect((await loadSettings()).copilot.autoCompact).toBe(true);
		// A yaml without auto_compact also falls back to true.
		await writeFile(path.join(dataDir, "settings.yaml"), "copilot:\n  last_messages: 2\n");
		expect((await loadSettings()).copilot.autoCompact).toBe(true);
	});

	it("keeps an explicit auto_compact: false from the yaml (V.1)", async () => {
		await writeFile(
			path.join(dataDir, "settings.yaml"),
			"copilot:\n  last_messages: 2\n  auto_compact: false\n",
		);

		const s = await loadSettings();
		expect(s.copilot.autoCompact).toBe(false);
		expect(s.copilot.lastMessages).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// API route
// ---------------------------------------------------------------------------

describe("/api/settings", () => {
	it("GET returns the current settings plus hasApiKey (never the key)", async () => {
		await writeSettings(FULL);

		const resp = await GET();
		expect(resp.status).toBe(200);
		const body = (await resp.json()) as AppSettings & { hasApiKey: boolean };
		expect(body).toEqual({ ...FULL, hasApiKey: false });
		expect(JSON.stringify(body)).not.toContain("apiKey");
	});

	it("PUT persists valid settings and returns them", async () => {
		const resp = await PUT({ request: putRequest(FULL) } as never);
		expect(resp.status).toBe(200);
		expect(await resp.json()).toEqual({ ...FULL, hasApiKey: false });

		// Reload from disk to prove persistence.
		expect(await loadSettings()).toEqual(FULL);
	});

	it("PUT accepts a valid lastMessages and round-trips it through GET", async () => {
		const withWindow: AppSettings = { ...FULL, copilot: { ...FULL.copilot, lastMessages: 7 } };
		const resp = await PUT({ request: putRequest(withWindow) } as never);
		expect(resp.status).toBe(200);
		expect(((await resp.json()) as AppSettings).copilot.lastMessages).toBe(7);
		// Reload from disk — the persisted value survives.
		expect((await loadSettings()).copilot.lastMessages).toBe(7);

		const getResp = await GET();
		expect(((await getResp.json()) as AppSettings).copilot.lastMessages).toBe(7);
	});

	it("PUT accepts autoCompact: false and round-trips it (V.1)", async () => {
		const withCompactOff: AppSettings = {
			...FULL,
			copilot: { ...FULL.copilot, autoCompact: false },
		};
		const resp = await PUT({ request: putRequest(withCompactOff) } as never);
		expect(resp.status).toBe(200);
		expect(((await resp.json()) as AppSettings).copilot.autoCompact).toBe(false);
		// Reload from disk — the persisted value survives.
		expect((await loadSettings()).copilot.autoCompact).toBe(false);
	});

	it("rejects invalid bodies with 400", async () => {
		const validBase = {
			executor: { requestTimeoutMs: 1, notebookTimeoutMs: 1, cellTimeoutS: 1 },
			llm: { baseUrl: "x", model: "m", timeoutMs: 1 },
			copilot: {
				mode: "ask",
				allowedTools: [],
				denyTools: [],
				approvalTtlSeconds: 60,
				sessionCap: 20,
			},
		};
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
			// lastMessages out of range: below 1, above 50, non-integer.
			{ ...validBase, copilot: { ...validBase.copilot, lastMessages: 0 } },
			{ ...validBase, copilot: { ...validBase.copilot, lastMessages: 100 } },
			{ ...validBase, copilot: { ...validBase.copilot, lastMessages: 1.5 } },
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

	it("PATCH stores the API key and GET only reports hasApiKey", async () => {
		expect(((await (await GET()).json()) as { hasApiKey: boolean }).hasApiKey).toBe(false);

		const resp = await PATCH({
			request: patchRequest({ apiKey: "  sk-new-key-abc  " }),
		} as never);
		expect(resp.status).toBe(200);
		expect(await resp.json()).toEqual({ ok: true });

		// GET exposes only the boolean — never the key itself.
		const getBody = (await (await GET()).json()) as { hasApiKey: boolean };
		expect(getBody.hasApiKey).toBe(true);
		expect(JSON.stringify(getBody)).not.toContain("sk-new-key-abc");
	});

	it("PATCH rejects missing or non-string apiKey with 400", async () => {
		for (const bad of [{}, { apiKey: 42 }, { apiKey: null }, { apiKey: ["x"] }]) {
			let status: number | null = null;
			try {
				await PATCH({ request: patchRequest(bad) } as never);
			} catch (err) {
				status = (err as { status?: number }).status ?? null;
			}
			expect(status).toBe(400);
		}
	});
});
