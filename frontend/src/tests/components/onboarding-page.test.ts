/**
 * @file Component tests — onboarding page (two-path setup).
 *
 * Covers B1 (restore card: two-click confirm, success refresh, failure
 * surface, download link), B2 (in-place LLM setup: key + model save,
 * recommended tagging, static fallback) and B3 (first-run callout copy on
 * the dashboard is asserted in first-run-callout.test.ts).
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";

import OnboardingPage from "../../routes/onboarding/+page.svelte";
import * as settingsApi from "$lib/services/settings-api.js";

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

/** Default status: llm-provider NOT done (the expandable case). */
const DEFAULT_ITEMS = [
	{ id: "create-assignment", done: true },
	{ id: "wire-scoring", done: true },
	{ id: "llm-provider", done: false },
	{ id: "docs-index", done: true },
	{ id: "first-pipeline", done: false },
];

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

	// The page calls GET /api/onboarding/status on mount (and after saves).
	fetchMock.mockImplementation((url: string) => {
		if (String(url).includes("/api/onboarding/status")) {
			return Promise.resolve({
				ok: true,
				json: () => Promise.resolve(statusBody(DEFAULT_ITEMS)),
			});
		}
		return Promise.reject(new Error(`unexpected fetch: ${url}`));
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
});

async function renderPage() {
	const result = render(OnboardingPage);
	// Wait for the initial status load to settle.
	await waitFor(() => expect(screen.getByText(/First-run setup checklist/)).toBeTruthy());
	return result;
}

