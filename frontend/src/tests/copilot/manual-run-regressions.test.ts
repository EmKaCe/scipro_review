// @vitest-environment node
/**
 * @file Regression tests for the copilot manual-run fixes (2026-08-09):
 * 1. The submission detail route serves the stored preEval envelope in the
 *    camelCase wire shape (it previously omitted preEval entirely, so the
 *    reference comparison showed its pending notice forever).
 * 2. The copilot tool wrapper grounds tool args in the review context
 *    (ctx submissionId/assignmentId override hallucinated model ids).
 */

import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockModel, mockControl } = vi.hoisted(() => {
	const mockControl = { script: [] as Array<Array<Record<string, unknown>>> };
	const mockModel = {
		specificationVersion: "v2",
		provider: "mock",
		modelId: "mock-model",
		async doStream() {
			const parts = mockControl.script.shift() ?? [
				{ type: "stream-start" },
				{ type: "text-start" },
				{ type: "text-delta", delta: "ok" },
				{ type: "text-end" },
				{
					type: "finish",
					finishReason: "stop",
					usage: { inputTokens: 1, outputTokens: 1 },
				},
			];
			return {
				stream: new ReadableStream({
					start(c) {
						for (const p of parts) c.enqueue(p);
						c.close();
					},
				}),
			};
		},
	};
	return { mockModel, mockControl };
});

vi.mock("@ai-sdk/openai-compatible", () => ({
	createOpenAICompatible: () => ({ chatModel: () => mockModel }),
}));

import { z } from "zod";

import { __resetAgentForTests, registry, streamChat } from "$lib/server/copilot/agent";
import { GET as detailGET } from "../../routes/api/submissions/[id]/+server";

let dataDir: string;

beforeEach(async () => {
	dataDir = await mkdtemp(path.join(tmpdir(), "copilot-regression-"));
	process.env.DATA_DIR = dataDir;
	mockControl.script = [];
	__resetAgentForTests();
});

afterEach(async () => {
	__resetAgentForTests();
	await rm(dataDir, { recursive: true, force: true });
});

describe("copilot manual-run regressions", () => {
	it("grounds tool args in the review context (ctx wins over hallucinated ids)", async () => {
		// Fixture: the submission must exist so the server can resolve its
		// assignment (per-submission chats don't send assignmentId).
		const subDir = path.join(dataDir, "submissions", "soil_contamination");
		await mkdir(subDir, { recursive: true });
		await writeFile(
			path.join(subDir, "metadata.json"),
			JSON.stringify({
				"2026SS_00": {
					id: "2026SS_00",
					studentId: "2026SS_00",
					assignmentId: "soil_contamination",
					createdAt: "2026-08-07T13:02:52.411Z",
					fileName: "2026SS_00.ipynb",
					notebookPath: "submissions/soil_contamination/2026SS_00.ipynb",
					status: "executed",
				},
			}),
		);
		await writeFile(
			path.join(dataDir, "assignments.yaml"),
			"assignments:\n  - id: soil_contamination\n    title: Soil Contamination\n    enabled: true\n    criteria_files: []\n    dimensions:\n      - code_quality_design\n",
		);
		let received: Record<string, unknown> | null = null;
		registry.register({
			name: "grounding_probe_tool",
			description: "records its args",
			permission: "auto",
			inputSchema: z.object({
				submissionId: z.string().optional(),
				assignmentId: z.string().optional(),
				notes: z.string(),
			}),
			run: async (args: Record<string, unknown>) => {
				received = args;
				return { ok: true };
			},
		});
		mockControl.script = [
			[
				{ type: "stream-start" },
				{
					type: "tool-call",
					toolCallId: "call_g",
					toolName: "grounding_probe_tool",
					input: JSON.stringify({
						submissionId: "hallucinated_sub",
						assignmentId: "hallucinated_assign",
						notes: "hi",
					}),
				},
				{
					type: "finish",
					finishReason: "tool-calls",
					usage: { inputTokens: 1, outputTokens: 1 },
				},
			],
			[
				{ type: "stream-start" },
				{ type: "text-start" },
				{ type: "text-delta", delta: "done" },
				{ type: "text-end" },
				{
					type: "finish",
					finishReason: "stop",
					usage: { inputTokens: 1, outputTokens: 1 },
				},
			],
		];

		const stream = await streamChat({ submissionId: "2026SS_00", message: "ground" });
		for await (const _ev of stream) {
			// consume
		}

		expect(received).not.toBeNull();
		const r = received as unknown as Record<string, unknown>;
		expect(r.submissionId).toBe("2026SS_00");
		expect(r.assignmentId).toBe("soil_contamination");
		expect(r.notes).toBe("hi");
	});

	it("serves the stored preEval envelope from the submission detail route (camelCase)", async () => {
		// Fixture: one submission + stored results with a preEval block.
		const subDir = path.join(dataDir, "submissions", "soil_contamination");
		await mkdir(subDir, { recursive: true });
		await writeFile(
			path.join(subDir, "metadata.json"),
			JSON.stringify({
				"2026SS_00": {
					id: "2026SS_00",
					studentId: "2026SS_00",
					assignmentId: "soil_contamination",
					createdAt: "2026-08-07T13:02:52.411Z",
					fileName: "2026SS_00.ipynb",
					notebookPath: "submissions/soil_contamination/2026SS_00.ipynb",
					status: "pre-evaluated",
				},
			}),
		);
		await writeFile(
			path.join(subDir, "results.json"),
			JSON.stringify({
				"2026SS_00": {
					success: true,
					cells: [],
					preEval: {
						markers: [
							{ cell_index: 0, marker: "same", reason: "identical goal cell" },
							{
								cell_index: 1,
								marker: "questionable",
								reason: "slightly different imports",
							},
						],
						gradeSuggestion: {
							dimensions: { code_quality_design: 18 },
							justification: "follows the key",
						},
						feedbackDraft: "Well done.",
						notebookSummary: "A soil contamination analysis.",
						evaluatedAt: "2026-08-09T15:08:31.675Z",
					},
				},
			}),
		);
		await writeFile(
			path.join(dataDir, "assignments.yaml"),
			"assignments:\n  - id: soil_contamination\n    title: Soil Contamination\n    enabled: true\n    criteria_files: []\n    dimensions:\n      - code_quality_design\n",
		);

		const event = {
			params: { id: "2026SS_00" },
			url: new URL(
				"http://localhost/api/submissions/2026SS_00?assignment=soil_contamination",
			),
			request: new Request("http://localhost/api/submissions/2026SS_00"),
		} as unknown as Parameters<typeof detailGET>[0];
		const res = await detailGET(event);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		const preEval = body.preEval as Record<string, unknown>;
		expect(preEval).toBeDefined();
		const markers = preEval.markers as Array<Record<string, unknown>>;
		expect(markers).toHaveLength(2);
		expect(markers[0]).toEqual({
			cellIndex: 0,
			marker: "same",
			reason: "identical goal cell",
		});
		expect((preEval.gradeSuggestion as Record<string, unknown>).dimensions).toEqual({
			code_quality_design: 18,
		});
	});
});
