// @vitest-environment node
/**
 * @file L5 API-contract tests for POST /api/copilot/approval (SSE approval
 * pipe).
 *
 * Agent module mocked (vi.mock('$lib/server/copilot/agent')); real
 * Request/Response. Covers: 400 validation, event piping as bare SSE frames,
 * 404 for runIds the chat route never advertised (pre-check against
 * _knownApprovalRunIds), and 409 for already-resolved runIds (known, but the
 * agent reports no pending approval — a second POST or a TTL expiry).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "../../routes/api/copilot/approval/+server";
import { _knownApprovalRunIds } from "../../routes/api/copilot/chat/+server";
import { approveRun } from "$lib/server/copilot/agent";

vi.mock("$lib/server/copilot/agent", () => ({
	streamChat: vi.fn(),
	approveRun: vi.fn(),
}));

const mockedApproveRun = vi.mocked(approveRun);

const VALID_BODY = { runId: "run-1", toolCallId: "call-1", decision: "approve" as const };

function approvalRequest(body: unknown): Request {
	return new Request("http://localhost/api/copilot/approval", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

async function postApproval(body: unknown): Promise<Response> {
	return POST({ request: approvalRequest(body) } as never);
}

async function readAll(response: Response): Promise<string> {
	const reader = response.body!.getReader();
	const decoder = new TextDecoder();
	let out = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		out += decoder.decode(value, { stream: true });
	}
	return out + decoder.decode();
}

beforeEach(() => {
	vi.clearAllMocks();
	_knownApprovalRunIds.clear();
	// Seed a run the chat route advertised via an approval-request frame.
	_knownApprovalRunIds.add("run-1");
});

afterEach(() => {
	_knownApprovalRunIds.clear();
});

describe("POST /api/copilot/approval", () => {
	it("rejects a decision other than approve|deny (400)", async () => {
		await expect(
			postApproval({ runId: "run-1", toolCallId: "call-1", decision: "maybe" }),
		).rejects.toMatchObject({ status: 400 });
		expect(mockedApproveRun).not.toHaveBeenCalled();
	});

	it("rejects missing runId or toolCallId (400)", async () => {
		await expect(postApproval({ runId: "run-1", decision: "approve" })).rejects.toMatchObject({
			status: 400,
		});
		await expect(
			postApproval({ toolCallId: "call-1", decision: "approve" }),
		).rejects.toMatchObject({ status: 400 });
		expect(mockedApproveRun).not.toHaveBeenCalled();
	});

	it("pipes agent events as bare SSE frames and forwards the decision", async () => {
		mockedApproveRun.mockResolvedValueOnce(
			(async function* () {
				yield { type: "done" };
			})(),
		);

		const response = await postApproval(VALID_BODY);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("text/event-stream");
		expect(response.headers.get("cache-control")).toBe("no-cache");
		expect(response.headers.get("connection")).toBe("keep-alive");

		expect(mockedApproveRun).toHaveBeenCalledTimes(1);
		expect(mockedApproveRun).toHaveBeenCalledWith(VALID_BODY);
		expect(await readAll(response)).toBe("done\n\n");
	});

	it("returns an empty SSE response when the approval resolves cleanly", async () => {
		// Real contract: approveRun's iterable is empty on success — the
		// continuation frames arrive on the original chat stream.
		mockedApproveRun.mockResolvedValueOnce((async function* () {})());

		const response = await postApproval(VALID_BODY);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("text/event-stream");
		expect(await readAll(response)).toBe("");
	});

	it("404s on a runId the chat route never advertised", async () => {
		await expect(
			postApproval({ runId: "run-ghost", toolCallId: "call-1", decision: "approve" }),
		).rejects.toMatchObject({ status: 404 });
		expect(mockedApproveRun).not.toHaveBeenCalled();
	});

	it("409s on a second decision for an already-resolved run", async () => {
		// Known runId, but the agent reports no pending approval — the run was
		// already resolved (double POST or approval TTL expiry).
		mockedApproveRun.mockResolvedValueOnce(
			(async function* () {
				yield {
					type: "error",
					message: 'No pending approval found for run "run-1" and tool call "call-1"',
				};
				yield { type: "done" };
			})(),
		);

		await expect(postApproval(VALID_BODY)).rejects.toMatchObject({ status: 409 });
		expect(mockedApproveRun).toHaveBeenCalledTimes(1);
		expect(mockedApproveRun).toHaveBeenCalledWith(VALID_BODY);
	});
});
