/**
 * @file Component test — settings Configuration map card (Task A2).
 *
 * The card fetches GET /api/config/map on mount and renders purpose-grouped
 * sections from the RESPONSE (no hardcoded sections). Covers: sections
 * render from the response, env rows show live value + restart label, the
 * secret row shows "••••" (never the real key), code-group rows are filtered
 * out, file-backed rows anchor to their owning card, assignment rows
 * deep-link to the assignment editor, loading + error states, and the
 * last-checked timestamp.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";

import ConfigurationMapCard from "$lib/components/settings/configuration-map-card.svelte";

vi.mock("$app/paths", () => ({ base: "" }));

// ---------------------------------------------------------------------------
// Fixtures — a representative ConfigMapResponse (contract from config-map.ts)
// ---------------------------------------------------------------------------

const GENERATED_AT = "2026-08-24T09:30:00.000Z";

interface FixtureRow {
	id: string;
	group: "settings" | "assignment" | "deploy" | "code";
	name: string;
	description: string;
	value: string | null;
	source: string;
	status: "ok" | "unset" | "env-fallback" | "readonly" | "secret-set";
	affordance: "this-page" | "assignment-editor" | "env-file" | "none";
	reload: "hot" | "next-request" | "restart";
	secret?: boolean;
}

const SETTINGS_ROW: FixtureRow = {
	id: "llm.model",
	group: "settings",
	name: "LLM model",
	description: "KI Connect model id (settings.yaml llm.model).",
	value: "qwen3-30b-a3b-instruct-2507",
	source: "settings.yaml",
	status: "ok",
	affordance: "this-page",
	reload: "next-request",
};

const GRADING_ROW: FixtureRow = {
	id: "grading.dimensions",
	group: "settings",
	name: "Grading dimensions & boundaries",
	description: "Grade boundaries: 95%→1 excellent.",
	value: "code_quality_design (Code Quality & Design, 6 pts)",
	source: "grading_config.yaml",
	status: "ok",
	affordance: "this-page",
	reload: "hot",
};

const SECRET_ROW: FixtureRow = {
	id: "llm.api_key",
	group: "settings",
	name: "KI Connect API key",
	description: "KI Connect bearer token — presence is reported, the value is never returned.",
	value: "••••",
	source: "env",
	status: "secret-set",
	affordance: "this-page",
	reload: "next-request",
	secret: true,
};

const ASSIGNMENT_ROW: FixtureRow = {
	id: "assignment.soil_contamination",
	group: "assignment",
	name: "Soil Contamination",
	description: "criteria: soil_contamination.yaml; scoring: soil_contamination.yaml.",
	value: "soil_contamination",
	source: "assignments.yaml",
	status: "ok",
	affordance: "assignment-editor",
	reload: "next-request",
};

const ENV_ROW: FixtureRow = {
	id: "deploy.origin",
	group: "deploy",
	name: "ORIGIN",
	description: "Canonical origin URL of the deployment (env ORIGIN).",
	value: "https://scipro.example.org",
	source: "env",
	status: "readonly",
	affordance: "env-file",
	reload: "restart",
};

const CODE_ROW: FixtureRow = {
	id: "code.concurrency",
	group: "code",
	name: "KI Connect concurrency ceiling",
	description: "Bounded parallel KI Connect calls (2 in flight max).",
	value: "2",
	source: "code",
	status: "readonly",
	affordance: "none",
	reload: "restart",
};

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

// ---------------------------------------------------------------------------
// Fetch mock
// ---------------------------------------------------------------------------

let fetchMock: ReturnType<typeof vi.fn>;

function mockConfigMap(rows: FixtureRow[]): void {
	fetchMock.mockResolvedValue(jsonResponse({ rows, generatedAt: GENERATED_AT }));
}

beforeEach(() => {
	fetchMock = vi.fn();
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("ConfigurationMapCard", () => {
	it("renders sections from the response (settings, deploy, assignment rows present)", async () => {
		mockConfigMap([SETTINGS_ROW, ENV_ROW, ASSIGNMENT_ROW]);

		render(ConfigurationMapCard);

		expect(await screen.findByText("LLM model")).toBeTruthy();
		expect(screen.getByText("ORIGIN")).toBeTruthy();
		expect(screen.getByText("Soil Contamination")).toBeTruthy();

		// Purpose-grouped framing comes from the response data, not a
		// hardcoded section list ("Assignment editor" also appears as the
		// row's affordance link label, so it matches twice).
		expect(screen.getByText("Settings page")).toBeTruthy();
		expect(screen.getAllByText("Assignment editor").length).toBeGreaterThan(0);
		expect(screen.getByText("Deployment environment")).toBeTruthy();
	});

	it("shows env row live value + restart-to-apply label", async () => {
		mockConfigMap([ENV_ROW]);

		render(ConfigurationMapCard);

		expect(await screen.findByText("ORIGIN")).toBeTruthy();
		expect(screen.getByText("https://scipro.example.org")).toBeTruthy();
		expect(screen.getByText("Restart required")).toBeTruthy();
		expect(screen.getByText(/Set in \.env \/ environment — restart to apply\./)).toBeTruthy();
	});

	it("masks the secret row and never renders the real key", async () => {
		mockConfigMap([SECRET_ROW]);

		render(ConfigurationMapCard);

		expect(await screen.findByText("KI Connect API key")).toBeTruthy();
		expect(screen.getByText("••••")).toBeTruthy();
		expect(screen.getByText("set")).toBeTruthy();
		expect(document.body.textContent).not.toContain("super-secret-key-value");
		expect(document.body.textContent).not.toContain("sk-");
	});

	it("does not render code-group rows", async () => {
		mockConfigMap([SETTINGS_ROW, CODE_ROW]);

		render(ConfigurationMapCard);

		expect(await screen.findByText("LLM model")).toBeTruthy();
		expect(screen.queryByText("KI Connect concurrency ceiling")).toBeNull();
		expect(screen.queryByText(/Code constant/)).toBeNull();
		// The code group must not even produce an empty "Read-only constants"
		// section header.
		expect(screen.queryByText("Read-only constants")).toBeNull();
	});

	it("links file-backed rows to their owning card anchor", async () => {
		mockConfigMap([SETTINGS_ROW, GRADING_ROW]);

		render(ConfigurationMapCard);

		expect(await screen.findByText("LLM model")).toBeTruthy();
		expect(screen.getByText("Grading dimensions & boundaries")).toBeTruthy();

		const links = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"));
		expect(links.map((l) => l.getAttribute("href"))).toContain("#execution-ai");
		expect(links.map((l) => l.getAttribute("href"))).toContain("#grading");
	});

	it("deep-links assignment rows to the assignment editor", async () => {
		mockConfigMap([ASSIGNMENT_ROW]);

		render(ConfigurationMapCard);

		expect(await screen.findByText("Soil Contamination")).toBeTruthy();
		const link = document.querySelector<HTMLAnchorElement>(
			'a[href="/settings/assignments/soil_contamination"]',
		);
		expect(link).not.toBeNull();
	});

	it("links the assignment.none row to the assignments index", async () => {
		mockConfigMap([
			{
				id: "assignment.none",
				group: "assignment",
				name: "No enabled assignments",
				description: "No enabled assignments in assignments.yaml.",
				value: null,
				source: "assignments.yaml",
				status: "unset",
				affordance: "assignment-editor",
				reload: "next-request",
			},
		]);

		render(ConfigurationMapCard);

		expect(await screen.findByText("No enabled assignments")).toBeTruthy();
		expect(
			document.querySelector<HTMLAnchorElement>('a[href="/settings/assignments"]'),
		).not.toBeNull();
	});

	it("shows the last-checked timestamp from generatedAt", async () => {
		mockConfigMap([SETTINGS_ROW]);

		render(ConfigurationMapCard);

		await waitFor(() => expect(screen.getByText(/Last checked:/)).toBeTruthy());
		expect(screen.getByText(/2026/)).toBeTruthy();
	});

	it("shows a loading note before the fetch resolves", async () => {
		fetchMock.mockReturnValue(new Promise(() => {}));

		render(ConfigurationMapCard);

		expect(screen.getByText(/Loading configuration map…/)).toBeTruthy();
	});

	it("shows a muted error note (not a red banner) when the fetch fails", async () => {
		fetchMock.mockRejectedValue(new Error("network down"));

		render(ConfigurationMapCard);

		expect(await screen.findByText(/Could not load configuration map/)).toBeTruthy();
		expect(screen.getByText(/network down/)).toBeTruthy();
	});

	it("refetches when the refresh button is clicked", async () => {
		mockConfigMap([SETTINGS_ROW]);

		render(ConfigurationMapCard);

		await screen.findByText("LLM model");

		fetchMock.mockClear();
		mockConfigMap([ENV_ROW]);
		await fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));

		expect(await screen.findByText("ORIGIN")).toBeTruthy();
		expect(String(fetchMock.mock.calls[0][0])).toContain("/api/config/map");
	});
});