describe("onboarding page — restore card (B1)", () => {
	it("renders the restore card with the explicit title and copy", async () => {
		await renderPage();
		expect(screen.getByText("Restore a backup from another machine")).toBeTruthy();
		expect(
			screen.getByText(/restore your backup zip and most setup is already done/i),
		).toBeTruthy();
	});

	it("offers a download link for the current backup", async () => {
		await renderPage();
		const link = screen.getByRole("link", { name: /Download current backup/ });
		expect(link.getAttribute("href")).toBe("/api/backup");
	});

	it("requires a two-click confirm before restoring, then refreshes the status", async () => {
		await renderPage();

		// Pick a file (jsdom File is available; only the name matters here).
		const fileInput = document.querySelector<HTMLInputElement>('input[type="file"]');
		expect(fileInput).not.toBeNull();
		if (!fileInput) return;

		// No restore happens before confirmation.
		expect(screen.queryByRole("button", { name: /Confirm restore/ })).toBeNull();

		const file = new File(["zip-bytes"], "backup.zip", { type: "application/zip" });
		await fireEvent.change(fileInput, { target: { files: [file] } });
		expect(screen.getByRole("button", { name: /Confirm restore/ })).toBeTruthy();

		// Now confirm → POST /api/backup, then status refresh.
		fetchMock.mockImplementation((url: string, init?: RequestInit) => {
			if (String(url).includes("/api/backup") && init?.method === "POST") {
				return Promise.resolve({ ok: true, json: () => Promise.resolve({ restored: 42 }) });
			}
			if (String(url).includes("/api/onboarding/status")) {
				return Promise.resolve({
					ok: true,
					json: () =>
						Promise.resolve(
							statusBody(
								DEFAULT_ITEMS.map((i) =>
									i.id === "llm-provider" ? { ...i, done: true } : i,
								),
							),
						),
				});
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
			await screen.findByText(/Backup restored — the checklist below has been re-evaluated/),
		).toBeTruthy();
	});

	it("surfaces the server error on a failed restore and does not refresh", async () => {
		await renderPage();

		const fileInput = document.querySelector<HTMLInputElement>('input[type="file"]');
		expect(fileInput).not.toBeNull();
		if (!fileInput) return;

		const file = new File(["zip-bytes"], "backup.zip", { type: "application/zip" });
		await fireEvent.change(fileInput, { target: { files: [file] } });

		fetchMock.mockImplementation((url: string, init?: RequestInit) => {
			if (String(url).includes("/api/backup") && init?.method === "POST") {
				return Promise.resolve({
					ok: false,
					status: 400,
					json: () => Promise.resolve({ error: "Could not restore backup: corrupt zip" }),
				});
			}
			if (String(url).includes("/api/onboarding/status")) {
				return Promise.resolve({
					ok: true,
					json: () => Promise.resolve(statusBody(DEFAULT_ITEMS)),
				});
			}
			return Promise.reject(new Error(`unexpected fetch: ${url}`));
		});

		const statusCallsBefore = fetchMock.mock.calls.filter(([u]) =>
			String(u).includes("/api/onboarding/status"),
		).length;

		await fireEvent.click(screen.getByRole("button", { name: /Confirm restore/ }));

		expect(
			await screen.findByText(/Could not restore: Could not restore backup: corrupt zip/),
		).toBeTruthy();
		const statusCallsAfter = fetchMock.mock.calls.filter(([u]) =>
			String(u).includes("/api/onboarding/status"),
		).length;
		// No refresh after a failed restore (same count as before the click).
		expect(statusCallsAfter).toBe(statusCallsBefore);
	});
});

describe("onboarding page — in-place LLM setup (B2)", () => {
	it("expands the llm-provider item with a key field and model picker when not done", async () => {
		await renderPage();
		expect(screen.getByLabelText("KI Connect API key")).toBeTruthy();
		expect(screen.getByLabelText("Model")).toBeTruthy();
		expect(screen.getByRole("button", { name: /Save key & model/ })).toBeTruthy();
	});

	it("tags the recommended grading model when present in the live list", async () => {
		await renderPage();
		await waitFor(() => expect(mockedFetchModels).toHaveBeenCalled());
		const options = screen.getAllByRole("option") as HTMLOptionElement[];
		const recommended = options.find((o) => o.textContent?.includes("Recommended"));
		expect(recommended).toBeTruthy();
		expect(recommended?.value).toBe("openai-gpt-oss-120b");
		const fast = options.find((o) => o.textContent?.includes("Fast"));
		expect(fast?.value).toBe("qwen3-30b-a3b-instruct-2507");
	});

	it("saves the key (PATCH) + model (PUT) and refreshes the status", async () => {
		await renderPage();
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
		expect(
			await screen.findByText(/you can also set KI_CONNECT_API_KEY in your .env/),
		).toBeTruthy();
	});

	it("does not expand the llm-provider item when it is already done", async () => {
		fetchMock.mockImplementation((url: string) => {
			if (String(url).includes("/api/onboarding/status")) {
				return Promise.resolve({
					ok: true,
					json: () =>
						Promise.resolve(
							statusBody(
								DEFAULT_ITEMS.map((i) =>
									i.id === "llm-provider" ? { ...i, done: true } : i,
								),
							),
						),
				});
			}
			return Promise.reject(new Error(`unexpected fetch: ${url}`));
		});
		await renderPage();
		expect(screen.queryByLabelText("KI Connect API key")).toBeNull();
	});

	it("clears a transient status error once a later refresh succeeds (restore path)", async () => {
		// Initial status load FAILS → page shows the error state.
		fetchMock.mockImplementation((url: string, init?: RequestInit) => {
			if (String(url).includes("/api/onboarding/status")) {
				return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
			}
			if (String(url).includes("/api/backup") && init?.method === "POST") {
				return Promise.resolve({ ok: true, json: () => Promise.resolve({ restored: 1 }) });
			}
			return Promise.reject(new Error(`unexpected fetch: ${url}`));
		});
		await renderPage();
		expect(await screen.findByText(/Could not load setup status/)).toBeTruthy();

		// A successful restore triggers refreshStatus() → status succeeds now.
		fetchMock.mockImplementation((url: string, init?: RequestInit) => {
			if (String(url).includes("/api/onboarding/status")) {
				return Promise.resolve({
					ok: true,
					json: () => Promise.resolve(statusBody(DEFAULT_ITEMS)),
				});
			}
			if (String(url).includes("/api/backup") && init?.method === "POST") {
				return Promise.resolve({ ok: true, json: () => Promise.resolve({ restored: 1 }) });
			}
			return Promise.reject(new Error(`unexpected fetch: ${url}`));
		});

		const fileInput = document.querySelector<HTMLInputElement>('input[type="file"]');
		expect(fileInput).not.toBeNull();
		if (!fileInput) return;
		const file = new File(["zip-bytes"], "backup.zip", { type: "application/zip" });
		await fireEvent.change(fileInput, { target: { files: [file] } });
		await fireEvent.click(screen.getByRole("button", { name: /Confirm restore/ }));

		// Error state clears: the checklist renders again.
		await waitFor(() => expect(screen.getByText(/First-run setup checklist/)).toBeTruthy());
		expect(screen.queryByText(/Could not load setup status/)).toBeNull();
	});
});

describe("onboarding page — docs-index three-choice card (2.7.0)", () => {
	/** docs-index NOT done: the card must offer the A/B/C options. */
	const NO_INDEX_ITEMS = DEFAULT_ITEMS.map((i) =>
		i.id === "docs-index" ? { ...i, done: false } : i,
	);

	/** Install the page + card fetch routes driven by the given body makers. */
	function scriptPageAndCard(handlers: {
		onboardingStatus?: () => unknown;
		docsStatus?: () => unknown;
		docsPost?: (body: Record<string, unknown>, init: RequestInit) => unknown;
	}) {
		fetchMock.mockImplementation((url: string, init?: RequestInit) => {
			if (String(url).includes("/api/onboarding/status")) {
				return Promise.resolve({
					ok: true,
					json: () =>
						Promise.resolve(
							handlers.onboardingStatus?.() ?? statusBody(NO_INDEX_ITEMS),
						),
				});
			}
			if (String(url).includes("/api/onboarding/docs-embeddings/status")) {
				return Promise.resolve({
					ok: true,
					json: () => Promise.resolve(handlers.docsStatus?.() ?? { job: null }),
				});
			}
			if (
				String(url).includes("/api/onboarding/docs-embeddings") &&
				init?.method === "POST"
			) {
				const body = init.body
					? (JSON.parse(String(init.body)) as Record<string, unknown>)
					: {};
				return Promise.resolve(
					(
						handlers.docsPost ??
						(() => ({
							ok: true,
							json: () => Promise.resolve({ ok: true, started: true }),
						}))
					)(body, init),
				);
			}
			return Promise.reject(new Error(`unexpected fetch: ${url}`));
		});
	}

	it("offers the three options inside the docs-index item when no index exists", async () => {
		scriptPageAndCard({});
		await renderPage();
		expect(screen.getByText("Fetch the offline docs index")).toBeTruthy();
		// The card polls its own status on mount before revealing the options.
		expect(
			await screen.findByRole("button", { name: /A — Download prebuilt vectors/ }),
		).toBeTruthy();
		expect(screen.getByRole("button", { name: /B — Build vectors locally/ })).toBeTruthy();
		expect(screen.getByRole("button", { name: /C — Skip vectors, BM25 only/ })).toBeTruthy();
	});

	it("starts a download and refreshes the checklist when it finishes", async () => {
		scriptPageAndCard({
			docsPost: () => ({
				ok: true,
				json: () => Promise.resolve({ ok: true, alreadyPresent: false, output: "" }),
			}),
		});
		await renderPage();
		const statusCallsBefore = fetchMock.mock.calls.filter(([u]) =>
			String(u).includes("/api/onboarding/status"),
		).length;

		await fireEvent.click(
			await screen.findByRole("button", { name: /A — Download prebuilt vectors/ }),
		);
		expect(await screen.findByText("Prebuilt vectors downloaded")).toBeTruthy();

		// ondone = refreshStatus → the checklist was re-evaluated.
		await waitFor(() => {
			const statusCallsAfter = fetchMock.mock.calls.filter(([u]) =>
				String(u).includes("/api/onboarding/status"),
			).length;
			expect(statusCallsAfter).toBeGreaterThan(statusCallsBefore);
		});
		const postCalls = fetchMock.mock.calls.filter(
			([u, init]) =>
				String(u).includes("/api/onboarding/docs-embeddings") &&
				(init as RequestInit | undefined)?.method === "POST",
		);
		expect(postCalls.length).toBe(1);
		expect(JSON.parse(String((postCalls[0]?.[1] as RequestInit).body))).toEqual({
			mode: "download",
		});
	});

	it("skips via an explicit confirm, posts mode skip, and keeps the item not-done", async () => {
		scriptPageAndCard({
			docsPost: () => ({
				ok: true,
				json: () => Promise.resolve({ ok: true, skipped: true }),
			}),
		});
		await renderPage();
		expect(screen.queryByText(/Semantic leg disabled — BM25-only/)).toBeNull();

		await fireEvent.click(
			await screen.findByRole("button", { name: /C — Skip vectors, BM25 only/ }),
		);
		expect(screen.getByText(/BM25 still finds exact API names/)).toBeTruthy();
		await fireEvent.click(screen.getByRole("button", { name: /Confirm skip/ }));

		expect(await screen.findByText(/Semantic leg disabled — BM25-only/)).toBeTruthy();
		const postCalls = fetchMock.mock.calls.filter(
			([u, init]) =>
				String(u).includes("/api/onboarding/docs-embeddings") &&
				(init as RequestInit | undefined)?.method === "POST",
		);
		expect(JSON.parse(String((postCalls[0]?.[1] as RequestInit).body))).toEqual({
			mode: "skip",
		});
		// No index exists → the checklist item keeps its "To do" badge.
		expect(screen.getAllByText("To do").length).toBeGreaterThan(0);
		expect(screen.queryByText(/Semantic vectors are installed/)).toBeNull();
	});

	it("shows the installed compact state when the docs index is already present", async () => {
		scriptPageAndCard({ onboardingStatus: () => statusBody(DEFAULT_ITEMS) });
		await renderPage();
		expect(
			await screen.findByText(
				/Semantic vectors are installed — search uses BM25 \+ vector retrieval\./,
			),
		).toBeTruthy();
	});
});
