// @vitest-environment node
/**
 * @file Unit tests for the file-backed turn-snapshot store (P3 —
 * per-submission checkpoints). Every test runs against a fresh temp
 * DATA_DIR; restart persistence is simulated by re-instantiating the
 * store functions over the same directory.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	deleteThreadCheckpoints,
	listCheckpoints,
	loadCheckpoint,
	saveCheckpoint,
	type GradingSnapshot,
} from "$lib/server/copilot/checkpoint-store";

let dataDir: string;

beforeEach(async () => {
	dataDir = await mkdtemp(path.join(tmpdir(), "copilot-checkpoint-"));
	process.env.DATA_DIR = dataDir;
});

afterEach(async () => {
	await rm(dataDir, { recursive: true, force: true });
});

function snapshot(overrides: Partial<GradingSnapshot> = {}): GradingSnapshot {
	return {
		rubric: { clarity: "good" },
		dimensions: { code_quality_design: 2 },
		notes: "Nice work overall",
		feedback: {
			clarity: {
				checked: ["Uses readable variable names"],
				comments: {},
				deductions: {},
				notes: "",
			},
		},
		...overrides,
	};
}

describe("checkpoint-store (P3)", () => {
	it("round-trips a snapshot through saveCheckpoint/loadCheckpoint", async () => {
		const snap = snapshot();
		await saveCheckpoint("thread-1", "turn-1", snap);

		const got = await loadCheckpoint("thread-1", "turn-1");
		expect(got).toEqual(snap);
	});

	it("persists to DATA_DIR/copilot/checkpoints/<threadId>/<turnId>.json", async () => {
		await saveCheckpoint("thread-1", "turn-1", snapshot());

		const file = path.join(
			dataDir,
			"copilot",
			"checkpoints",
			"thread-1",
			"turn-1.json",
		);
		const raw = await readFile(file, "utf8");
		expect(JSON.parse(raw)).toEqual(snapshot());
	});

	it("returns null for a missing checkpoint (missing file)", async () => {
		expect(await loadCheckpoint("thread-1", "never-saved")).toBeNull();
		// A thread dir that exists but has no matching turn file also yields null.
		await saveCheckpoint("thread-1", "turn-1", snapshot());
		expect(await loadCheckpoint("thread-1", "turn-2")).toBeNull();
	});

	it("lists the turn ids that have checkpoints for a thread", async () => {
		expect(await listCheckpoints("thread-1")).toEqual([]);

		await saveCheckpoint("thread-1", "turn-b", snapshot());
		await saveCheckpoint("thread-1", "turn-a", snapshot());
		await saveCheckpoint("thread-2", "other", snapshot());

		expect(await listCheckpoints("thread-1")).toEqual(["turn-a", "turn-b"]);
		expect(await listCheckpoints("thread-2")).toEqual(["other"]);
		expect(await listCheckpoints("thread-3")).toEqual([]);
	});

	it("overwrites an existing checkpoint for the same (threadId, turnId)", async () => {
		await saveCheckpoint("thread-1", "turn-1", snapshot({ notes: "first" }));
		await saveCheckpoint("thread-1", "turn-1", snapshot({ notes: "second" }));

		expect((await loadCheckpoint("thread-1", "turn-1"))?.notes).toBe("second");
	});

	it("deleteThreadCheckpoints removes the thread's checkpoint directory", async () => {
		await saveCheckpoint("thread-1", "turn-1", snapshot());
		await deleteThreadCheckpoints("thread-1");

		expect(await loadCheckpoint("thread-1", "turn-1")).toBeNull();
		expect(await listCheckpoints("thread-1")).toEqual([]);
		// Deleting a thread with no checkpoints is a no-op.
		await deleteThreadCheckpoints("thread-2");
	});

	it("rejects unsafe thread/turn ids (traversal guard)", async () => {
		await expect(saveCheckpoint("../evil", "turn-1", snapshot())).rejects.toThrow();
		await expect(saveCheckpoint("thread-1", "../evil", snapshot())).rejects.toThrow();
		await expect(loadCheckpoint("thread-1", "a/b")).rejects.toThrow();
		await expect(listCheckpoints("a/b")).rejects.toThrow();
	});
});
