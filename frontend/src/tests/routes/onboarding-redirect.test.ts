// @vitest-environment node
/**
 * @file Root-layout teacher entrypoint redirect (2.8.0-w2, gate fixed 2026-08-31).
 *
 * The teacher build sends users to /onboarding until the CORE setup is
 * complete (create-assignment + wire-scoring + llm-provider). The dismiss
 * flag is deliberately NOT consulted: a dismissed-but-incomplete install
 * (stale wizard_state.json, dismissed before the API key was saved) must
 * still land on the wizard, otherwise the teacher is stranded on the
 * dashboard with a misconfiguration banner and no way back.
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

/** Core-complete status payload (all three gating items done). */
const CORE_COMPLETE_ITEMS = [
	{ id: "create-assignment", done: true },
	{ id: "wire-scoring", done: true },
	{ id: "llm-provider", done: true },
	{ id: "docs-index", done: false },
	{ id: "first-pipeline", done: false },
];

/** Core-incomplete status payload (llm-provider missing). */
const CORE_INCOMPLETE_ITEMS = CORE_COMPLETE_ITEMS.map((i) =>
	i.id === "llm-provider" ? { ...i, done: false } : i,
);

/** Script the status probe the redirect consults. */
function scriptStatus(statusItems: unknown): void {
	const fetchMock = vi.mocked(globalThis.fetch);
	fetchMock.mockImplementation((url: string | URL | Request) => {
		const u = String(url);
		if (u.includes("/api/onboarding/status"))
			return Promise.resolve(jsonResponse({ items: statusItems }));
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
	it("(a) teacher + core incomplete → redirects to /onboarding", async () => {
		scriptStatus(CORE_INCOMPLETE_ITEMS);

		await expect(load(loadEvent("/submissions"))).rejects.toMatchObject({
			status: 307,
			location: "/onboarding",
		});
	});

	it("(a2) teacher + core incomplete + root path → onboarding wins over the / → /submissions page redirect", async () => {
		// The root layout runs BEFORE +page.ts, so a fresh install landing
		// on / must see the wizard, never the submissions dashboard.
		scriptStatus(CORE_INCOMPLETE_ITEMS);

		await expect(load(loadEvent("/"))).rejects.toMatchObject({
			status: 307,
			location: "/onboarding",
		});
	});

	it("(b) core complete → no redirect (pre-provisioned install)", async () => {
		// A fully wired data dir (tracked config + env key) must not be
		// forced through the wizard — completeness alone is enough.
		scriptStatus(CORE_COMPLETE_ITEMS);

		await expect(load(loadEvent("/submissions"))).resolves.toEqual({});
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("(c) core incomplete → redirects EVEN when dismissed (stale-dismiss regression)", async () => {
		// The 2026-08-31 fix: a stale wizard_state.json (dismissed:true)
		// must never suppress the wizard while core setup is incomplete.
		// The dismiss endpoint is not even consulted by the redirect.
		scriptStatus(CORE_INCOMPLETE_ITEMS);

		await expect(load(loadEvent("/submissions"))).rejects.toMatchObject({
			status: 307,
			location: "/onboarding",
		});
		// Only the status probe fires — no dismiss fetch on the redirect path.
		const urls = fetchMock.mock.calls.map(([u]) => String(u));
		expect(urls.every((u) => u.includes("/api/onboarding/status"))).toBe(true);
	});

	it("(d) status probe network failure → no redirect (never block on a broken endpoint)", async () => {
		fetchMock.mockRejectedValue(new Error("connection refused"));

		await expect(load(loadEvent("/submissions"))).resolves.toEqual({});
	});

	it("(d2) status endpoint returns non-ok → no redirect", async () => {
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
		// The URL guard short-circuits BEFORE any probe fetch.
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("(g) student build (__TEACHER_MODE__ false) → no redirect, no fetches", async () => {
		vi.stubGlobal("__TEACHER_MODE__", false);

		await expect(load(loadEvent("/"))).resolves.toEqual({});
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
