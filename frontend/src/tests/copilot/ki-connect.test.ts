/**
 * @file Unit tests for KiConnectClient.chatCompletion JSON handling —
 * extraction/repair via extractAndParseJSON, the one-shot repair retry,
 * and optional Zod schema validation. `fetch` is mocked globally.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { KiConnectClient } from "$lib/server/ki-connect";

const TEST_API_KEY = "test-api-key-123";
const TEST_BASE_URL = "https://ki-connect.test/v1";

function chatResponse(content: string, status = 200): Response {
	return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function fetchMock(): ReturnType<typeof vi.fn> {
	return vi.mocked(globalThis.fetch);
}

describe("KiConnectClient chatCompletion JSON handling", () => {
	let client: KiConnectClient;

	beforeEach(() => {
		vi.stubGlobal("fetch", vi.fn());
		process.env.KI_CONNECT_API_KEY = TEST_API_KEY;
		client = new KiConnectClient({ baseUrl: TEST_BASE_URL });
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		delete process.env.KI_CONNECT_API_KEY;
	});

	it("parses clean JSON from the response content", async () => {
		fetchMock().mockResolvedValueOnce(chatResponse('{"grade": 5, "ok": true}'));

		const result = await client.chatCompletion("system", "user", 0.1, {
			type: "json_object",
		});

		expect(result).toEqual({ grade: 5, ok: true });
		expect(fetchMock()).toHaveBeenCalledTimes(1);
		expect(fetchMock()).toHaveBeenCalledWith(
			`${TEST_BASE_URL}/chat/completions`,
			expect.objectContaining({ method: "POST" }),
		);
	});

	it("extracts JSON wrapped in markdown code fences", async () => {
		fetchMock().mockResolvedValueOnce(
			chatResponse('Here you go:\n```json\n{"grade": 5}\n```\nDone.'),
		);

		const result = await client.chatCompletion("system", "user");

		expect(result).toEqual({ grade: 5 });
		expect(fetchMock()).toHaveBeenCalledTimes(1);
	});

	it("repairs trailing commas in the response content", async () => {
		fetchMock().mockResolvedValueOnce(chatResponse('{"grade": 5, "notes": ["a", "b",]}'));

		const result = await client.chatCompletion("system", "user");

		expect(result).toEqual({ grade: 5, notes: ["a", "b"] });
		expect(fetchMock()).toHaveBeenCalledTimes(1);
	});

	it("retries once with a JSON-fix prompt when the first response is not parseable", async () => {
		fetchMock()
			.mockResolvedValueOnce(
				chatResponse("I am sorry, here is the answer: definitely not JSON"),
			)
			.mockResolvedValueOnce(chatResponse('{"grade": 4}'));

		const result = await client.chatCompletion("system", "user");

		expect(result).toEqual({ grade: 4 });
		expect(fetchMock()).toHaveBeenCalledTimes(2);

		const retryCall = fetchMock().mock.calls[1]?.[1] as { body?: string };
		const retryBody = JSON.parse(retryCall.body ?? "{}") as {
			temperature?: number;
			response_format?: { type?: string };
			messages?: Array<{ role: string; content: string }>;
		};
		expect(retryBody.temperature).toBe(0);
		expect(retryBody.response_format).toEqual({ type: "json_object" });
		expect(retryBody.messages?.[0]?.content).toContain("not valid JSON");
		expect(retryBody.messages?.[1]?.content).toContain("Fix this JSON:");
		expect(retryBody.messages?.[1]?.content).toContain("definitely not JSON");
	});

	it("throws with the original content excerpt when the retry also fails", async () => {
		const garbage = "nope, still broken: ".repeat(10);
		fetchMock()
			.mockResolvedValueOnce(chatResponse(garbage))
			.mockResolvedValueOnce(chatResponse("still no json here"));

		await expect(client.chatCompletion("system", "user")).rejects.toThrow(
			/Original content \(first 500 chars\): nope, still broken/,
		);
		expect(fetchMock()).toHaveBeenCalledTimes(2);
	});

	it("throws with the HTTP status when the retry request itself fails", async () => {
		vi.useFakeTimers();
		try {
			// First response is garbage JSON (triggers the repair retry); every
			// subsequent response is a 502 that is now itself retried (1s, 2s,
			// 4s backoff) before the row-level call finally throws.
			fetchMock()
				.mockResolvedValueOnce(chatResponse("not json at all"))
				.mockImplementation(() =>
					Promise.resolve(
						new Response("upstream exploded", {
							status: 502,
							statusText: "Bad Gateway",
						}),
					),
				);

			const rejection = expect(client.chatCompletion("system", "user")).rejects.toThrow(
				/JSON repair retry failed with HTTP status 502/,
			);
			await vi.advanceTimersByTimeAsync(30_000);
			await rejection;
			// 1 original call + 4 repair attempts (3 retries + final throw)
			expect(fetchMock()).toHaveBeenCalledTimes(5);
		} finally {
			vi.useRealTimers();
		}
	});

	it("validates the parsed response against an optional Zod schema", async () => {
		const schema = z.object({ grade: z.number() });
		fetchMock().mockResolvedValueOnce(chatResponse('{"grade": 5}'));

		const result = await client.chatCompletion("system", "user", 0.1, undefined, schema);

		expect(result).toEqual({ grade: 5 });
	});

	it("throws with joined Zod error messages when the schema rejects the response", async () => {
		const schema = z.object({ grade: z.number(), note: z.string() });
		fetchMock().mockImplementation(() => Promise.resolve(chatResponse('{"grade": "five"}')));

		await expect(
			client.chatCompletion("system", "user", 0.1, undefined, schema),
		).rejects.toThrow(/schema validation/);
		await expect(
			client.chatCompletion("system", "user", 0.1, undefined, schema),
		).rejects.toThrow(/Expected number|Invalid input/);
	});

	it("uses a per-call timeoutMs override instead of the instance default", async () => {
		vi.useFakeTimers();
		try {
			// Instance default is 60s; the override must fire at 5s instead.
			let capturedSignal: AbortSignal | undefined;
			fetchMock().mockImplementation((_url: unknown, init?: { signal?: AbortSignal }) => {
				capturedSignal = init?.signal;
				return new Promise((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => {
						const err = new Error("Aborted by timeout");
						err.name = "AbortError";
						reject(err);
					});
				});
			});

			const promise = client.chatCompletion(
				"system",
				"user",
				0.1,
				undefined,
				undefined,
				5_000,
			);
			// Attach the rejection handler BEFORE advancing timers so the
			// abort rejection is never left unhandled.
			const rejection = expect(promise).rejects.toThrow(/timed out/);

			expect(capturedSignal).toBeDefined();
			await vi.advanceTimersByTimeAsync(4_999);
			expect(capturedSignal!.aborted).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			expect(capturedSignal!.aborted).toBe(true);
			// Timeouts are transient-retried: exhaust the bounded attempts
			// (5s per attempt + 1s/2s/4s backoff) before the promise rejects.
			await vi.advanceTimersByTimeAsync(60_000);
			await rejection;
		} finally {
			vi.useRealTimers();
		}
	});

	it("uses the instance default timeout when timeoutMs is omitted", async () => {
		vi.useFakeTimers();
		try {
			const slowClient = new KiConnectClient({ baseUrl: TEST_BASE_URL, timeout: 3_000 });
			let capturedSignal: AbortSignal | undefined;
			fetchMock().mockImplementation((_url: unknown, init?: { signal?: AbortSignal }) => {
				capturedSignal = init?.signal;
				return new Promise((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => {
						const err = new Error("Aborted by timeout");
						err.name = "AbortError";
						reject(err);
					});
				});
			});

			const promise = slowClient.chatCompletion("system", "user");
			// Attach the rejection handler BEFORE advancing timers so the
			// abort rejection is never left unhandled.
			const rejection = expect(promise).rejects.toThrow(/timed out/);

			expect(capturedSignal).toBeDefined();
			await vi.advanceTimersByTimeAsync(2_999);
			expect(capturedSignal!.aborted).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			expect(capturedSignal!.aborted).toBe(true);
			// Timeouts are transient-retried: exhaust the bounded attempts
			// (3s per attempt + 1s/2s/4s backoff) before the promise rejects.
			await vi.advanceTimersByTimeAsync(60_000);
			await rejection;
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("KiConnectClient.listModels", () => {
	let client: KiConnectClient;

	beforeEach(() => {
		vi.stubGlobal("fetch", vi.fn());
		process.env.KI_CONNECT_API_KEY = TEST_API_KEY;
		client = new KiConnectClient({ baseUrl: TEST_BASE_URL });
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		delete process.env.KI_CONNECT_API_KEY;
	});

	function modelsResponse(models: unknown, status = 200): Response {
		return new Response(JSON.stringify({ data: models }), {
			status,
			headers: { "Content-Type": "application/json" },
		});
	}

	it("returns the model list from GET {baseUrl}/models", async () => {
		const models = [
			{
				id: "qwen3-30b-a3b-instruct-2507",
				object: "model",
				created: 1_750_000_000,
				owned_by: "Academiccloud",
				context_length: 262_144,
			},
			{
				id: "gpt-4.1-mini",
				object: "model",
				created: 1_750_000_000,
				owned_by: "Academiccloud",
			},
		];
		fetchMock().mockResolvedValueOnce(modelsResponse(models));

		const result = await client.listModels();

		expect(result).toEqual(models);
		expect(fetchMock()).toHaveBeenCalledTimes(1);
		expect(fetchMock()).toHaveBeenCalledWith(
			`${TEST_BASE_URL}/models`,
			expect.objectContaining({
				method: "GET",
				headers: expect.objectContaining({
					Authorization: `Bearer ${TEST_API_KEY}`,
				}),
			}),
		);
	});

	it("returns an empty array on a non-2xx response", async () => {
		fetchMock().mockResolvedValueOnce(new Response("unauthorized", { status: 401 }));

		await expect(client.listModels()).resolves.toEqual([]);
	});

	it("returns an empty array on network failure", async () => {
		fetchMock().mockRejectedValueOnce(new TypeError("fetch failed"));

		await expect(client.listModels()).resolves.toEqual([]);
	});

	it("returns an empty array when the payload has no data array", async () => {
		fetchMock().mockResolvedValueOnce(modelsResponse({ nope: true }));

		await expect(client.listModels()).resolves.toEqual([]);
	});
});
