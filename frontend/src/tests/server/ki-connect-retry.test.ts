/**
 * KI Connect client — 429 rate-limit retry behavior.
 *
 * The client must survive transient 429s (a batch run hits the deployment's
 * burst limit under concurrency) by retrying with backoff instead of failing
 * the row. This exercises the REAL client with a mocked global fetch.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { KiConnectClient } from "$lib/server/ki-connect";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function okResponse(): Response {
	return new Response(JSON.stringify({ choices: [{ message: { content: "hello" } }] }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

function rateLimited(retryAfterSec?: number): Response {
	return new Response("rate limited", {
		status: 429,
		headers: retryAfterSec ? { "Retry-After": String(retryAfterSec) } : {},
	});
}

afterEach(() => {
	mockFetch.mockReset();
	vi.useRealTimers();
});

describe("KiConnectClient 429 retry", () => {
	it("retries a 429 and succeeds on the next attempt", async () => {
		mockFetch.mockResolvedValueOnce(rateLimited()).mockResolvedValueOnce(okResponse());

		const client = new KiConnectClient({ apiKey: "test-key", baseUrl: "http://example.test" });
		const result = await client.chatCompletionText("sys", "user");

		expect(result).toBe("hello");
		expect(mockFetch).toHaveBeenCalledTimes(2);
	});

	it("throws after MAX_ATTEMPTS consecutive 429s", async () => {
		vi.useFakeTimers();
		mockFetch.mockResolvedValue(rateLimited());

		const client = new KiConnectClient({ apiKey: "test-key", baseUrl: "http://example.test" });
		const promise = client.chatCompletionText("sys", "user");
		// Attach a no-op handler immediately so the eventual rejection is
		// never flagged as unhandled while fake timers advance.
		promise.catch(() => undefined);

		// 4 attempts with backoff (1s, 2s, 4s) — advance past all of them.
		await vi.advanceTimersByTimeAsync(10000);
		await expect(promise).rejects.toThrow("KI Connect: rate limited (429)");
		// 4 attempts (3 retries + final throw)
		expect(mockFetch).toHaveBeenCalledTimes(4);
	});

	it("respects Retry-After for the backoff delay", async () => {
		vi.useFakeTimers();
		mockFetch.mockResolvedValueOnce(rateLimited(2)).mockResolvedValueOnce(okResponse());

		const client = new KiConnectClient({ apiKey: "test-key", baseUrl: "http://example.test" });
		const promise = client.chatCompletionText("sys", "user");

		// Advance by 1.9s — retry must NOT have fired yet (Retry-After=2s).
		await vi.advanceTimersByTimeAsync(1900);
		expect(mockFetch).toHaveBeenCalledTimes(1);

		// Advance past 2s — retry fires and resolves.
		await vi.advanceTimersByTimeAsync(200);
		await expect(promise).resolves.toBe("hello");
		expect(mockFetch).toHaveBeenCalledTimes(2);
	});
});

describe("KiConnectClient transient-error retry (5xx / network / timeout)", () => {
	it("retries a 5xx server error and succeeds on the next attempt", async () => {
		mockFetch
			.mockResolvedValueOnce(new Response("boom", { status: 502 }))
			.mockResolvedValueOnce(okResponse());

		const client = new KiConnectClient({ baseUrl: "http://example.test" });
		const result = await client.chatCompletionText("sys", "user");

		expect(result).toBe("hello");
		expect(mockFetch).toHaveBeenCalledTimes(2);
	});

	it("throws a descriptive error after repeated 5xx responses", async () => {
		vi.useFakeTimers();
		mockFetch.mockResolvedValue(new Response("bad gateway", { status: 502 }));

		const client = new KiConnectClient({ baseUrl: "http://example.test" });
		const promise = client.chatCompletionText("sys", "user");
		promise.catch(() => undefined);

		await vi.advanceTimersByTimeAsync(10000);
		await expect(promise).rejects.toThrow("KI Connect server error 502");
		// 4 attempts (3 retries + final throw)
		expect(mockFetch).toHaveBeenCalledTimes(4);
	});

	it("retries a network failure (fetch TypeError) and succeeds", async () => {
		mockFetch
			.mockRejectedValueOnce(new TypeError("fetch failed"))
			.mockResolvedValueOnce(okResponse());

		const client = new KiConnectClient({ baseUrl: "http://example.test" });
		const result = await client.chatCompletionText("sys", "user");

		expect(result).toBe("hello");
		expect(mockFetch).toHaveBeenCalledTimes(2);
	});

	it("retries a timed-out request (AbortError) and succeeds", async () => {
		mockFetch
			.mockRejectedValueOnce(Object.assign(new Error("aborted"), { name: "AbortError" }))
			.mockResolvedValueOnce(okResponse());

		const client = new KiConnectClient({ baseUrl: "http://example.test" });
		const result = await client.chatCompletionText("sys", "user");

		expect(result).toBe("hello");
		expect(mockFetch).toHaveBeenCalledTimes(2);
	});

	it("does not retry a 4xx client error", async () => {
		mockFetch.mockResolvedValue(new Response("nope", { status: 400 }));

		const client = new KiConnectClient({ baseUrl: "http://example.test" });
		await expect(client.chatCompletionText("sys", "user")).rejects.toThrow(
			"KI Connect returned 400",
		);
		expect(mockFetch).toHaveBeenCalledTimes(1);
	});
});
