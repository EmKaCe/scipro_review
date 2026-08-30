/**
 * @file Tests for the persisted wizard dismiss flag + POST /api/onboarding/dismiss.
 *
 * Module coverage (readWizardState / writeDismissed) and the route contract
 * over a temp DATA_DIR via the process.env override — same mechanism as
 * onboarding-status.test.ts. Covers the write/read round-trip (atomic, no
 * leftover staging files), ENOENT → null, corrupt JSON → null, the ok:true
 * route answer with the state file landing, and the 500 path when the state
 * file cannot be written.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { POST } from "../../routes/api/onboarding/dismiss/+server";
import { readWizardState, writeDismissed } from "$lib/server/onboarding-wizard-state";

// ---------------------------------------------------------------------------
// Setup: temp DATA_DIR per test
// ---------------------------------------------------------------------------

let dataDir: string;

function stateFile(): string {
	return path.join(dataDir, "wizard_state.json");
}

beforeEach(async () => {
	dataDir = await mkdtemp(path.join(os.tmpdir(), "scipro-wizard-state-"));
	process.env.DATA_DIR = dataDir;
});

afterEach(async () => {
	delete process.env.DATA_DIR;
	await rm(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

describe("onboarding-wizard-state module", () => {
	it("readWizardState returns null when wizard_state.json does not exist (ENOENT)", async () => {
		expect(await readWizardState()).toBeNull();
	});

	it("readWizardState returns null for a corrupt wizard_state.json", async () => {
		await writeFile(stateFile(), "{ definitely not json !!!");
		expect(await readWizardState()).toBeNull();
	});

	it("readWizardState returns null for JSON that is not a wizard state object", async () => {
		// Missing the `dismissed` boolean — treated as invalid, never thrown.
		await writeFile(stateFile(), JSON.stringify({ dismissedAt: "2026-08-30T00:00:00.000Z" }));
		expect(await readWizardState()).toBeNull();
	});

	it("write/read round-trip persists the dismiss flag atomically", async () => {
		await writeDismissed();

		expect(await readWizardState()).toEqual({ dismissed: true });

		// Only the final file lands — the staging temp file is renamed away.
		expect(await readdir(dataDir)).toEqual(["wizard_state.json"]);

		const raw = JSON.parse(await readFile(stateFile(), "utf-8")) as {
			dismissed: boolean;
			dismissedAt: string;
		};
		expect(raw.dismissed).toBe(true);
		expect(typeof raw.dismissedAt).toBe("string");
		expect(Number.isNaN(Date.parse(raw.dismissedAt))).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// API route
// ---------------------------------------------------------------------------

describe("POST /api/onboarding/dismiss", () => {
	it("persists the dismiss flag and answers ok:true", async () => {
		const resp = await POST();

		expect(resp.status).toBe(200);
		const body = (await resp.json()) as { ok: boolean };
		expect(body.ok).toBe(true);

		// The state file actually landed in DATA_DIR.
		expect(await readWizardState()).toEqual({ dismissed: true });
	});

	it("answers 500 with an error message when the flag cannot be written", async () => {
		// A directory occupying the state-file name makes the atomic rename
		// fail (rename onto a directory → EISDIR) — simulates an unwritable
		// DATA_DIR subtree without relying on file permissions.
		await mkdir(stateFile(), { recursive: true });

		const resp = await POST();
		expect(resp.status).toBe(500);
		const body = (await resp.json()) as { ok: boolean; error: string };
		expect(body.ok).toBe(false);
		expect(typeof body.error).toBe("string");
		expect(body.error.length).toBeGreaterThan(0);
	});
});