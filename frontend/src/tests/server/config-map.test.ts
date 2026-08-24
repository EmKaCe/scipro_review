/**
 * @file Tests for the A1 live configuration-inventory surface.
 *
 * Covers the $lib/server/config-map aggregation (settings group from
 * data/settings.yaml with env-fallback detection, api-key presence masking,
 * grading config, assignments, deploy env values, code constants) and the
 * GET /api/config/map route contract — including that the API never exposes
 * the real API key.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { GET } from "../../routes/api/config/map/+server";
import { getConfigMap, type ConfigMapResponse, type ConfigMapRow } from "$lib/server/config-map";
import { setApiKey, hasApiKey } from "$lib/server/api-key-store";
import * as yaml from "js-yaml";

// ---------------------------------------------------------------------------
// Setup: temp DATA_DIR per test
// ---------------------------------------------------------------------------

let dataDir: string;

const SETTINGS_FILE = {
	executor: {
		request_timeout_ms: 45_000,
		notebook_timeout_ms: 180_000,
		cell_timeout_s: 45,
	},
	llm: {
		base_url: "https://llm.example.test/api/v1",
		model: "test-model-7b",
		timeout_ms: 90_000,
	},
	copilot: {
		mode: "read-only",
		allowed_tools: ["run_notebook", "search_docs"],
		deny_tools: ["approve"],
		approval_ttl_seconds: 120,
		session_cap: 5,
		last_messages: 24,
		auto_compact: false,
	},
};

const GRADING_FILE = {
	dimensions: [
		{
			key: "code_quality_design",
			title: "Code Quality & Design",
			max_points: 6.0,
			weight: 4.0,
		},
		{ key: "creativity", title: "Creativity", max_points: 4.0, weight: 1.0 },
	],
	grade_boundaries: [
		{ min_percentage: 95, grade: 1.0, label: "excellent", us_equiv: "A+" },
		{ min_percentage: 80, grade: 2.0, label: "good", us_equiv: "B+" },
	],
};

async function writeDataFile(name: string, contents: unknown) {
	await mkdir(dataDir, { recursive: true });
	await writeFile(path.join(dataDir, name), yaml.dump(contents));
}

async function writeAssignments(entries: unknown[]) {
	await writeDataFile("assignments.yaml", { assignments: entries });
}

function row(resp: ConfigMapResponse, id: string): ConfigMapRow {
	const found = resp.rows.find((r) => r.id === id);
	if (!found) throw new Error(`missing config-map row: ${id}`);
	return found;
}

beforeEach(async () => {
	dataDir = await mkdtemp(path.join(os.tmpdir(), "scipro-config-map-"));
	process.env.DATA_DIR = dataDir;
});

afterEach(async () => {
	delete process.env.DATA_DIR;
	delete process.env.DOCS_INDEX_DIR;
	delete process.env.ORIGIN;
	delete process.env.PRE_EVAL_CRITIQUE;
	delete process.env.KI_CONNECT_BASE_URL;
	delete process.env.KI_CONNECT_MODEL;
	delete process.env.KI_CONNECT_API_KEY;
	setApiKey("");
	await rm(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Module — settings group
// ---------------------------------------------------------------------------

describe("config-map module: settings group", () => {
	it("reports live settings.yaml values with source settings.yaml", async () => {
		await writeDataFile("settings.yaml", SETTINGS_FILE);

		const resp = await getConfigMap();

		const baseUrl = row(resp, "llm.base_url");
		expect(baseUrl.value).toBe("https://llm.example.test/api/v1");
		expect(baseUrl.source).toBe("settings.yaml");
		expect(baseUrl.status).toBe("ok");
		expect(baseUrl.reload).toBe("next-request");

		expect(row(resp, "llm.model").value).toBe("test-model-7b");
		expect(row(resp, "llm.timeout_ms").value).toBe("90000");
		expect(row(resp, "executor.request_timeout_ms").value).toBe("45000");
		expect(row(resp, "executor.notebook_timeout_ms").value).toBe("180000");
		expect(row(resp, "executor.cell_timeout_s").value).toBe("45");
		expect(row(resp, "copilot.mode").value).toBe("read-only");
		expect(row(resp, "copilot.allowed_tools").value).toBe("run_notebook, search_docs");
		expect(row(resp, "copilot.deny_tools").value).toBe("approve");
		expect(row(resp, "copilot.approval_ttl_seconds").value).toBe("120");
		expect(row(resp, "copilot.session_cap").value).toBe("5");
		expect(row(resp, "copilot.last_messages").value).toBe("24");
		expect(row(resp, "copilot.auto_compact").value).toBe("false");
	});

	it("shows env-fallback for llm rows when no settings.yaml exists and env is set", async () => {
		process.env.KI_CONNECT_BASE_URL = "https://env-base.test/api/v1";
		process.env.KI_CONNECT_MODEL = "env-model-70b";

		const resp = await getConfigMap();

		const baseUrl = row(resp, "llm.base_url");
		expect(baseUrl.value).toBe("https://env-base.test/api/v1");
		expect(baseUrl.status).toBe("env-fallback");
		expect(baseUrl.source).toBe("settings.yaml");

		const model = row(resp, "llm.model");
		expect(model.value).toBe("env-model-70b");
		expect(model.status).toBe("env-fallback");
	});

	it("shows ok with defaults when no settings.yaml and no env override", async () => {
		const resp = await getConfigMap();

		expect(row(resp, "llm.base_url").value).toBe("https://chat.kiconnect.nrw/api/v1");
		expect(row(resp, "llm.base_url").status).toBe("ok");
		expect(row(resp, "llm.model").value).toBe("qwen3-30b-a3b-instruct-2507");
		expect(row(resp, "llm.model").status).toBe("ok");
		expect(row(resp, "llm.timeout_ms").value).toBe("60000");
	});

	it("reports ok (not env-fallback) when the file value differs from the env value", async () => {
		process.env.KI_CONNECT_BASE_URL = "https://env-base.test/api/v1";
		process.env.KI_CONNECT_MODEL = "env-model-70b";
		await writeDataFile("settings.yaml", SETTINGS_FILE);

		const resp = await getConfigMap();

		expect(row(resp, "llm.base_url").status).toBe("ok");
		expect(row(resp, "llm.model").status).toBe("ok");
	});

	it("reports the api key row as unset when no key is configured", async () => {
		const resp = await getConfigMap();

		const key = row(resp, "llm.api_key");
		expect(key.status).toBe("unset");
		expect(key.value).toBeNull();
		expect(key.secret).toBe(true);
		expect(key.source).toBe("env");
		expect(key.reload).toBe("next-request");
	});

	it("masks a configured api key as •••• with status secret-set", async () => {
		setApiKey("super-secret-key-value");

		const resp = await getConfigMap();
		expect(hasApiKey()).toBe(true);

		const key = row(resp, "llm.api_key");
		expect(key.status).toBe("secret-set");
		expect(key.value).toBe("••••");
		expect(key.secret).toBe(true);
	});

	it("summarizes grading dimensions and grade boundaries from grading_config.yaml", async () => {
		await writeDataFile("grading_config.yaml", GRADING_FILE);

		const resp = await getConfigMap();

		const grading = row(resp, "grading.dimensions");
		expect(grading.source).toBe("grading_config.yaml");
		expect(grading.status).toBe("ok");
		expect(grading.affordance).toBe("this-page");
		expect(grading.reload).toBe("hot");
		expect(grading.value).toContain("code_quality_design (Code Quality & Design, 6 pts)");
		expect(grading.value).toContain("creativity (Creativity, 4 pts)");
		expect(grading.description).toContain("95%→1 excellent");
		expect(grading.description).toContain("80%→2 good");
	});

	it("reports grading.dimensions as unset when grading_config.yaml is missing", async () => {
		const resp = await getConfigMap();
		expect(row(resp, "grading.dimensions").status).toBe("unset");
	});

	it("reports appearance as a localStorage per-device row", async () => {
		const resp = await getConfigMap();

		const appearance = row(resp, "appearance");
		expect(appearance.source).toBe("localStorage");
		expect(appearance.value).toBeNull();
		expect(appearance.status).toBe("ok");
		expect(appearance.description).toMatch(/per-device/i);
	});
});

// ---------------------------------------------------------------------------
// Module — assignment group
// ---------------------------------------------------------------------------

describe("config-map module: assignment group", () => {
	it("emits one row per enabled assignment with assignment-editor affordance", async () => {
		await writeAssignments([
			{
				id: "soil_contamination",
				title: "Soil Contamination",
				enabled: true,
				criteria_files: ["soil_contamination.yaml"],
				scoring_file: "soil_contamination.yaml",
			},
			{
				id: "atom_interaction",
				title: "Atom Interaction",
				enabled: false,
				criteria_files: ["atom_interaction.yaml"],
			},
			{
				id: "molecular_dynamics",
				title: "Molecular Dynamics",
				enabled: true,
				criteria_files: ["general.yaml", "molecular_dynamics.yaml"],
			},
		]);

		const resp = await getConfigMap();

		const soil = row(resp, "assignment.soil_contamination");
		expect(soil.name).toBe("Soil Contamination");
		expect(soil.value).toBe("soil_contamination");
		expect(soil.source).toBe("assignments.yaml");
		expect(soil.status).toBe("ok");
		expect(soil.affordance).toBe("assignment-editor");
		expect(soil.reload).toBe("next-request");
		expect(soil.description).toContain("soil_contamination.yaml");
		expect(soil.description).toContain("scoring: soil_contamination.yaml");
		expect(soil.description).toContain("materials");

		const md = row(resp, "assignment.molecular_dynamics");
		expect(md.name).toBe("Molecular Dynamics");
		expect(md.description).toContain("general.yaml, molecular_dynamics.yaml");

		// Disabled assignments must NOT produce a row.
		expect(resp.rows.some((r) => r.id === "assignment.atom_interaction")).toBe(false);
	});

	it("emits a single unset row when no assignments are enabled", async () => {
		await writeAssignments([
			{
				id: "atom_interaction",
				title: "Atom Interaction",
				enabled: false,
				criteria_files: [],
			},
		]);

		const resp = await getConfigMap();

		const none = row(resp, "assignment.none");
		expect(none.status).toBe("unset");
		expect(none.value).toBeNull();
		expect(none.affordance).toBe("assignment-editor");
		expect(resp.rows.filter((r) => r.group === "assignment")).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// Module — deploy + code groups
// ---------------------------------------------------------------------------

describe("config-map module: deploy + code groups", () => {
	it("reports live env values with readonly/restart semantics", async () => {
		process.env.DOCS_INDEX_DIR = "/custom/docs-index";
		process.env.ORIGIN = "https://scipro.example.org";
		process.env.PRE_EVAL_CRITIQUE = "0";
		process.env.KI_CONNECT_BASE_URL = "https://env-base.test/api/v1";

		const resp = await getConfigMap();

		const deployRows = resp.rows.filter((r) => r.group === "deploy");
		expect(deployRows).toHaveLength(5);
		for (const r of deployRows) {
			expect(r.status).toBe("readonly");
			expect(r.affordance).toBe("env-file");
			expect(r.reload).toBe("restart");
			expect(r.source).toBe("env");
		}

		expect(row(resp, "deploy.data_dir").value).toBe(dataDir);
		expect(row(resp, "deploy.docs_index_dir").value).toBe("/custom/docs-index");
		expect(row(resp, "deploy.origin").value).toBe("https://scipro.example.org");
		expect(row(resp, "deploy.pre_eval_critique").value).toBe("0");
		expect(row(resp, "deploy.ki_connect_base_url_env").value).toBe(
			"https://env-base.test/api/v1",
		);
	});

	it("shows honest defaults/(unset) when env vars are absent", async () => {
		const resp = await getConfigMap();

		expect(row(resp, "deploy.data_dir").value).toBe(dataDir);
		expect(row(resp, "deploy.docs_index_dir").value).toBe(`(default: ${dataDir}/docs-index)`);
		expect(row(resp, "deploy.origin").value).toBe("(unset)");
		expect(row(resp, "deploy.pre_eval_critique").value).toBe("(unset)");
		expect(row(resp, "deploy.ki_connect_base_url_env").value).toBe("(unset)");
	});

	it("emits code rows with the documented constants and readonly/restart semantics", async () => {
		const resp = await getConfigMap();

		const codeRows = resp.rows.filter((r) => r.group === "code");
		expect(codeRows).toHaveLength(4);
		for (const r of codeRows) {
			expect(r.status).toBe("readonly");
			expect(r.affordance).toBe("none");
			expect(r.reload).toBe("restart");
			expect(r.source).toBe("code");
		}

		expect(row(resp, "code.concurrency").value).toBe("2");
		expect(row(resp, "code.injection_threshold").value).toBe("0.7");
		expect(row(resp, "code.textarea_min_chars").value).toBe("20");
		expect(row(resp, "code.rich_output_caps").value).toContain("5242880");
		expect(row(resp, "code.rich_output_caps").value).toContain("200000");
	});
});

// ---------------------------------------------------------------------------
// API route
// ---------------------------------------------------------------------------

describe("/api/config/map", () => {
	it("GET returns the contract shape with 200", async () => {
		await writeDataFile("settings.yaml", SETTINGS_FILE);
		await writeDataFile("grading_config.yaml", GRADING_FILE);
		await writeAssignments([
			{
				id: "soil_contamination",
				title: "Soil Contamination",
				enabled: true,
				criteria_files: [],
			},
		]);

		const resp = await GET();
		expect(resp.status).toBe(200);

		const body = (await resp.json()) as ConfigMapResponse;
		expect(Array.isArray(body.rows)).toBe(true);
		expect(typeof body.generatedAt).toBe("string");
		expect(body.generatedAt.length).toBeGreaterThan(0);
		expect(body.rows.length).toBeGreaterThan(0);
	});

	it("GET never exposes the API key", async () => {
		setApiKey("super-secret-key-value");

		const resp = await GET();
		const text = await resp.text();
		expect(text).not.toContain("super-secret-key-value");
		const body = JSON.parse(text) as ConfigMapResponse;
		expect(row(body, "llm.api_key").value).toBe("••••");
		expect(row(body, "llm.api_key").secret).toBe(true);
	});
});
