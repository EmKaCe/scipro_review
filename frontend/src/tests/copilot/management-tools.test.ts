/**
 * @file Unit tests for the copilot management tools (management-tools.ts).
 *
 * Registers the four write tools (create/update/delete-assignment,
 * update-settings) into a fresh createRegistry() with a real temp DATA_DIR
 * fixture (assignments.yaml). Covers: create persisting the file + rejecting
 * invalid ids, partial update preserving unspecified fields, delete being
 * declared destructive + the 409 submissions guard, the update-settings
 * writeSettings/loadSettings round trip, the secret rejection (key-like
 * fields never reach the file), and the approval permission on all four.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadAssignmentsRegistry } from "$lib/server/assignments";
import { HARD_DENY } from "$lib/server/copilot/permission";
import { createRegistry, type ToolContext } from "$lib/server/copilot/registry";
import { registerManagementTools } from "$lib/server/copilot/tools/management-tools";
import { loadSettings, writeSettings, type AppSettings } from "$lib/server/settings";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ASSIGNMENTS_YAML = `course_name: Scientific Programming
semester: 2026SS
assignments:
  - id: soil_contamination
    title: Soil Contamination by Factories
    enabled: true
    criteria_files:
      - data/criteria/general.yaml
    dimensions:
      - code_quality_design
`;

const VALID_SETTINGS: AppSettings = {
	executor: { requestTimeoutMs: 30_000, notebookTimeoutMs: 120_000, cellTimeoutS: 30 },
	llm: {
		baseUrl: "https://chat.kiconnect.nrw/api/v1",
		model: "qwen3-30b-a3b-instruct-2507",
		timeoutMs: 60_000,
	},
	copilot: {
		mode: "ask",
		allowedTools: [],
		denyTools: [],
		approvalTtlSeconds: 60,
		sessionCap: 20,
	},
};

let dataDir: string;

beforeEach(async () => {
	dataDir = await mkdtemp(path.join(os.tmpdir(), "scipro-management-tools-"));
	vi.stubEnv("DATA_DIR", dataDir);
	await writeFile(path.join(dataDir, "assignments.yaml"), ASSIGNMENTS_YAML);
});

afterEach(async () => {
	vi.unstubAllEnvs();
	await rm(dataDir, { recursive: true, force: true });
});

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
	return { signal: new AbortController().signal, ...overrides };
}

function registeredTools() {
	const registry = createRegistry();
	registerManagementTools(registry);
	return registry;
}

// ---------------------------------------------------------------------------
// Registration + permissions
// ---------------------------------------------------------------------------

describe("registerManagementTools", () => {
	it("registers the four management tools, all with approval permission", () => {
		const registry = registeredTools();
		const names = registry.list().map((t) => t.name);
		expect(names).toEqual(
			expect.arrayContaining([
				"create-assignment",
				"update-assignment",
				"delete-assignment",
				"update-settings",
			]),
		);

		for (const name of [
			"create-assignment",
			"update-assignment",
			"delete-assignment",
			"update-settings",
		]) {
			expect(registry.get(name).permission).toBe("approval");
		}
	});

	it("declares delete-assignment destructive (HARD_DENY semantics)", () => {
		const registry = registeredTools();
		expect(registry.get("delete-assignment").destructive).toBe(true);
		expect(HARD_DENY).toContain("delete-assignment");
	});
});

// ---------------------------------------------------------------------------
// create-assignment
// ---------------------------------------------------------------------------

describe("create-assignment", () => {
	it("writes the assignment to assignments.yaml and returns the created entry", async () => {
		const registry = registeredTools();
		const created = (await registry.run(
			"create-assignment",
			{
				id: "quantum_mechanics",
				title: "Quantum Mechanics",
				enabled: true,
				dimensions: ["code_quality_design", "creativity"],
			},
			makeContext(),
		)) as { id: string; title: string; enabled: boolean; dimensions: string[] };

		expect(created).toMatchObject({
			id: "quantum_mechanics",
			title: "Quantum Mechanics",
			enabled: true,
			dimensions: ["code_quality_design", "creativity"],
		});

		const registryFile = await loadAssignmentsRegistry();
		expect(registryFile?.assignments.map((a) => a.id)).toEqual([
			"soil_contamination",
			"quantum_mechanics",
		]);
		const entry = registryFile?.assignments.find((a) => a.id === "quantum_mechanics");
		expect(entry?.title).toBe("Quantum Mechanics");
		expect(entry?.enabled).toBe(true);
	});

	it("rejects an invalid id (writer validation passes through as a thrown error)", async () => {
		const registry = registeredTools();
		await expect(
			registry.run(
				"create-assignment",
				{ id: "Bad-ID!", title: "Nope", enabled: true, dimensions: [] },
				makeContext(),
			),
		).rejects.toThrow(/Invalid assignment id/);

		// Nothing was written.
		const registryFile = await loadAssignmentsRegistry();
		expect(registryFile?.assignments.map((a) => a.id)).toEqual(["soil_contamination"]);
	});

	it("rejects an unknown dimension (writer validation passes through)", async () => {
		const registry = registeredTools();
		await expect(
			registry.run(
				"create-assignment",
				{ id: "good_id", title: "Good", enabled: true, dimensions: ["not_a_dimension"] },
				makeContext(),
			),
		).rejects.toThrow(/Unknown dimension "not_a_dimension"/);
	});
});

// ---------------------------------------------------------------------------
// update-assignment
// ---------------------------------------------------------------------------

describe("update-assignment", () => {
	it("partially updates without clobbering unspecified fields", async () => {
		const registry = registeredTools();
		const updated = (await registry.run(
			"update-assignment",
			{ id: "soil_contamination", enabled: false },
			makeContext(),
		)) as { id: string; title: string; enabled: boolean; dimensions: string[] };

		expect(updated).toMatchObject({
			id: "soil_contamination",
			enabled: false,
		});

		// The file round trip: only `enabled` changed; everything else kept.
		const registryFile = await loadAssignmentsRegistry();
		const entry = registryFile?.assignments.find((a) => a.id === "soil_contamination");
		expect(entry?.enabled).toBe(false);
		expect(entry?.title).toBe("Soil Contamination by Factories");
		expect(entry?.dimensions).toEqual(["code_quality_design"]);
		expect(entry?.criteria_files).toEqual(["data/criteria/general.yaml"]);
	});

	it("replaces dimensions when provided and throws for unknown ids", async () => {
		const registry = registeredTools();
		const updated = (await registry.run(
			"update-assignment",
			{ id: "soil_contamination", dimensions: ["creativity"] },
			makeContext(),
		)) as { dimensions: string[] };
		expect(updated.dimensions).toEqual(["creativity"]);

		await expect(
			registry.run(
				"update-assignment",
				{ id: "no_such_assignment", title: "X" },
				makeContext(),
			),
		).rejects.toThrow(/not found/);
	});
});

// ---------------------------------------------------------------------------
// delete-assignment
// ---------------------------------------------------------------------------

describe("delete-assignment", () => {
	it("throws while a submissions directory exists for the assignment (409 guard)", async () => {
		await mkdir(path.join(dataDir, "submissions", "soil_contamination"), { recursive: true });
		const registry = registeredTools();
		await expect(
			registry.run("delete-assignment", { id: "soil_contamination" }, makeContext()),
		).rejects.toThrow(/has submissions/);

		// The registry entry survived the refusal.
		const registryFile = await loadAssignmentsRegistry();
		expect(registryFile?.assignments.map((a) => a.id)).toEqual(["soil_contamination"]);
	});

	it("deletes the assignment once no submissions directory exists", async () => {
		const registry = registeredTools();
		const result = await registry.run(
			"delete-assignment",
			{ id: "soil_contamination" },
			makeContext(),
		);
		expect(result).toEqual({ deleted: "soil_contamination" });

		const registryFile = await loadAssignmentsRegistry();
		expect(registryFile?.assignments).toEqual([]);
	});

	it("throws for unknown ids", async () => {
		const registry = registeredTools();
		await expect(
			registry.run("delete-assignment", { id: "no_such_assignment" }, makeContext()),
		).rejects.toThrow(/not found/);
	});
});

// ---------------------------------------------------------------------------
// update-settings
// ---------------------------------------------------------------------------

describe("update-settings", () => {
	it("round-trips through writeSettings/loadSettings", async () => {
		const registry = registeredTools();
		const result = await registry.run("update-settings", VALID_SETTINGS, makeContext());

		// run() returns the freshly loaded settings (mirrors the route).
		expect(result).toEqual(VALID_SETTINGS);
		expect(await loadSettings()).toEqual(VALID_SETTINGS);

		// Persisted to disk in the wire (snake_case) shape.
		const raw = await readFile(path.join(dataDir, "settings.yaml"), "utf-8");
		expect(raw).toContain("request_timeout_ms: 30000");
		expect(raw).toContain("notebook_timeout_ms: 120000");
		expect(raw).toContain("approval_ttl_seconds: 60");
		expect(raw).toContain("mode: ask");
	});

	it("rejects an apiKey field anywhere in the payload and persists nothing", async () => {
		await writeSettings(VALID_SETTINGS);
		const registry = registeredTools();

		// Top-level secret key.
		await expect(
			registry.run(
				"update-settings",
				{ ...VALID_SETTINGS, apiKey: "sk-secret" },
				makeContext(),
			),
		).rejects.toMatchObject({ name: "CopilotToolArgumentError" });

		// Nested secret key (llm.apiKey).
		await expect(
			registry.run(
				"update-settings",
				{ ...VALID_SETTINGS, llm: { ...VALID_SETTINGS.llm, apiKey: "sk-secret" } },
				makeContext(),
			),
		).rejects.toMatchObject({ name: "CopilotToolArgumentError" });

		// The settings file is untouched — the secret never reached the disk.
		expect(await loadSettings()).toEqual(VALID_SETTINGS);
		const raw = await readFile(path.join(dataDir, "settings.yaml"), "utf-8");
		expect(raw).not.toContain("sk-secret");
	});

	it("rejects payloads that do not match the AppSettings shape", async () => {
		const registry = registeredTools();
		await expect(
			registry.run(
				"update-settings",
				{ executor: VALID_SETTINGS.executor, llm: VALID_SETTINGS.llm },
				makeContext(),
			),
		).rejects.toThrow();
		await expect(
			registry.run(
				"update-settings",
				{ ...VALID_SETTINGS, llm: { ...VALID_SETTINGS.llm, timeoutMs: -5 } },
				makeContext(),
			),
		).rejects.toThrow();
	});
});
