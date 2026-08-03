/**
 * @file L5 API-contract tests for POST /api/submissions/[id]/autofix.
 *
 * Real temp DATA_DIR (assignments.yaml + metadata on disk), real
 * Request/Response objects, executor-client mocked. Covers: happy path
 * (request translation + response passthrough), skipped suggestions,
 * 400 validation (cellSource/cellError/cellIndex/traceback), 404 mapping
 * (unknown assignment / submission), and executor transport errors.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestEvent } from "@sveltejs/kit";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { upsertSubmission } from "$lib/server/metadata";

import { POST as autofixPOST } from "../../routes/api/submissions/[id]/autofix/+server";

// ---------------------------------------------------------------------------
// Executor client mock (the route proxies to it)
// ---------------------------------------------------------------------------

const mockExecutor = vi.hoisted(() => ({
	suggestAutofix: vi.fn(),
}));

vi.mock("$lib/server/executor-client", async (importOriginal) => {
	const actual = await importOriginal<typeof import("$lib/server/executor-client")>();
	return {
		...actual,
		getExecutorClient: () => mockExecutor,
	};
});

// ---------------------------------------------------------------------------
// Fixtures & helpers
// ---------------------------------------------------------------------------

const ASSIGNMENTS_YAML = `assignments:
  - id: soil_contamination
    title: Soil Contamination by Factories
    enabled: true
    criteria_files: []
    dimensions: []
`;

const ASSIGNMENT = "soil_contamination";
const STUDENT = "2026SS_38";

function jsonRequest(
	body: unknown,
	url = `http://localhost/api/submissions/${STUDENT}/autofix`,
): Request {
	return new Request(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

function asEvent(request: Request): RequestEvent {
	const id = request.url.split("/").at(-2) ?? STUDENT;
	return { request, url: new URL(request.url), params: { id } } as unknown as RequestEvent;
}

const VALID_BODY = {
	cellIndex: 3,
	cellSource: "df['cluster'] = kmeans.fit_predict(scaled_data)",
	cellError: "NameError: name 'scaled_data' is not defined",
	traceback: [
		"Traceback (most recent call last):",
		"NameError: name 'scaled_data' is not defined",
	],
};

const SUGGESTION = {
	skipped: false,
	suggestion: "df['cluster'] = kmeans.fit_predict(scaled)",
	explanation: "Replace scaled_data with scaled (Cell 3 variable name).",
	confidence: 0.92,
	fixType: "name_fix",
	patchedSource: "df['cluster'] = kmeans.fit_predict(scaled)\n",
	syntaxValid: true,
};

let dataDir: string;

beforeEach(async () => {
	dataDir = await mkdtemp(path.join(os.tmpdir(), "scipro-autofix-"));
	process.env.DATA_DIR = dataDir;
	await writeFile(path.join(dataDir, "assignments.yaml"), ASSIGNMENTS_YAML, "utf-8");
	await upsertSubmission(ASSIGNMENT, STUDENT, {
		notebookPath: `submissions/${ASSIGNMENT}/${STUDENT}.ipynb`,
	});

	mockExecutor.suggestAutofix.mockReset();
	mockExecutor.suggestAutofix.mockResolvedValue(SUGGESTION);
});

afterEach(async () => {
	delete process.env.DATA_DIR;
	await rm(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// POST /api/submissions/[id]/autofix
// ---------------------------------------------------------------------------

describe("POST /api/submissions/[id]/autofix", () => {
	it("proxies the cell to the executor and returns the suggestion", async () => {
		const response = await autofixPOST(asEvent(jsonRequest(VALID_BODY)));

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(SUGGESTION);
		expect(mockExecutor.suggestAutofix).toHaveBeenCalledTimes(1);
		expect(mockExecutor.suggestAutofix).toHaveBeenCalledWith({
			cellSource: VALID_BODY.cellSource,
			cellError: VALID_BODY.cellError,
			cellIndex: 3,
			traceback: VALID_BODY.traceback,
			assignmentId: ASSIGNMENT,
		});
	});

	it("passes a skipped suggestion through unchanged (KI Connect unavailable)", async () => {
		mockExecutor.suggestAutofix.mockResolvedValue({
			skipped: true,
			suggestion: null,
			explanation: null,
			confidence: null,
			fixType: null,
			patchedSource: null,
			syntaxValid: null,
		});

		const response = await autofixPOST(asEvent(jsonRequest(VALID_BODY)));

		expect(response.status).toBe(200);
		const body = (await response.json()) as { skipped: boolean };
		expect(body.skipped).toBe(true);
	});

	it("omits cellIndex/traceback when absent", async () => {
		const response = await autofixPOST(
			asEvent(jsonRequest({ cellSource: "x = 1", cellError: "boom" })),
		);

		expect(response.status).toBe(200);
		expect(mockExecutor.suggestAutofix).toHaveBeenCalledWith({
			cellSource: "x = 1",
			cellError: "boom",
			cellIndex: undefined,
			traceback: null,
			assignmentId: ASSIGNMENT,
		});
	});

	it("returns 400 for missing/invalid cellSource, cellError, cellIndex, traceback", async () => {
		await expect(
			autofixPOST(asEvent(jsonRequest({ cellError: "boom" }))),
		).rejects.toMatchObject({
			status: 400,
		});
		await expect(
			autofixPOST(asEvent(jsonRequest({ cellSource: "", cellError: "boom" }))),
		).rejects.toMatchObject({ status: 400 });
		await expect(
			autofixPOST(asEvent(jsonRequest({ cellSource: "x", cellError: "" }))),
		).rejects.toMatchObject({ status: 400 });
		await expect(
			autofixPOST(
				asEvent(jsonRequest({ cellSource: "x", cellError: "boom", cellIndex: 1.5 })),
			),
		).rejects.toMatchObject({ status: 400 });
		await expect(
			autofixPOST(
				asEvent(
					jsonRequest({ cellSource: "x", cellError: "boom", traceback: "not-array" }),
				),
			),
		).rejects.toMatchObject({ status: 400 });
		await expect(autofixPOST(asEvent(jsonRequest("not json")))).rejects.toMatchObject({
			status: 400,
		});
	});

	it("returns 404 for an unknown assignment or submission", async () => {
		await expect(
			autofixPOST(
				asEvent(
					jsonRequest(
						VALID_BODY,
						`http://localhost/api/submissions/${STUDENT}/autofix?assignment=nope`,
					),
				),
			),
		).rejects.toMatchObject({ status: 404 });

		await expect(
			autofixPOST(
				asEvent(
					jsonRequest(VALID_BODY, "http://localhost/api/submissions/2026SS_99/autofix"),
				),
			),
		).rejects.toMatchObject({ status: 404 });
	});

	it("propagates executor transport failures", async () => {
		mockExecutor.suggestAutofix.mockRejectedValue(
			new Error("Executor request failed: http://executor:8766/autofix"),
		);

		await expect(autofixPOST(asEvent(jsonRequest(VALID_BODY)))).rejects.toThrow(
			"Executor request failed",
		);
	});
});
