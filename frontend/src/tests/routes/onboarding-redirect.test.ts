// @vitest-environment node
/**
 * @file Root-layout teacher entrypoint redirect (2.8.0-w2).
 *
 * The teacher build sends users to /onboarding until the wizard was
 * dismissed once (GET /api/onboarding/dismiss → { dismissed }). Setup
 * completeness deliberately does NOT gate the redirect: a pre-provisioned
 * install (existing data dir, tracked config already wired) would never
 * see the wizard otherwise — the "show once per fresh setup" semantics
 * live entirely in the dismiss flag. Any fetch failure resolves {} — a
 * broken dismiss endpoint must never block the app.
 *
 * Mocks: $app/environment (dev) + $app/paths (base) via vi.mock;
 * `__TEACHER_MODE__` via vi.stubGlobal (vitest applies no define — the
 * identifier stays a runtime global, exactly why the layout reads it with
 * a typeof guard, same pattern as copilot-store's apiMode).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$app/environment", () => ({ dev: false }));
vi.mock("$app/paths", () => ({ base: "" }));

import { load } from "../../routes/+layout";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

/** A minimal valid load-event stand-in carrying only the URL. */
function loadEvent(path = "/"): Parameters<typeof load>[0] {
	return { url: new URL(`http://localhost${path}`) } as Parameters<typeof load>[0];
}

/** Script the dismiss read. */
function scriptDismiss(dismissed: boolean): void {
	const fetchMock = vi.mocked(globalThis.fetch);
	fetchMock.mockImplementation((url: string | URL | Request) => {
		const u = String(url);
		if (u.includes("/api/onboarding/dismiss"))
			return Promise.resolve(jsonResponse({ dismissed }));
		return Promise.reject(new Error(`unexpected fetch: ${u}`));
	});
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
	vi.stubGlobal("__TEACHER_MODE__", true);
	fetchMock = vi.fn();
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// The redirect contract
// ---------------------------------------------------------------------------

describe("root layout — teacher entrypoint redirect (2.8.0-w2)", () => {
	it("(a) teacher + not dismissed → redirects to /onboarding", async () => {
		scriptDismiss(false);

		await expect(load(loadEvent("/submissions"))).rejects.toMatchObject({
			status: 307,
			location: "/onboarding",
		});
	});

	it("(b) dismissed:true → no redirect (the once-per-setup semantics)", async () => {
		scriptDismiss(true);

		await expect(load(loadEvent("/submissions"))).resolves.toEqual({});
	});

	it("(b2) dismissed:true → no redirect EVEN when setup is fully complete", async () => {
		// The pre-provisioned-install regression: an existing configured
		// data dir must not suppress the wizard's first visit.
		scriptDismiss(true);

		await expect(load(loadEvent("/submissions"))).resolves.toEqual({});
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("(c) dismiss probe network failure → no redirect (never block on a broken endpoint)", async () => {
		fetchMock.mockRejectedValue(new Error("connection refused"));

		await expect(load(loadEvent("/submissions"))).resolves.toEqual({});
	});

	it("(d) dismiss endpoint returns non-ok → no redirect", async () => {
		fetchMock.mockImplementation(() => Promise.resolve(new Response("boom", { status: 500 })));

		await expect(load(loadEvent("/submissions"))).resolves.toEqual({});
	});

	it("(e) never redirects the onboarding route itself or any /api route", async () => {
		for (const path of [
			"/onboarding",
			"/onboarding/",
			"/api/onboarding/status",
			"/api/backup",
		]) {
			const result = await load(loadEvent(path));
			expect(result).toEqual({});
		}
		// The URL guard short-circuits BEFORE any dismiss fetch.
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("(g) student build (__TEACHER_MODE__ false) → no redirect, no fetches", async () => {
		vi.stubGlobal("__TEACHER_MODE__", false);

		await expect(load(loadEvent("/"))).resolves.toEqual({});
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
