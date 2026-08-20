// @vitest-environment node
/**
 * P12 — unit tests for the recorded-transcript grading-proposal extraction
 * (`eval-transcript.ts`). Fixture parts mirror the ACTUAL recorded V2 message
 * shape (verified 2026-08-19 against `data/copilot/memory/messages/`):
 * `{ format: 2, parts: [{ type: "tool-invocation", toolInvocation: {
 * toolName, args, result, state } }] }`, roles user|assistant|system|signal.
 */

import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, it, expect, afterEach } from "vitest";

import { extractGradingProposals, loadRecordedThreads } from "$lib/server/copilot/eval-transcript";

// ---------------------------------------------------------------------------
// Fixture helpers (mirror the recorded part shape)
// ---------------------------------------------------------------------------

function toolInvocation(toolName: string, args: unknown, result?: unknown) {
	return {
		type: "tool-invocation",
		toolInvocation: { toolName, args, result: result ?? null, state: "result" },
	};
}

function textPart(text: string) {
	return { type: "text", text };
}

/** One assistant message = one turn (V2 content object, real message keys). */
function assistantMessage(parts: unknown[]) {
	return { role: "assistant", content: { format: 2, parts } };
}

const SET_RUBRIC_ARGS = (criterionKey: string, optionKey: string) => ({
	submissionId: "2026SS_00",
	assignmentId: "soil_contamination",
	criterionKey,
	optionKey,
});

const DIMENSION_ARGS = (dimensionId: string, value: number) => ({
	submissionId: "2026SS_00",
	assignmentId: "soil_contamination",
	dimensionId,
	value,
});

const NOTES_ARGS = (notes: string) => ({
	submissionId: "2026SS_00",
	assignmentId: "soil_contamination",
	notes,
});

// ---------------------------------------------------------------------------
// extractGradingProposals
// ---------------------------------------------------------------------------

