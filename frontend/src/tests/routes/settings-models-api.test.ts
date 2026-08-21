/**
 * @file L5 tests for GET /api/settings/models — live model detection with
 * static fallback. KiConnectClient.listModels is mocked at the module level.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const listModelsMock = vi.fn();

vi.mock("$lib/server/ki-connect", () => ({
	getKiConnectClient: () => ({ listModels: listModelsMock }),
}));

import { GET } from "../../routes/api/settings/models/+server";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const LIVE_MODELS = [
	{
		id: "qwen3-30b-a3b-instruct-2507",
		object: "model",
		created: 1_750_000_000,
		owned_by: "Academiccloud",
		context_length: 262_144,
	},
	{
		id: "brand-new-model",
		object: "model",
		created: 1_750_000_000,
		owned_by: "SomeOperator",
	},
];

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

describe("GET /api/settings/models", () => {
	beforeEach(() => {
		listModelsMock.mockReset();
	});

	it("maps live models (context_length from the API, open-weight + operator)", async () => {
		listModelsMock.mockResolvedValueOnce(LIVE_MODELS);

		const resp = await GET();
		const body = (await resp.json()) as {
			models: Array<{
				id: string;
				contextTokens: number;
				isOpenWeight: boolean;
				operator?: string;
			}>;
			source: string;
		};

		expect(resp.status).toBe(200);
		expect(body.source).toBe("live");
		expect(body.models).toEqual([
			{
				id: "qwen3-30b-a3b-instruct-2507",
				contextTokens: 262_144,
				isOpenWeight: true,
				operator: "Academiccloud",
			},
			{
				id: "brand-new-model",
				contextTokens: 32_768, // unknown → conservative fallback
				isOpenWeight: false,
				operator: "SomeOperator",
			},
		]);
	});

	it("uses the static context lookup for live models without context_length", async () => {
		listModelsMock.mockResolvedValueOnce([
			{ id: "gpt-5.2", object: "model", created: 1, owned_by: "Academiccloud" },
		]);

		const resp = await GET();
		const body = (await resp.json()) as {
			models: Array<{ id: string; contextTokens: number; isOpenWeight: boolean }>;
			source: string;
		};

		expect(body.source).toBe("live");
		expect(body.models[0]).toEqual({
			id: "gpt-5.2",
			contextTokens: 400_000, // from MODEL_CONTEXT_TOKENS
			isOpenWeight: false,
			operator: "Academiccloud",
		});
	});

	it("falls back to the static map when the live call returns nothing", async () => {
		listModelsMock.mockResolvedValueOnce([]);

		const resp = await GET();
		const body = (await resp.json()) as {
			models: Array<{ id: string; contextTokens: number; isOpenWeight: boolean }>;
			source: string;
		};

		expect(body.source).toBe("static");
		const ids = body.models.map((m) => m.id);
		expect(ids).toContain("qwen3-30b-a3b-instruct-2507");
		expect(ids).toContain("gpt-4.1-mini");
		expect(body.models.find((m) => m.id === "qwen3-30b-a3b-instruct-2507")).toEqual({
			id: "qwen3-30b-a3b-instruct-2507",
			contextTokens: 262_144,
			isOpenWeight: true,
		});
	});

	it("falls back to the static map when the live call throws", async () => {
		listModelsMock.mockRejectedValueOnce(new Error("KI Connect unreachable"));

		const resp = await GET();
		const body = (await resp.json()) as { models: unknown[]; source: string };

		expect(resp.status).toBe(200);
		expect(body.source).toBe("static");
		expect(body.models.length).toBeGreaterThan(0);
	});
});
