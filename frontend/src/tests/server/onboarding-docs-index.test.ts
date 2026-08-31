/**
 * @file Tests for POST /api/onboarding/docs-index (public docs-index download).
 *
 * child_process.spawn is mocked so no real network or CLI ever runs. Covers:
 * the exact node invocation (--public, --out <DATA_DIR>/docs-index, never
 * build-docs-index, no API key), success/failure surfacing, the 409 concurrency
 * guard, and the already-present short-circuit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

vi.mock("node:child_process", () => {
	const spawnMock = vi.fn();
	return { default: { spawn: spawnMock }, spawn: spawnMock };
});
import { spawn } from "node:child_process";

import { POST } from "../../routes/api/onboarding/docs-index/+server";

// ---------------------------------------------------------------------------
// Fake child process
// ---------------------------------------------------------------------------

interface FakeChild {
	child: EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn> };
	emitStdout: (s: string) => void;
	emitStderr: (s: string) => void;
	close: (code: number) => void;
}

function makeFakeChild(): FakeChild {
	const stdout = new EventEmitter();
	const stderr = new EventEmitter();
	const kill = vi.fn();
	const child = Object.assign(new EventEmitter(), { stdout, stderr, kill });
	return {
		child,
		emitStdout: (s: string) => stdout.emit("data", Buffer.from(s)),
		emitStderr: (s: string) => stderr.emit("data", Buffer.from(s)),
		close: (code: number) => child.emit("close", code, null),
	};
}

// ---------------------------------------------------------------------------
// Setup: temp DATA_DIR per test
// ---------------------------------------------------------------------------

let dataDir: string;
const fakes: FakeChild[] = [];

beforeEach(async () => {
	dataDir = await mkdtemp(path.join(os.tmpdir(), "scipro-docs-index-"));
	process.env.DATA_DIR = dataDir;
	fakes.length = 0;
	vi.mocked(spawn).mockReset();
	const mod = await import("$lib/server/onboarding-docs-index");
	mod.__resetDocsIndexDownloadForTests();
	mod.__resetJobSlotForTests();
});

afterEach(async () => {
	// Settle any download still in flight so the module-level guard resets.
	for (const f of fakes) f.close(0);
	delete process.env.DATA_DIR;
	delete process.env.DOCS_INDEX_DIR;
	await rm(dataDir, { recursive: true, force: true });
});

function mockSpawn(): FakeChild {
	const fake = makeFakeChild();
	fakes.push(fake);
	vi.mocked(spawn).mockReturnValue(fake.child as never);
	return fake;
}

function spawnArgs(): string[] {
	expect(spawn).toHaveBeenCalledTimes(1);
	return vi.mocked(spawn).mock.calls[0]![1] as string[];
}

/** Wait until the module has actually spawned (past its async fs checks). */
async function waitForSpawn(): Promise<void> {
	await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("onboarding-docs-index module", () => {
	it("runs fetch-docs-index.mjs --public into DATA_DIR/docs-index", async () => {
		const fake = mockSpawn();

		const pending = (await import("$lib/server/onboarding-docs-index")).downloadDocsIndex();
		await waitForSpawn();
		fake.emitStdout("[fetch-docs-index] manifest: 38380 chunks, 10 libraries …");
		fake.close(0);
		const result = await pending;

		expect(result.ok).toBe(true);
		expect(result.alreadyPresent).toBe(false);
		expect(result.output).toContain("manifest: 38380 chunks");

		const args = spawnArgs();
		expect(spawn).toHaveBeenCalledWith(
			process.execPath,
			args,
			expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"] }),
		);
		// Exact contract: the PUBLIC fetch only — no gh CLI, no build script.
		expect(args).toEqual([
			expect.stringMatching(/scripts[\\/]fetch-docs-index\.mjs$/),
			"--public",
			"--out",
			path.join(dataDir, "docs-index"),
		]);
		expect(args.join(" ")).not.toContain("build-docs-index");
		expect(args.join(" ")).not.toMatch(/\bgh\b/);
		expect(args.join(" ")).not.toContain("KI_CONNECT");
	});

	it("startDocsIndexDownload returns immediately and tracks byte progress via status", async () => {
		const fake = mockSpawn();
		const mod = await import("$lib/server/onboarding-docs-index");

		const started = await mod.startDocsIndexDownload();
		expect(started).toEqual({ ok: true, alreadyPresent: false });
		// The child spawns a moment later (script resolution is async) —
		// the POST must not block on the download itself.
		await waitForSpawn();

		// Progress lines update the shared status contract (bytes).
		fake.emitStdout("[fetch-docs-index] progress docs-vectors.bin 104857600 629145600\n");
		const mid = await mod.getDocsIndexDownloadStatus();
		expect(mid?.kind).toBe("fetch");
		expect(mid?.phase).toBe("fetch-chunks");
		expect(mid?.done).toBe(104_857_600);
		expect(mid?.total).toBe(629_145_600);

		fake.close(0);
		const done = await mod.getDocsIndexDownloadStatus();
		expect(done?.phase).toBe("done");
		expect(done?.done).toBe(629_145_600);
	});

	it("cancel kills the child and the job reads as cancelled", async () => {
		const fake = mockSpawn();
		const mod = await import("$lib/server/onboarding-docs-index");

		await mod.startDocsIndexDownload();
		await waitForSpawn();
		expect(fake.child.kill).toBeDefined();

		expect(mod.cancelDocsIndexDownload()).toBe(true);
		// The child was killed → close with a non-zero code; the close
		// handler must read the cancel flag and mark the job cancelled.
		fake.close(1);
		const state = await mod.getDocsIndexDownloadStatus();
		expect(state?.phase).toBe("cancelled");
		expect(state?.error).toContain("cancelled");
	});

	it("short-circuits when docs-index.json already exists (no spawn)", async () => {
		await mkdir(path.join(dataDir, "docs-index"), { recursive: true });
		await writeFile(path.join(dataDir, "docs-index", "docs-index.json"), "{}");

		const result = (await import("$lib/server/onboarding-docs-index")).downloadDocsIndex();

		await expect(result).resolves.toMatchObject({ ok: true, alreadyPresent: true });
		expect(spawn).not.toHaveBeenCalled();
	});

	it("rejects concurrent downloads while one is in flight", async () => {
		const fake = mockSpawn();
		const mod = await import("$lib/server/onboarding-docs-index");

		const first = mod.downloadDocsIndex();
		// Wait until the first call has actually spawned (past its fs checks).
		await waitForSpawn();

		await expect(mod.downloadDocsIndex()).rejects.toThrow("already in progress");

		fake.close(0);
		const firstResp = await first;
		expect(firstResp.ok).toBe(true);
		expect(spawn).toHaveBeenCalledTimes(1);
	});

	it("fails with the script's stderr tail on non-zero exit", async () => {
		const fake = mockSpawn();
		const mod = await import("$lib/server/onboarding-docs-index");

		const pending = mod.downloadDocsIndex();
		await waitForSpawn();
		fake.emitStderr("Error: download docs-vectors.bin: HTTP 404");
		fake.close(1);

		await expect(pending).rejects.toThrow("HTTP 404");
	});
});

// ---------------------------------------------------------------------------
// API route
// ---------------------------------------------------------------------------

describe("POST /api/onboarding/docs-index", () => {
	it("returns 200 with ok:true when the fetch succeeds", async () => {
		const fake = mockSpawn();

		const pending = POST();
		await waitForSpawn();
		fake.emitStdout("[fetch-docs-index] done -> " + path.join(dataDir, "docs-index"));
		fake.close(0);
		const resp = await pending;

		expect(resp.status).toBe(200);
		const body = (await resp.json()) as {
			ok: boolean;
			alreadyPresent: boolean;
			output: string;
		};
		expect(body.ok).toBe(true);
		expect(body.alreadyPresent).toBe(false);
		expect(body.output).toContain("done");
	});

	it("returns 200 alreadyPresent without spawning when the index exists", async () => {
		await mkdir(path.join(dataDir, "docs-index"), { recursive: true });
		await writeFile(path.join(dataDir, "docs-index", "docs-index.json"), "{}");

		const resp = await POST();
		expect(resp.status).toBe(200);
		const body = (await resp.json()) as { ok: boolean; alreadyPresent: boolean };
		expect(body.ok).toBe(true);
		expect(body.alreadyPresent).toBe(true);
		expect(spawn).not.toHaveBeenCalled();
	});

	it("returns 409 while another download is in flight", async () => {
		const fake = mockSpawn();

		const first = POST();
		// Wait until the first call has actually spawned (past its fs checks).
		await waitForSpawn();

		const second = await POST();
		expect(second.status).toBe(409);
		const body = (await second.json()) as { ok: boolean; error: string };
		expect(body.ok).toBe(false);
		expect(body.error).toContain("already in progress");

		fake.close(0);
		const firstResp = await first;
		expect(firstResp.status).toBe(200);
	});

	it("returns 500 with the failure detail when the fetch exits non-zero", async () => {
		const fake = mockSpawn();

		const pending = POST();
		await waitForSpawn();
		fake.emitStderr("Error: sha256 mismatch for docs-index.json");
		fake.close(1);
		const resp = await pending;

		expect(resp.status).toBe(500);
		const body = (await resp.json()) as { ok: boolean; error: string };
		expect(body.ok).toBe(false);
		expect(body.error).toContain("sha256 mismatch");
	});
});
