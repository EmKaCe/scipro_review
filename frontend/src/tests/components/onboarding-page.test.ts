/**
 * @file Component tests — onboarding wizard page (2.8.0-w2 step shell).
 *
 * The page composes WizardShell (rail + nav) with per-step bodies: the
 * welcome fork (fresh vs restore), the restore card, the LLM provider
 * card, the DocsEmbedCard, the executor probe, the seed action and the
 * done summary. Status is fetched on mount; entries land on the "welcome"
 * step every time and navigate by clicking fork buttons / Next.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";

import OnboardingPage from "../../routes/onboarding/+page.svelte";
import * as settingsApi from "$lib/services/settings-api.js";

const nav = vi.hoisted(() => ({
	goto: vi.fn(),
	invalidateAll: vi.fn(),
}));

vi.mock("$lib/services/settings-api.js", async (importOriginal) => {
	const actual = await importOriginal<typeof settingsApi>();
	return {
		...actual,
		fetchSettings: vi.fn().mockResolvedValue({
			executor: {
				requestTimeoutMs: 30_000,
				notebookTimeoutMs: 120_000,
				cellTimeoutS: 30,
			},
			llm: {
				baseUrl: "https://example.test/v1",
				model: "qwen3-30b-a3b-instruct-2507",
				timeoutMs: 60_000,
			},
			copilot: {
				mode: "ask",
				allowedTools: [],
				denyTools: [],
				approvalTtlSeconds: 60,
				sessionCap: 20,
				lastMessages: 16,
				autoCompact: true,
			},
			hasApiKey: false,
		}),
		fetchModels: vi.fn().mockResolvedValue({
			source: "live",
			models: [
				{ id: "openai-gpt-oss-120b", contextTokens: 131_072, isOpenWeight: true },
				{ id: "qwen3-30b-a3b-instruct-2507", contextTokens: 262_144, isOpenWeight: true },
				{ id: "some-unknown-model", contextTokens: 32_768, isOpenWeight: false },
			],
		}),
		saveApiKey: vi.fn().mockResolvedValue(undefined),
		saveSettings: vi.fn().mockResolvedValue({}),
	};
});

vi.mock("$app/paths", () => ({ base: "" }));

vi.mock("$app/navigation", () => nav);

vi.mock("$lib/stores/toast.svelte.js", () => ({
	addToast: vi.fn(),
}));

const mockedSaveApiKey = vi.mocked(settingsApi.saveApiKey);
const mockedSaveSettings = vi.mocked(settingsApi.saveSettings);
const mockedFetchModels = vi.mocked(settingsApi.fetchModels);
const mockedFetchSettings = vi.mocked(settingsApi.fetchSettings);

/** Scripted GET /api/onboarding/status response. */
function statusBody(items: { id: string; done: boolean | null; detail?: string }[]) {
	return { items };
}

/** Default status: provider NOT done, docs done — the expandable case. */
const DEFAULT_ITEMS = [
	{ id: "create-assignment", done: true },
	{ id: "wire-scoring", done: true },
	{ id: "llm-provider", done: false },
	{ id: "docs-index", done: true },
	{ id: "first-pipeline", done: false },
];

/** Docs-index NOT done: the card must offer the A/B/C options. */
const NO_INDEX_ITEMS = DEFAULT_ITEMS.map((i) =>
	i.id === "docs-index" ? { ...i, done: false } : i,
);

const EXECUTOR_HEALTH_OK = {
	status: "ok",
	version: "2.8.0",
	data_dir: "/app/data",
	ki_connect_available: true,
};

