/**
 * warnIfUnknownModel — configured-model verification (2.6.1).
 *
 * The configured `llm.model` id must match the KI Connect registry exactly
 * (mixed vendor prefixes — no auto-correction possible). This exercises the
 * memoized warning helper with a stubbed client: warns once on a missing id,
 * stays silent on a known id, stays silent when the registry is unreachable,
 * and never throws.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetKiConnectClient, warnIfUnknownModel } from "$lib/server/ki-connect";

/** Minimal client stub: only listModels is used by the helper. */
function stubClient(ids: string[] | Error) {
	return {
		listModels:
			ids instanceof Error
				? vi.fn().mockRejectedValue(ids)
				: vi.fn().mockResolvedValue(ids.map((id) => ({ id }))),
	};
}

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
	warnSpy.mockRestore();
	resetKiConnectClient();
});

describe("warnIfUnknownModel", () => {
	it("warns once when the configured id is not on the registry", async () => {
		const client = stubClient(["openai-gpt-oss-120b", "qwen3-30b-a3b-instruct-2507"]);
		await warnIfUnknownModel("gpt-oss-120b", client);
		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(String(warnSpy.mock.calls[0][0])).toContain('"gpt-oss-120b"');

		// memoized: a second call with the same id stays silent
		await warnIfUnknownModel("gpt-oss-120b", client);
		expect(warnSpy).toHaveBeenCalledTimes(1);
	});

	it("stays silent when the id IS on the registry", async () => {
		await warnIfUnknownModel("openai-gpt-oss-120b", stubClient(["openai-gpt-oss-120b"]));
		expect(warnSpy).not.toHaveBeenCalled();
	});

	it("stays silent when the registry is unreachable (empty list)", async () => {
		await warnIfUnknownModel("gpt-oss-120b", stubClient([]));
		expect(warnSpy).not.toHaveBeenCalled();
	});

	it("never throws when the client rejects", async () => {
		await expect(
			warnIfUnknownModel("gpt-oss-120b", stubClient(Error("boom"))),
		).resolves.toBeUndefined();
		expect(warnSpy).not.toHaveBeenCalled();
	});

	it("warns for a second distinct unknown id", async () => {
		const client = stubClient(["openai-gpt-oss-120b"]);
		await warnIfUnknownModel("gpt-oss-120b", client);
		await warnIfUnknownModel("mistral-small", client);
		expect(warnSpy).toHaveBeenCalledTimes(2);
	});
});
