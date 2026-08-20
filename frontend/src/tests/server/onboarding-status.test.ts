/**
 * @file Tests for the T6 first-run onboarding status surface.
 *
 * Covers the extracted $lib/server/onboarding-status computation (each of the
 * five checks) and the GET /api/onboarding/status route contract — including
 * that the API is read-only and never exposes the LLM API key.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { GET } from "../../routes/api/onboarding/status/+server";
import { getOnboardingStatus, type OnboardingItem } from "$lib/server/onboarding-status";
import { setApiKey, hasApiKey } from "$lib/server/api-key-store";
import * as yaml from "js-yaml";

// ---------------------------------------------------------------------------
// Setup: temp DATA_DIR per test
// ---------------------------------------------------------------------------

let dataDir: string;

const ASSIGNMENT = (over: Record<string, unknown> = {}) => ({
	id: "soil_contamination",
	title: "Soil Contamination",
	enabled: true,
	criteria_files: ["soil_contamination.yaml"],
	...over,
});

async function writeAssignments(entries: unknown[]) {
	await mkdir(dataDir, { recursive: true });
	await writeFile(path.join(dataDir, "assignments.yaml"), yaml.dump({ assignments: entries }));
}

function item(items: OnboardingItem[], id: string): OnboardingItem {
	const found = items.find((i) => i.id === id);
	if (!found) throw new Error(`missing onboarding item: ${id}`);
	return found;
}

beforeEach(async () => {
	dataDir = await mkdtemp(path.join(os.tmpdir(), "scipro-onboarding-"));
	process.env.DATA_DIR = dataDir;
});

afterEach(async () => {
	delete process.env.DATA_DIR;
	delete process.env.DOCS_INDEX_DIR;
	delete process.env.KI_CONNECT_API_KEY;
	setApiKey("");
	await rm(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

describe("onboarding-status module", () => {
	it("reports nothing set up on an empty data dir", async () => {
		const { items } = await getOnboardingStatus();

		expect(item(items, "create-assignment").done).toBe(false);
		// No assignment → wire-scoring is unknown, with guidance.
		expect(item(items, "wire-scoring").done).toBeNull();
		expect(item(items, "wire-scoring").detail).toBe("Create an assignment first.");
		expect(item(items, "llm-provider").done).toBe(false);
		expect(item(items, "docs-index").done).toBe(false);
		expect(item(items, "first-pipeline").done).toBe(false);
	});

	it("reports an enabled assignment as create-assignment: done", async () => {
		await writeAssignments([ASSIGNMENT()]);
		const { items } = await getOnboardingStatus();
		expect(item(items, "create-assignment").done).toBe(true);
	});

	it("wire-scoring: done when criteria + scoring file on disk", async () => {
		await writeAssignments([ASSIGNMENT()]);
		await mkdir(path.join(dataDir, "scoring"), { recursive: true });
		await writeFile(path.join(dataDir, "scoring", "soil_contamination.yaml"), "anchors: []\n");

		const { items } = await getOnboardingStatus();
		expect(item(items, "wire-scoring").done).toBe(true);
		expect(item(items, "wire-scoring").detail).toBe("soil_contamination");
	});

	it("wire-scoring: done when criteria + scoring_file field set (no file needed)", async () => {
		await writeAssignments([ASSIGNMENT({ scoring_file: "soil_contamination.yaml" })]);
		const { items } = await getOnboardingStatus();
		expect(item(items, "wire-scoring").done).toBe(true);
	});

	it("wire-scoring: not done when first assignment has no criteria", async () => {
		await writeAssignments([ASSIGNMENT({ criteria_files: [] })]);
		await mkdir(path.join(dataDir, "scoring"), { recursive: true });
		await writeFile(path.join(dataDir, "scoring", "soil_contamination.yaml"), "anchors: []\n");

		const { items } = await getOnboardingStatus();
		expect(item(items, "wire-scoring").done).toBe(false);
	});

	it("wire-scoring: skips disabled assignments when picking the first", async () => {
		await writeAssignments([
			ASSIGNMENT({ id: "disabled_one", enabled: false }),
			ASSIGNMENT({ id: "soil_contamination" }),
		]);
		await mkdir(path.join(dataDir, "scoring"), { recursive: true });
		await writeFile(path.join(dataDir, "scoring", "soil_contamination.yaml"), "anchors: []\n");

		const { items } = await getOnboardingStatus();
		expect(item(items, "wire-scoring").done).toBe(true);
		expect(item(items, "wire-scoring").detail).toBe("soil_contamination");
	});

	it("llm-provider reflects the in-process API key", async () => {
		expect(hasApiKey()).toBe(false);
		expect(item((await getOnboardingStatus()).items, "llm-provider").done).toBe(false);

		process.env.KI_CONNECT_API_KEY = "test-key";
		setApiKey("test-key");
		expect(item((await getOnboardingStatus()).items, "llm-provider").done).toBe(true);
	});

	it("docs-index: done when docs-index.json exists under DATA_DIR/docs-index", async () => {
		await mkdir(path.join(dataDir, "docs-index"), { recursive: true });
		await writeFile(path.join(dataDir, "docs-index", "docs-index.json"), "{}");

		const { items } = await getOnboardingStatus();
		expect(item(items, "docs-index").done).toBe(true);
	});

	it("docs-index: honors the DOCS_INDEX_DIR env override", async () => {
		await mkdir(path.join(dataDir, "custom-index"), { recursive: true });
		await writeFile(path.join(dataDir, "custom-index", "docs-index.json"), "{}");
		process.env.DOCS_INDEX_DIR = path.join(dataDir, "custom-index");

		const { items } = await getOnboardingStatus();
		expect(item(items, "docs-index").done).toBe(true);
	});

	it("first-pipeline: done when a results.json exists under submissions/*", async () => {
		await mkdir(path.join(dataDir, "submissions", "soil_contamination"), { recursive: true });
		await writeFile(
			path.join(dataDir, "submissions", "soil_contamination", "results.json"),
			"{}",
		);

		const { items } = await getOnboardingStatus();
		expect(item(items, "first-pipeline").done).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// API route
// ---------------------------------------------------------------------------

describe("/api/onboarding/status", () => {
	it("GET returns the full items array in contract shape", async () => {
		const resp = await GET();
		expect(resp.status).toBe(200);
		const body = (await resp.json()) as { items: OnboardingItem[] };
		expect(Array.isArray(body.items)).toBe(true);
		expect(body.items.map((i) => i.id)).toEqual([
			"create-assignment",
			"wire-scoring",
			"llm-provider",
			"docs-index",
			"first-pipeline",
		]);
		for (const i of body.items) {
			expect(typeof i.id).toBe("string");
			expect(i.done === true || i.done === false || i.done === null).toBe(true);
		}
	});

	it("GET never exposes the API key", async () => {
		process.env.KI_CONNECT_API_KEY = "super-secret-key-value";
		setApiKey("super-secret-key-value");

		const resp = await GET();
		const body = await resp.text();
		expect(body).not.toContain("super-secret-key-value");
		expect(body).not.toContain("apiKey");
	});
});
