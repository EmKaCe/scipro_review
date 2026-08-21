/**
 * @file Unit tests for the server-side API key store ($lib/server/api-key-store.ts).
 *
 * The store initializes from KI_CONNECT_API_KEY at module load, so each test
 * re-imports it via vi.resetModules() + dynamic import after setting env.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_KEY = "sk-test-123";

function fetchMock(): ReturnType<typeof vi.fn> {
	return vi.mocked(globalThis.fetch);
}

describe("api-key-store", () => {
	beforeEach(() => {
		delete process.env.KI_CONNECT_API_KEY;
		vi.stubGlobal("fetch", vi.fn());
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		delete process.env.KI_CONNECT_API_KEY;
		delete process.env.KI_CONNECT_BASE_URL;
		vi.resetModules();
	});

	it("initializes from the KI_CONNECT_API_KEY env var", async () => {
		process.env.KI_CONNECT_API_KEY = TEST_KEY;

		const store = await import("$lib/server/api-key-store");

		expect(store.getApiKey()).toBe(TEST_KEY);
		expect(store.hasApiKey()).toBe(true);
	});

	it("has no key when the env var is unset", async () => {
		const store = await import("$lib/server/api-key-store");

		expect(store.getApiKey()).toBe("");
		expect(store.hasApiKey()).toBe(false);
	});

	it("setApiKey replaces the key, flips hasApiKey and syncs the env", async () => {
		const store = await import("$lib/server/api-key-store");

		store.setApiKey(TEST_KEY);

		expect(store.getApiKey()).toBe(TEST_KEY);
		expect(store.hasApiKey()).toBe(true);
		expect(process.env.KI_CONNECT_API_KEY).toBe(TEST_KEY);

		store.setApiKey("");
		expect(store.getApiKey()).toBe("");
		expect(store.hasApiKey()).toBe(false);
	});

	it("the next getKiConnectClient() uses the new key", async () => {
		process.env.KI_CONNECT_BASE_URL = "https://ki-connect.test/v1";
		const store = await import("$lib/server/api-key-store");
		const { getKiConnectClient } = await import("$lib/server/ki-connect");

		store.setApiKey(TEST_KEY);
		const client = getKiConnectClient();
		fetchMock().mockResolvedValueOnce(
			new Response(JSON.stringify({ data: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);

		await client.listModels();

		expect(fetchMock()).toHaveBeenCalledWith(
			"https://ki-connect.test/v1/models",
			expect.objectContaining({
				headers: expect.objectContaining({ Authorization: `Bearer ${TEST_KEY}` }),
			}),
		);
	});
});
