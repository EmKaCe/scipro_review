// @vitest-environment node
/**
 * @file Root-layout teacher entrypoint redirect (2.8.0-w2).
 *
 * The teacher build sends users to /onboarding until the core setup items
 * (provider + assignment-wired) are complete OR the wizard was dismissed
 * once (GET /api/onboarding/dismiss → { dismissed }). Non-blocking steps
 * (docs-index, first-pipeline) never gate. Any fetch failure resolves
 * {} — a broken status endpoint must never block the app.
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

type StatusItem = { id: string; done: boolean | null };

/** Core items incomplete (and docs-index/first-pipeline also not done). */
const INCOMPLETE: { items: StatusItem[] } = {
	items: [
		{ id: "create-assignment", done: false },
		{ id: "wire-scoring", done: false },
		{ id: "llm-provider", done: false },
		{ id: "docs-index", done: false },
		{ id: "first-pipeline", done: false },
	],
};

/** Core items done; non-blocking steps (docs-index, first-pipeline) NOT done. */
const COMPLETE_CORE: { items: StatusItem[] } = {
	items: [
		{ id: "create-assignment", done: true },
		{ id: "wire-scoring", done: true },
		{ id: "llm-provider", done: true },
		{ id: "docs-index", done: false },
		{ id: "first-pipeline", done: false },
	],
};

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

/** Script both fetches: status + dismiss read. */
function scriptEndpoints(status: unknown, dismissed: boolean): void {
	const fetchMock = vi.mocked(globalThis.fetch);
	fetchMock.mockImplementation((url: string | URL | Request) => {
		const u = String(url);
		if (u.includes("/api/onboarding/status")) return Promise.resolve(jsonResponse(status));
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
	it("(a) teacher + incomplete core + not dismissed → redirects to /onboarding", async () => {
		scriptEndpoints(INCOMPLETE, false);

		await expect(load(loadEvent("/submissions"))).rejects.toMatchObject({
			status: 307,
			location: "/onboarding",
		});
	});

	it("(b) dismissed:true → no redirect even when core is incomplete", async () => {
		scriptEndpoints(INCOMPLETE, true);

		await expect(load(loadEvent("/submissions"))).resolves.toEqual({});
	});

	it("(c) status fetch network failure → no redirect (never block on a broken endpoint)", async () => {
		fetchMock.mockRejectedValue(new Error("connection refused"));

		await expect(load(loadEvent("/submissions"))).resolves.toEqual({});
	});

	it("(d) status endpoint returns non-ok → no redirect", async () => {
		fetchMock.mockImplementation(() => Promise.resolve(new Response("boom", { status: 500 })));

		await expect(load(loadEvent("/submissions"))).resolves.toEqual({});
	});

	it("(e) never redirects the onboarding route itself or any /api route", async () => {
		for (const path of ["/onboarding", "/onboarding/", "/api/onboarding/status", "/api/backup"]) {
			const result = await load(loadEvent(path));
			expect(result).toEqual({});
		}
		// The URL guard short-circuits BEFORE any status/dismiss fetch.
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("(f) complete core with docs-index/first-pipeline not done → no redirect (non-blocking)", async () => {
		scriptEndpoints(COMPLETE_CORE, false);

		await expect(load(loadEvent("/submissions"))).resolves.toEqual({});
	});

	it("(g) student build (__TEACHER_MODE__ false) → no redirect, no fetches", async () => {
		vi.stubGlobal("__TEACHER_MODE__", false);

		await expect(load(loadEvent("/"))).resolves.toEqual({});
		expect(fetchMock).not.toHaveBeenCalled();
	});
});