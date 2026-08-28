/**
 * @file L3 unit test — parseMultipartFormData.
 *
 * Regression for the upload bug (2026-08-22): SvelteKit's adapter-node
 * enforces BODY_SIZE_LIMIT (default 512K) by erroring the request stream
 * mid-read; undici's formData() then rejects with the 413 error object
 * verbatim. The old blanket catch mapped it to a misleading 400
 * "Expected a multipart/form-data body". The helper must rethrow the 413
 * with its message and only use the generic 400 for genuinely invalid bodies.
 */

import { describe, expect, it } from "vitest";
import type { RequestEvent } from "@sveltejs/kit";

import { parseMultipartFormData } from "$lib/server/form-data";

/** Build a RequestEvent whose formData() rejects with the given error. */
function eventRejectingWith(err: unknown): RequestEvent {
	const request = {
		formData: async () => {
			throw err;
		},
	} as unknown as Request;
	return { request } as RequestEvent;
}

describe("parseMultipartFormData", () => {
	it("rethrows adapter-node's body-size-limit rejection as a 413 with its message", async () => {
		const limitError = Object.assign(
			new Error("Content-length of 1126400 exceeds limit of 524288 bytes."),
			{ status: 413 },
		);

		const promise = parseMultipartFormData(eventRejectingWith(limitError));

		await expect(promise).rejects.toMatchObject({
			status: 413,
			body: { message: "Content-length of 1126400 exceeds limit of 524288 bytes." },
		});
	});

	it("maps a stream-abort 413 rejection to a 413", async () => {
		const abortError = Object.assign(new Error("request body size exceeded BODY_SIZE_LIMIT"), {
			status: 413,
		});

		const promise = parseMultipartFormData(eventRejectingWith(abortError));

		await expect(promise).rejects.toMatchObject({
			status: 413,
			body: { message: "request body size exceeded BODY_SIZE_LIMIT" },
		});
	});

	it("keeps the generic 400 for a genuinely invalid body", async () => {
		const promise = parseMultipartFormData(
			eventRejectingWith(new TypeError("body used already")),
		);

		await expect(promise).rejects.toMatchObject({
			status: 400,
			body: { message: "Expected a multipart/form-data body" },
		});
	});

	it("uses the route-specific fallback message when provided", async () => {
		const promise = parseMultipartFormData(
			eventRejectingWith(new Error("boom")),
			"Expected multipart form data",
		);

		await expect(promise).rejects.toMatchObject({
			status: 400,
			body: { message: "Expected multipart form data" },
		});
	});
});