describe("extractGradingProposals", () => {
	it("groups set-rubric-item + update-grade-dimension + write-notes of one turn into ONE proposal", () => {
		const parts = [
			toolInvocation("get-assignment", { assignmentId: "soil_contamination" }),
			toolInvocation("compare-to-key", { submissionId: "2026SS_00" }),
			toolInvocation("set-rubric-item", SET_RUBRIC_ARGS("assignment_requirements", "complete")),
			toolInvocation("set-rubric-item", SET_RUBRIC_ARGS("code_execution_results", "complete")),
			toolInvocation("update-grade-dimension", DIMENSION_ARGS("code_quality_design", 600)),
			toolInvocation("update-grade-dimension", DIMENSION_ARGS("scientific_programming", 600)),
			toolInvocation("write-notes", NOTES_ARGS("- Excellent work! Your notebook closely follows the reference key.")),
		];

		const proposals = extractGradingProposals(parts);

		expect(proposals).toHaveLength(1);
		expect(proposals[0]).toEqual({
			rubric: {
				assignment_requirements: "complete",
				code_execution_results: "complete",
			},
			dimensions: {
				code_quality_design: 600,
				scientific_programming: 600,
			},
			feedback: "- Excellent work! Your notebook closely follows the reference key.",
		});
	});

	it("a turn with only rubric items yields a proposal with rubric and no dimensions/feedback", () => {
		const parts = [
			toolInvocation("set-rubric-item", SET_RUBRIC_ARGS("clarity", "good")),
			toolInvocation("set-rubric-item", SET_RUBRIC_ARGS("structure", "clear")),
		];

		const proposals = extractGradingProposals(parts);

		expect(proposals).toHaveLength(1);
		expect(proposals[0]).toEqual({
			rubric: { clarity: "good", structure: "clear" },
		});
		expect(proposals[0].dimensions).toBeUndefined();
		expect(proposals[0].feedback).toBeUndefined();
	});

	it("a turn with only non-grading tools produces no proposal", () => {
		const parts = [
			toolInvocation("get-submission-context", { submissionId: "2026SS_00" }),
			toolInvocation("get-assignment", { id: "soil_contamination" }),
			toolInvocation("get-reference-key", { assignmentId: "soil_contamination" }),
			toolInvocation("compare-to-key", { submissionId: "2026SS_00" }),
			toolInvocation("analyze-code", { submissionId: "2026SS_00" }),
		];

		expect(extractGradingProposals(parts)).toEqual([]);
	});

	it("unknown tools are skipped and do not create a proposal", () => {
		const parts = [
			toolInvocation("mystery-tool", { foo: 1 }),
			textPart("thinking out loud"),
			{ type: "step-start", createdAt: 1786312158895, model: "ki-connect.chat/qwen3-30b" },
		];

		expect(extractGradingProposals(parts)).toEqual([]);
	});

	it("draft-notes counts as a grading write (feedback), matching the recorded turn", () => {
		const parts = [
			toolInvocation("draft-notes", { submissionId: "2026SS_00", assignmentId: "soil_contamination" }, {
				notes: "Great work on this assignment!",
			}),
		];

		const proposals = extractGradingProposals(parts);

		expect(proposals).toHaveLength(1);
		expect(proposals[0].feedback).toBe("Great work on this assignment!");
		expect(proposals[0].rubric).toBeUndefined();
		expect(proposals[0].dimensions).toBeUndefined();
	});

	it("falls back to the tool result payload when args lack the field (recorded result shape)", () => {
		// Real recorded result shape: set-rubric-item returns rubricItem; the
		// update-grade-dimension result carries dimension; write-notes returns notes.
		const parts = [
			toolInvocation("set-rubric-item", { submissionId: "2026SS_00" }, {
				rubricItem: { criterionKey: "assignment_requirements", optionKey: "complete" },
			}),
			toolInvocation("update-grade-dimension", { submissionId: "2026SS_00" }, {
				dimension: { dimensionId: "code_quality_design", value: 500 },
			}),
			toolInvocation("write-notes", { submissionId: "2026SS_00" }, {
				notes: "Solid work overall.",
			}),
		];

		const proposals = extractGradingProposals(parts);

		expect(proposals).toHaveLength(1);
		expect(proposals[0]).toEqual({
			rubric: { assignment_requirements: "complete" },
			dimensions: { code_quality_design: 500 },
			feedback: "Solid work overall.",
		});
	});

	it("turns with only text or step-start parts produce nothing", () => {
		expect(extractGradingProposals([])).toEqual([]);
		expect(extractGradingProposals([textPart("hi"), { type: "step-start" }])).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// loadRecordedThreads (temp DATA_DIR with fixture files)
// ---------------------------------------------------------------------------

describe("loadRecordedThreads", () => {
	let tempDir: string | undefined;

	afterEach(async () => {
		if (tempDir) await rm(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	});

	async function seedThread(threadId: string, thread: unknown, messages: unknown[]) {
		if (!tempDir) tempDir = await mkdtemp(path.join(tmpdir(), "eval-transcript-"));
		const threadsDir = path.join(tempDir, "copilot", "memory", "threads");
		const messagesDir = path.join(tempDir, "copilot", "memory", "messages");
		await mkdir(threadsDir, { recursive: true });
		await mkdir(messagesDir, { recursive: true });
		await writeFile(path.join(threadsDir, `${threadId}.json`), JSON.stringify(thread));
		await writeFile(path.join(messagesDir, `${threadId}.json`), JSON.stringify(messages));
	}

	it("loads threads with grading proposals, resolving assignmentId from thread metadata", async () => {
		await seedThread("thread-a", {
			id: "thread-a",
			title: "Can you do a complete check of the submitted assignment?",
			resourceId: "2026SS_00",
			createdAt: "2026-08-09T21:49:00.000Z",
			updatedAt: "2026-08-09T21:51:00.000Z",
			metadata: { assignmentId: "soil_contamination" },
		}, [
			{ role: "user", content: { format: 2, parts: [textPart("check it")] } },
			assistantMessage([
				toolInvocation("compare-to-key", { submissionId: "2026SS_00" }),
				toolInvocation("set-rubric-item", SET_RUBRIC_ARGS("assignment_requirements", "complete")),
				toolInvocation("update-grade-dimension", DIMENSION_ARGS("code_quality_design", 600)),
				toolInvocation("write-notes", NOTES_ARGS("Good work.")),
			]),
		]);

		const evals = await loadRecordedThreads(tempDir);

		expect(evals).toHaveLength(1);
		expect(evals[0].threadId).toBe("thread-a");
		expect(evals[0].title).toContain("check of the submitted assignment");
		expect(evals[0].resourceId).toBe("2026SS_00");
		expect(evals[0].turns).toEqual([2]);
		expect(evals[0].proposals).toHaveLength(1);
		expect(evals[0].proposals[0]).toEqual({
			rubric: { assignment_requirements: "complete" },
			dimensions: { code_quality_design: 600 },
			feedback: "Good work.",
			assignmentId: "soil_contamination",
		});
	});

	it("skips threads with zero grading proposals (e2e-smoke pattern)", async () => {
		await seedThread("e2e-smoke", {
			id: "e2e-smoke",
			title: "",
			resourceId: "2026SS_00",
			createdAt: "2026-08-18T10:00:00.000Z",
			updatedAt: "2026-08-18T10:01:00.000Z",
			metadata: {},
		}, [
			assistantMessage([
				toolInvocation("get-assignment", { id: "soil_contamination" }),
				toolInvocation("get-submission-context", { submissionId: "2026SS_00" }),
				toolInvocation("compare-to-key", { submissionId: "2026SS_00" }),
			]),
		]);

		const evals = await loadRecordedThreads(tempDir);

		expect(evals).toEqual([]);
	});

	it("uses thread metadata assignmentId when present; no fallback guessing without it (privacy: no hard-coded submission map)", async () => {
		await seedThread("with-meta", {
			id: "with-meta",
			title: "meta thread",
			resourceId: "2026SS_00",
			createdAt: "2026-08-19T10:00:00.000Z",
			updatedAt: "2026-08-19T10:01:00.000Z",
			metadata: { assignmentId: "other_assignment" },
		}, [
			assistantMessage([toolInvocation("write-notes", NOTES_ARGS("notes from metadata thread"))]),
		]);
		await seedThread("without-meta", {
			id: "without-meta",
			title: "no-meta thread",
			resourceId: "2026SS_00",
			createdAt: "2026-08-19T10:00:00.000Z",
			updatedAt: "2026-08-19T10:01:00.000Z",
			metadata: {},
		}, [
			assistantMessage([toolInvocation("write-notes", NOTES_ARGS("notes from no-meta thread"))]),
		]);

		const evals = await loadRecordedThreads(tempDir);

		expect(evals).toHaveLength(2);
		const byId = Object.fromEntries(evals.map((e) => [e.threadId, e.proposals[0].assignmentId]));
		// With metadata → metadata wins.
		expect(byId["with-meta"]).toBe("other_assignment");
		// Without metadata → assignmentId is undefined (no hard-coded fallback —
		// real submission IDs were removed from the repo for privacy). The judge
		// simply lacks an assignment grounding rather than guessing one.
		expect(byId["without-meta"]).toBeUndefined();
	});

	it("one proposal per grading turn, in conversation order, with turn numbers", async () => {
		await seedThread("multi-turn", {
			id: "multi-turn",
			title: "multi-turn thread",
			resourceId: "2026SS_00",
			createdAt: "2026-08-19T10:00:00.000Z",
			updatedAt: "2026-08-19T10:05:00.000Z",
			metadata: {},
		}, [
			{ role: "user", content: { format: 2, parts: [textPart("first message")] } },
			assistantMessage([
				toolInvocation("set-rubric-item", SET_RUBRIC_ARGS("assignment_requirements", "complete")),
			]),
			{ role: "user", content: { format: 2, parts: [textPart("more")] } },
			assistantMessage([
				toolInvocation("update-grade-dimension", DIMENSION_ARGS("code_quality_design", 300)),
				toolInvocation("write-notes", NOTES_ARGS("Second turn notes.")),
			]),
		]);

		const evals = await loadRecordedThreads(tempDir);

		expect(evals).toHaveLength(1);
		expect(evals[0].proposals).toHaveLength(2);
		expect(evals[0].turns).toEqual([2, 4]);
		expect(evals[0].proposals[0].rubric).toEqual({ assignment_requirements: "complete" });
		expect(evals[0].proposals[1].dimensions).toEqual({ code_quality_design: 300 });
		expect(evals[0].proposals[1].feedback).toBe("Second turn notes.");
	});

	it("returns [] when the memory dir is missing", async () => {
		const emptyDir = await mkdtemp(path.join(tmpdir(), "eval-transcript-empty-"));
		expect(await loadRecordedThreads(emptyDir)).toEqual([]);
		await rm(emptyDir, { recursive: true, force: true });
	});
});