const SEED_OK = {
	ok: true,
	assignmentId: "soil_contamination",
	alreadyEnabled: false,
	missingFiles: [],
};

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
	vi.clearAllMocks();
	fetchMock = vi.fn();
	vi.stubGlobal("fetch", fetchMock);

	mockedFetchModels.mockResolvedValue({
		source: "live",
		models: [
			{ id: "openai-gpt-oss-120b", contextTokens: 131_072, isOpenWeight: true },
			{ id: "qwen3-30b-a3b-instruct-2507", contextTokens: 262_144, isOpenWeight: true },
			{ id: "some-unknown-model", contextTokens: 32_768, isOpenWeight: false },
		],
	});
	mockedFetchSettings.mockResolvedValue({
		executor: {
			requestTimeoutMs: 30_000,
			notebookTimeoutMs: 120_000,
			cellTimeoutS: 30,
		},
		llm: {
			baseUrl: "https://example.test/v1",
			model: "qwen3-30b-a3b-instruct-2507",
			timeoutMs: 60_000,
		},
		copilot: {
			mode: "ask",
			allowedTools: [],
			denyTools: [],
			approvalTtlSeconds: 60,
			sessionCap: 20,
			lastMessages: 16,
			autoCompact: true,
		},
		hasApiKey: false,
	} as never);
	mockedSaveApiKey.mockResolvedValue(undefined);
	mockedSaveSettings.mockResolvedValue({} as never);

	// Default script: status + the docs card's own status probe + a
	// reachable executor; individual tests override the routes they
	// exercise (backup, seed, health, dismiss).
	fetchMock.mockImplementation((url: string) => {
		if (String(url).includes("/api/onboarding/status")) {
			return Promise.resolve(jsonResponse(statusBody(DEFAULT_ITEMS)));
		}
		if (String(url).includes("/api/onboarding/docs-embeddings/status")) {
			return Promise.resolve(jsonResponse({ job: null }));
		}
		if (String(url).includes("/api/executor/health")) {
			return Promise.resolve(jsonResponse(EXECUTOR_HEALTH_OK));
		}
		return Promise.reject(new Error(`unexpected fetch: ${url}`));
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function renderPage() {
	render(OnboardingPage);
	// The wizard lands on the welcome step once the status load settles.
	await waitFor(() =>
		expect(screen.getByRole("button", { name: /Start fresh setup/ })).toBeTruthy(),
	);
}

async function startFresh(): Promise<void> {
	await fireEvent.click(screen.getByRole("button", { name: /Start fresh setup/ }));
}

async function startRestore(): Promise<void> {
	await fireEvent.click(
		screen.getByRole("button", { name: /Restore a backup from another machine/ }),
	);
}

async function nextStep(): Promise<void> {
	await fireEvent.click(screen.getByRole("button", { name: /^Next$/ }));
}

function statusCalls(): number {
	return fetchMock.mock.calls.filter(([url]) =>
		String(url).includes("/api/onboarding/status"),
	).length;
}

describe("onboarding wizard — welcome fork", () => {
	it("renders the setup wizard header with both fork choices", async () => {
		await renderPage();
		expect(screen.getByText("Setup wizard")).toBeTruthy();
		expect(screen.getByRole("button", { name: /Start fresh setup/ })).toBeTruthy();
		expect(
			screen.getByRole("button", { name: /Restore a backup from another machine/ }),
		).toBeTruthy();
	});

	it("shows an error state when the status fetch fails", async () => {
		fetchMock.mockImplementation(() => Promise.resolve(new Response("boom", { status: 500 })));
		render(OnboardingPage);
		expect(await screen.findByText(/Could not load setup status/)).toBeTruthy();
	});
});

describe("onboarding wizard — restore step (B1)", () => {
	it("offers the backup file input and a download link", async () => {
		await renderPage();
		await startRestore();

		expect(document.querySelector('input[type="file"]')).not.toBeNull();
		const link = screen.getByRole("link", { name: /Download current backup/ });
		expect(link.getAttribute("href")).toBe("/api/backup");
	});

	it("requires a two-click confirm before restoring, then refreshes the status", async () => {
		await renderPage();
		await startRestore();

		const fileInput = document.querySelector<HTMLInputElement>('input[type="file"]');
		expect(fileInput).not.toBeNull();
		if (!fileInput) return;

		expect(screen.queryByRole("button", { name: /Confirm restore/ })).toBeNull();

		const file = new File(["zip-bytes"], "backup.zip", { type: "application/zip" });
		await fireEvent.change(fileInput, { target: { files: [file] } });
		expect(screen.getByRole("button", { name: /Confirm restore/ })).toBeTruthy();

		fetchMock.mockImplementation((url: string, init?: RequestInit) => {
			if (String(url).includes("/api/backup") && init?.method === "POST") {
				return Promise.resolve(jsonResponse({ restored: 42 }));
			}
			if (String(url).includes("/api/onboarding/status")) {
				return Promise.resolve(
					jsonResponse(
						statusBody(
							DEFAULT_ITEMS.map((i) =>
								i.id === "llm-provider" ? { ...i, done: true } : i,
							),
						),
					),
				);
			}
			return Promise.reject(new Error(`unexpected fetch: ${url}`));
		});

		await fireEvent.click(screen.getByRole("button", { name: /Confirm restore/ }));

		await waitFor(() => {
			const backupCalls = fetchMock.mock.calls.filter(([url]) =>
				String(url).includes("/api/backup"),
			);
			expect(backupCalls.length).toBe(1);
		});
		expect(
			await screen.findByText(/Backup restored — your setup has been re-evaluated/),
		).toBeTruthy();
	});

	it("surfaces the server error on a failed restore and does not refresh", async () => {
		await renderPage();
		await startRestore();

		const fileInput = document.querySelector<HTMLInputElement>('input[type="file"]');
		expect(fileInput).not.toBeNull();
		if (!fileInput) return;

		const file = new File(["zip-bytes"], "backup.zip", { type: "application/zip" });
		await fireEvent.change(fileInput, { target: { files: [file] } });

		fetchMock.mockImplementation((url: string, init?: RequestInit) => {
			if (String(url).includes("/api/backup") && init?.method === "POST") {
				return Promise.resolve(
					jsonResponse({ error: "Could not restore backup: corrupt zip" }, 400),
				);
			}
			if (String(url).includes("/api/onboarding/status")) {
				return Promise.resolve(jsonResponse(statusBody(DEFAULT_ITEMS)));
			}
			return Promise.reject(new Error(`unexpected fetch: ${url}`));
		});

		const before = statusCalls();
		await fireEvent.click(screen.getByRole("button", { name: /Confirm restore/ }));

		expect(
			await screen.findByText(/Could not restore: Could not restore backup: corrupt zip/),
		).toBeTruthy();
		// No refresh after a failed restore.
		expect(statusCalls()).toBe(before);
	});
});

describe("onboarding wizard — provider step (B2)", () => {
	it("offers the key field and model picker with recommended tagging", async () => {
		await renderPage();
		await startFresh();

		expect(screen.getByLabelText("KI Connect API key")).toBeTruthy();
		expect(screen.getByLabelText("Model")).toBeTruthy();
		expect(screen.getByRole("button", { name: /Save key & model/ })).toBeTruthy();

		await waitFor(() => expect(mockedFetchModels).toHaveBeenCalled());
		const options = screen.getAllByRole("option") as HTMLOptionElement[];
		const recommended = options.find((o) => o.textContent?.includes("Recommended"));
		expect(recommended?.value).toBe("openai-gpt-oss-120b");
		const fast = options.find((o) => o.textContent?.includes("Fast"));
		expect(fast?.value).toBe("qwen3-30b-a3b-instruct-2507");
	});

	it("saves the key (PATCH) + model (PUT) and refreshes the status", async () => {
		await renderPage();
		await startFresh();

		await fireEvent.input(screen.getByLabelText("KI Connect API key"), {
			target: { value: "sk-test-123" },
		});
		const modelSelect = screen.getByLabelText("Model") as HTMLSelectElement;
		await fireEvent.change(modelSelect, { target: { value: "openai-gpt-oss-120b" } });

		await fireEvent.click(screen.getByRole("button", { name: /Save key & model/ }));

		await waitFor(() => expect(mockedSaveApiKey).toHaveBeenCalledWith("sk-test-123"));
		await waitFor(() => expect(mockedSaveSettings).toHaveBeenCalled());
		expect(mockedSaveSettings.mock.calls[0]?.[0]).toMatchObject({
			llm: { model: "openai-gpt-oss-120b" },
		});
	});

	it("shows the static-fallback note when the model list is not live", async () => {
		mockedFetchModels.mockResolvedValue({
			source: "static",
			models: [
				{ id: "qwen3-30b-a3b-instruct-2507", contextTokens: 262_144, isOpenWeight: true },
			],
		});
		await renderPage();
		await startFresh();
		expect(await screen.findByText(/you can also set KI_CONNECT_API_KEY in your .env/)).toBeTruthy();
	});

	it("keeps the card usable when the provider is already configured", async () => {
		fetchMock.mockImplementation((url: string) => {
			if (String(url).includes("/api/onboarding/status")) {
				return Promise.resolve(
					jsonResponse(
						statusBody(
							DEFAULT_ITEMS.map((i) =>
								i.id === "llm-provider" ? { ...i, done: true } : i,
							),
						),
					),
				);
			}
			return Promise.reject(new Error(`unexpected fetch: ${url}`));
		});
		await renderPage();
		await startFresh();
		// The provider step body renders regardless of completion state.
		expect(screen.getByLabelText("KI Connect API key")).toBeTruthy();
	});
});

describe("onboarding wizard — docs-index step (2.7.0 card inside the shell)", () => {
	/** Script the page + card fetch routes driven by the given body makers. */
	function scriptPageAndCard(handlers: {
		onboardingStatus?: () => unknown;
		docsStatus?: () => unknown;
		docsPost?: (body: Record<string, unknown>, init: RequestInit) => unknown;
	}) {
		fetchMock.mockImplementation((url: string, init?: RequestInit) => {
			if (String(url).includes("/api/onboarding/status")) {
				return Promise.resolve(
					jsonResponse(handlers.onboardingStatus?.() ?? statusBody(NO_INDEX_ITEMS)),
				);
			}
			if (String(url).includes("/api/onboarding/docs-embeddings/status")) {
				return Promise.resolve(
					jsonResponse(handlers.docsStatus?.() ?? { job: null }),
				);
			}
			if (
				String(url).includes("/api/onboarding/docs-embeddings") &&
				init?.method === "POST"
			) {
				const body = init.body
					? (JSON.parse(String(init.body)) as Record<string, unknown>)
					: {};
				return Promise.resolve(
					(handlers.docsPost ?? (() => jsonResponse({ ok: true, started: true })))(
						body,
						init,
					),
				);
			}
			return Promise.reject(new Error(`unexpected fetch: ${url}`));
		});
	}

	async function navigateToDocs(): Promise<void> {
		await renderPage();
		await startFresh();
		await nextStep(); // provider → docs-index
	}

	it("offers the three options inside the docs-index step when no index exists", async () => {
		scriptPageAndCard({});
		await navigateToDocs();
		expect(
			await screen.findByRole("button", { name: /A — Download prebuilt vectors/ }),
		).toBeTruthy();
		expect(screen.getByRole("button", { name: /B — Build vectors locally/ })).toBeTruthy();
		expect(screen.getByRole("button", { name: /C — Skip vectors, BM25 only/ })).toBeTruthy();
	});

	it("starts a download and refreshes the status when it finishes", async () => {
		scriptPageAndCard({
			docsPost: () => jsonResponse({ ok: true, alreadyPresent: false, output: "" }),
		});
		await navigateToDocs();
		const before = statusCalls();

		await fireEvent.click(
			await screen.findByRole("button", { name: /A — Download prebuilt vectors/ }),
		);
		expect(await screen.findByText("Prebuilt vectors downloaded")).toBeTruthy();

		// ondone = refreshStatus → the wizard's status was re-evaluated.
		await waitFor(() => expect(statusCalls()).toBeGreaterThan(before));
		const postCalls = fetchMock.mock.calls.filter(
			([u, init]) =>
				String(u).includes("/api/onboarding/docs-embeddings") &&
				(init as RequestInit | undefined)?.method === "POST",
		);
		expect(JSON.parse(String((postCalls[0]?.[1] as RequestInit).body))).toEqual({
			mode: "download",
		});
	});

	it("skips via an explicit confirm and keeps the step not-done", async () => {
		scriptPageAndCard({
			docsPost: () => jsonResponse({ ok: true, skipped: true }),
		});
		await navigateToDocs();

		await fireEvent.click(
			await screen.findByRole("button", { name: /C — Skip vectors, BM25 only/ }),
		);
		expect(screen.getByText(/BM25 still finds exact API names/)).toBeTruthy();
		await fireEvent.click(screen.getByRole("button", { name: /Confirm skip/ }));

		expect(await screen.findByText(/Semantic leg disabled — BM25-only/)).toBeTruthy();
		// Welcome + seed are done; the docs-index step stays not-done
		// (provider is also not-done in this fixture), so exactly two Done
		// badges render on the rail.
		expect(screen.getAllByText("Done")).toHaveLength(2);
	});

	it("shows the installed compact state when the docs index already exists", async () => {
		scriptPageAndCard({ onboardingStatus: () => statusBody(DEFAULT_ITEMS) });
		await navigateToDocs();
		expect(
			await screen.findByText(
				/Semantic vectors are installed — search uses BM25 \+ vector retrieval\./,
			),
		).toBeTruthy();
	});
});

describe("onboarding wizard — executor step", () => {
	async function navigateToExecutor(): Promise<void> {
		await renderPage();
		await startFresh();
		await nextStep(); // provider → docs-index
		await nextStep(); // docs-index → executor
	}

	it("probes the executor on entering the step and shows the success card", async () => {
		await navigateToExecutor();
		expect(await screen.findByText("Executor reachable")).toBeTruthy();
		expect(screen.getByText("2.8.0")).toBeTruthy();
		expect(screen.getByText("ok")).toBeTruthy();
	});

	it("shows the unreachable state with Re-probe and Skip", async () => {
		fetchMock.mockImplementation((url: string) => {
			if (String(url).includes("/api/onboarding/status")) {
				return Promise.resolve(jsonResponse(statusBody(NO_INDEX_ITEMS)));
			}
			if (String(url).includes("/api/executor/health")) {
				return Promise.resolve(
					jsonResponse({
						ok: false,
						reachable: false,
						error: "connect ECONNREFUSED 127.0.0.1:8000",
					}),
				);
			}
			return Promise.reject(new Error(`unexpected fetch: ${url}`));
		});
		await navigateToExecutor();
		expect(await screen.findByText("Executor unreachable")).toBeTruthy();
		expect(screen.getByRole("button", { name: /Re-probe/ })).toBeTruthy();
		expect(screen.getByRole("button", { name: /Skip — I'll check it later/ })).toBeTruthy();
	});
});

describe("onboarding wizard — seed step", () => {
	async function navigateToSeed(): Promise<void> {
		await renderPage();
		await startFresh();
		await nextStep(); // provider → docs-index
		await nextStep(); // docs-index → executor
		await nextStep(); // executor → seed
	}

	function scriptDefault(statusItems: typeof DEFAULT_ITEMS) {
		fetchMock.mockImplementation((url: string, init?: RequestInit) => {
			if (String(url).includes("/api/onboarding/status")) {
				return Promise.resolve(jsonResponse(statusBody(statusItems)));
			}
			if (String(url).includes("/api/executor/health")) {
				return Promise.resolve(jsonResponse(EXECUTOR_HEALTH_OK));
			}
			if (String(url).includes("/api/onboarding/seed") && init?.method === "POST") {
				return Promise.resolve(jsonResponse(SEED_OK));
			}
			return Promise.reject(new Error(`unexpected fetch: ${url}`));
		});
	}

	it("installs the reference assignment and shows the success card", async () => {
		scriptDefault(NO_INDEX_ITEMS);
		await navigateToSeed();

		await fireEvent.click(
			screen.getByRole("button", { name: /Install reference assignment/ }),
		);
		expect(await screen.findByText("Reference assignment enabled")).toBeTruthy();
		expect(screen.getByText(/soil_contamination is ready/)).toBeTruthy();
	});

	it("surfaces the missing-files list on a broken install (422)", async () => {
		scriptDefault(NO_INDEX_ITEMS);
		fetchMock.mockImplementation((url: string, init?: RequestInit) => {
			if (String(url).includes("/api/onboarding/status")) {
				return Promise.resolve(jsonResponse(statusBody(NO_INDEX_ITEMS)));
			}
			if (String(url).includes("/api/executor/health")) {
				return Promise.resolve(jsonResponse(EXECUTOR_HEALTH_OK));
			}
			if (String(url).includes("/api/onboarding/seed") && init?.method === "POST") {
				return Promise.resolve(
					jsonResponse(
						{
							ok: false,
							assignmentId: "soil_contamination",
							alreadyEnabled: false,
							missingFiles: ["data/scoring/soil_contamination.yaml"],
						},
						422,
					),
				);
			}
			return Promise.reject(new Error(`unexpected fetch: ${url}`));
		});
		await navigateToSeed();

		await fireEvent.click(
			screen.getByRole("button", { name: /Install reference assignment/ }),
		);
		expect(await screen.findByText("Broken install")).toBeTruthy();
		expect(screen.getByText("data/scoring/soil_contamination.yaml")).toBeTruthy();
	});
});

describe("onboarding wizard — done step", () => {
	it("finish dismisses the wizard and navigates to submissions", async () => {
		// Provider done, docs-index NOT done — the only skipped step.
		const providerDoneNoIndex = NO_INDEX_ITEMS.map((i) =>
			i.id === "llm-provider" ? { ...i, done: true } : i,
		);
		fetchMock.mockImplementation((url: string, init?: RequestInit) => {
			if (String(url).includes("/api/onboarding/status")) {
				return Promise.resolve(jsonResponse(statusBody(providerDoneNoIndex)));
			}
			if (String(url).includes("/api/executor/health")) {
				return Promise.resolve(jsonResponse(EXECUTOR_HEALTH_OK));
			}
			if (String(url).includes("/api/onboarding/dismiss") && init?.method === "POST") {
				return Promise.resolve(jsonResponse({ ok: true }));
			}
			return Promise.reject(new Error(`unexpected fetch: ${url}`));
		});
		await renderPage();
		await startFresh();
		await nextStep(); // provider → docs-index
		await nextStep(); // docs-index → executor
		await nextStep(); // executor → seed
		await nextStep(); // seed → done

		// Summary: provider done, docs-index skipped (not-done), executor
		// done (probe passed), seed done.
		expect(screen.getByText("Skipped")).toBeTruthy();
		expect(
			screen.getByRole("link", { name: /Run your first grading pass/ }),
		).toBeTruthy();

		await fireEvent.click(
			screen.getByRole("button", { name: /Finish & open submissions/ }),
		);
		await waitFor(() => expect(nav.goto).toHaveBeenCalledWith("/submissions"));
		expect(nav.invalidateAll).toHaveBeenCalled();
		const dismissCalls = fetchMock.mock.calls.filter(
			([u, init]) =>
				String(u).includes("/api/onboarding/dismiss") &&
				(init as RequestInit | undefined)?.method === "POST",
		);
		expect(dismissCalls.length).toBe(1);
	});
});