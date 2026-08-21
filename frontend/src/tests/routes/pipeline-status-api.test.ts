// @vitest-environment node
/**
 * @file L5 API-contract test for GET /api/pipeline/status — the unified
 * pipeline progress aggregator (batch process + pre-evaluation in one
 * response, so a reloaded dashboard can restore both run trackers).
 */
import { beforeEach, describe, expect, it } from "vitest";

import { GET } from "../../routes/api/pipeline/status/+server";
import { beginProcessRun, resetProcessRun } from "$lib/server/process-progress";
import { beginPreEvalRun, resetPreEvalRun } from "$lib/server/pre-eval-progress";

describe("GET /api/pipeline/status", () => {
	beforeEach(() => {
		resetProcessRun();
		resetPreEvalRun();
	});

	it("aggregates a running process batch with the idle pre-eval record", async () => {
		beginProcessRun("soil_contamination", 5);
		const body = await (await GET()).json();

		expect(body.process.running).toBe(true);
		expect(body.process.total).toBe(5);
		expect(body.process.assignmentId).toBe("soil_contamination");
		expect(body.preEval.running).toBe(false);
		expect(body.anyRunning).toBe(true);
	});

	it("flags anyRunning when pre-evaluation is the active run", async () => {
		beginPreEvalRun("soil_contamination", 4);
		const body = await (await GET()).json();

		expect(body.preEval.running).toBe(true);
		expect(body.preEval.total).toBe(4);
		expect(body.process.running).toBe(false);
		expect(body.anyRunning).toBe(true);
	});

	it("is fully idle when no run is in flight", async () => {
		const body = await (await GET()).json();

		expect(body.process.running).toBe(false);
		expect(body.preEval.running).toBe(false);
		expect(body.anyRunning).toBe(false);
	});
});
