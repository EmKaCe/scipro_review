// @vitest-environment node
/**
 * @file L5 API-contract tests for GET /api/executor/health.
 *
 * Real handler import, executor-client mocked (same pattern as the autofix /
 * process-status route suites). Covers: happy path (raw ExecutorHealth
 * payload passthrough) and transport failure (thrown error → body
 * { ok: false, reachable: false, error } with status 200 — an unreachable
 * executor is a probe RESULT, not a server error; the wizard renders either
 * state from the same status code).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "../../routes/api/executor/health/+server";

// ---------------------------------------------------------------------------
// Executor client mock (the route probes through it)
// ---------------------------------------------------------------------------

const mockClient = vi.hoisted(() => ({
	health: vi.fn(),
}));

vi.mock("$lib/server/executor-client", async (importOriginal) => {
	const actual = await importOriginal<typeof import("$lib/server/executor-client")>();
	return {
		...actual,
		getExecutorClient: () => mockClient,
	};
});

const HEALTH = {
	status: "ok",
	version: "2.8.0",
	data_dir: "/app/data",
	ki_connect_available: true,
};

beforeEach(() => {
	mockClient.health.mockReset();
});

// ---------------------------------------------------------------------------
// GET /api/executor/health
// ---------------------------------------------------------------------------

describe("GET /api/executor/health", () => {
	it("returns the raw health payload when the executor is reachable", async () => {
		mockClient.health.mockResolvedValue(HEALTH);

		const response = await GET();

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(HEALTH);
		expect(mockClient.health).toHaveBeenCalledTimes(1);
	});

	it("returns { ok: false, reachable: false } with status 200 on transport errors", async () => {
		mockClient.health.mockRejectedValue(
			new Error(
				"Executor request failed: http://executor:8000/health: connect ECONNREFUSED 127.0.0.1:8000",
			),
		);

		const response = await GET();

		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			ok: boolean;
			reachable: boolean;
			error: string;
		};
		expect(body.ok).toBe(false);
		expect(body.reachable).toBe(false);
		expect(body.error).toContain("connect ECONNREFUSED");
	});
});
