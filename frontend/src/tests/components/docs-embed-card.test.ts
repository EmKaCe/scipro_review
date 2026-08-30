/**
 * @file Component tests — DocsEmbedCard (2.7.0 three-option docs-embeddings
 * onboarding card, used on the onboarding checklist and the Settings page).
 *
 * Covers the §4.1 state machine (idle A/B/C → running → done/failed),
 * the handshake with POST /api/onboarding/docs-embeddings and the 2s
 * GET status polling loop (the repo's established cadence), the §4.2
 * settings confirm-dialog semantics (no silent overwrite, overwrite:true
 * only after explicit confirmation), and the §4.3 error treatments
 * (409 conflict note + job adoption, 422 no-key hint, provider failure
 * with Retry, interrupted recovery, wrong-dim batch summary).
 *
 * All network calls are mocked at the fetch layer — never real network.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";

import DocsEmbedCard from "../../lib/components/onboarding/DocsEmbedCard.svelte";

vi.mock("$app/paths", () => ({ base: "" }));

/** Job shape mirroring the pinned status contract (W2-A DocsEmbedJobState). */
interface JobSource {
	kind: "fetch" | "embed";
	phase: "fetch-chunks" | "embed" | "finalize" | "done" | "failed" | "cancelled" | "interrupted";
	startedAt: number;
	done: number;
	total: number;
	ratePerSecond: number;
	etaSeconds: number;
	failedBatches: number;
	model: string;
	error: string | null;
}

function embedJob(overrides: Partial<JobSource> = {}): JobSource {
	return {
		kind: "embed",
		phase: "embed",
		startedAt: Date.now(),
		done: 0,
		total: 38_380,
		ratePerSecond: 0,
		etaSeconds: 0,
		failedBatches: 0,
		model: "e5-mistral-7b-instruct",
		error: null,
		...overrides,
	};
}

/** Response-like object for the fetch mock. */
function resp(body: unknown, ok = true, status = 200) {
	return { ok, status, json: () => Promise.resolve(body) };
}

const STATUS_URL = "/api/onboarding/docs-embeddings/status";
const POST_URL = "/api/onboarding/docs-embeddings";

interface RouteHandlers {
	/** GET /api/onboarding/docs-embeddings/status — returns the raw job
	 *  (installFetch wraps it in `{ job }`, mirroring the API). */
	status: () => JobSource | null;
	/** POST /api/onboarding/docs-embeddings */
	post: (body: Record<string, unknown>) => {
		ok: boolean;
		status?: number;
		body?: unknown;
		/** Optional deferred body — lets a test hold the response open to
		 *  observe the in-flight running state. */
		json?: () => Promise<unknown>;
	};
	/** DELETE /api/onboarding/docs-embeddings */
	del?: () => { ok: boolean; status?: number; body: unknown };
	/** GET /api/onboarding/status (settings presence probe) — returns the
	 *  docs-index item's done value. */
	onboardingStatus?: () => boolean;
	/** GET /api/settings (settings model probe) */
	settings?: () => void;
}

let fetchMock: ReturnType<typeof vi.fn>;
let ondone: ReturnType<typeof vi.fn>;

/** Install a fetch mock driven by the given per-route handlers. */
function installFetch(handlers: RouteHandlers): void {
	fetchMock.mockImplementation((url: RequestInfo | URL, init?: RequestInit) => {
		const href = String(url);
		const method = init?.method ?? "GET";
		if (method === "GET" && href === STATUS_URL) {
			return Promise.resolve(resp({ job: handlers.status() }));
		}
		if (method === "POST" && href === POST_URL) {
			const body = init?.body
				? (JSON.parse(String(init.body)) as Record<string, unknown>)
				: {};
			const result = handlers.post(body);
			return Promise.resolve(
				result.json
					? { ok: result.ok, status: result.status ?? 200, json: result.json }
					: resp(result.body, result.ok, result.status ?? 200),
			);
		}
		if (method === "DELETE" && href === POST_URL) {
			const result = handlers.del
				? handlers.del()
				: { ok: true, body: { ok: true, cancelling: true } };
			return Promise.resolve(resp(result.body, result.ok, result.status ?? 200));
		}
		if (method === "GET" && href === "/api/onboarding/status") {
			if (!handlers.onboardingStatus) {
				return Promise.reject(new Error(`unexpected fetch: GET /api/onboarding/status`));
			}
			const done = handlers.onboardingStatus();
			return Promise.resolve(resp({ items: [{ id: "docs-index", done }] }));
		}
		if (method === "GET" && href === "/api/settings") {
			if (!handlers.settings) {
				return Promise.reject(new Error(`unexpected fetch: GET /api/settings`));
			}
			handlers.settings();
			return Promise.resolve(resp({ llm: { embeddingModel: "custom-embed-1" } }));
		}
		return Promise.reject(new Error(`unexpected fetch: ${method} ${href}`));
	});
}

/** Default: no job anywhere; every POST succeeds with started:true. */
function defaultHandlers(): RouteHandlers {
	return {
		status: () => null,
		post: () => ({ ok: true, body: { ok: true, started: true } }),
	};
}

function renderCard(props: { context: "onboarding" | "settings"; indexPresent?: boolean | null }) {
	ondone = vi.fn(() => {});
	return render(DocsEmbedCard, {
		// @testing-library/svelte v5 (Svelte 5) takes all component props
		// under the `props` key. The mock is structurally a function; cast for
		// the prop's () => void type.
		props: {
			context: props.context,
			indexPresent: props.indexPresent ?? null,
			ondone: ondone as () => void,
		},
	});
}

/** Flush pending promises/microtasks (timer-agnostic — most tests run with
 * real timers; fake-timer tests additionally advanceTimersByTimeAsync). */
async function settle(): Promise<void> {
	// A handful of microtask hops covers the fetch-mock → state → effect
	// → follow-up-fetch chains used across these tests.
	for (let i = 0; i < 10; i += 1) {
		await Promise.resolve();
	}
}

async function clickButton(name: RegExp): Promise<void> {
	await fireEvent.click(screen.getByRole("button", { name }));
}

beforeEach(() => {
	vi.clearAllMocks();
	fetchMock = vi.fn();
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("idle — three-option card", () => {
	it("renders the A/B/C option rows with the design copy", async () => {
		installFetch(defaultHandlers());
		renderCard({ context: "onboarding", indexPresent: false });
		await settle();

		expect(screen.getByRole("button", { name: /A — Download prebuilt vectors/ })).toBeTruthy();
		expect(
			screen.getByText(/e5-mistral-7b-instruct · 4096-dim · no API key needed/),
		).toBeTruthy();
		expect(screen.getByRole("button", { name: /B — Build vectors locally/ })).toBeTruthy();
		expect(
			screen.getByText(/Uses your configured endpoint \+ model · API key required/),
		).toBeTruthy();
		expect(screen.getByRole("button", { name: /C — Skip vectors, BM25 only/ })).toBeTruthy();
		expect(
			screen.getByText(/Exact API names still found; paraphrase queries weaken/),
		).toBeTruthy();
	});

	it("renders the settings variant heading when context is settings", async () => {
		installFetch(defaultHandlers());
		renderCard({ context: "settings" });
		await settle();
		expect(screen.getByText(/Docs index — semantic search vectors/)).toBeTruthy();
	});
});

describe("option A — download prebuilt", () => {
	it("POSTs mode download, shows the spinner, finishes with the prebuilt summary", async () => {
		const posts: Array<Record<string, unknown>> = [];
		// Defer the response body so the in-flight "Downloading…" state is
		// observable (a real download takes minutes server-side).
		let releaseDownload: () => void = () => {};
		const downloadJson = new Promise<unknown>((resolve) => {
			releaseDownload = () => resolve({ ok: true, alreadyPresent: false, output: "" });
		});
		installFetch({
			status: () => null,
			post: (body) => {
				posts.push(body);
				return { ok: true, status: 200, json: () => downloadJson };
			},
		});
		renderCard({ context: "onboarding", indexPresent: false });
		await settle();

		await clickButton(/A — Download prebuilt vectors/);
		// During the awaited POST the running branch shows the download spinner.
		expect(screen.getByText(/Downloading prebuilt vectors…/)).toBeTruthy();

		releaseDownload();
		await screen.findByText("Prebuilt vectors downloaded");
		expect(screen.getByText(/e5-mistral-7b-instruct · 4096-dim/)).toBeTruthy();
		expect(posts).toEqual([{ mode: "download" }]);
		expect(ondone).toHaveBeenCalledTimes(1);
	});

	it("treats an already-present fast path as done (no job to follow)", async () => {
		installFetch({
			status: () => null,
			post: () => ({ ok: true, body: { ok: true, alreadyPresent: true, output: "" } }),
		});
		renderCard({ context: "onboarding", indexPresent: false });
		await settle();

		await clickButton(/A — Download prebuilt vectors/);
		expect(await screen.findByText("Prebuilt vectors downloaded")).toBeTruthy();
		expect(ondone).toHaveBeenCalledTimes(1);
	});
});

describe("option B — rebuild locally with live progress", () => {
	it("adopts the started job, renders live progress, and finishes with the model summary", async () => {
		vi.useFakeTimers();
		try {
			let started = false;
			let currentJob: JobSource | null = null;
			installFetch({
				status: () => currentJob,
				post: (body) => {
					expect(body).toEqual({ mode: "rebuild" });
					started = true;
					currentJob = embedJob({ phase: "embed", total: 38_380 });
					return { ok: true, body: { ok: true, started: true } };
				},
			});
			renderCard({ context: "onboarding", indexPresent: false });
			await settle();

			await clickButton(/B — Build vectors locally/);
			await settle(); // POST resolves → running adopt poll
			expect(screen.getByText(/Building vectors locally…/)).toBeTruthy();

			// Progress populates on the next 2s tick.
			currentJob = embedJob({
				phase: "embed",
				done: 21_403,
				total: 38_380,
				ratePerSecond: 42.3,
				etaSeconds: 360,
				model: "qwen3-30b-a3b-instruct-2507",
			});
			await vi.advanceTimersByTimeAsync(2000);
			await settle();

			const progress = screen.getByText(/embedded 21,403 \/ 38,380/, { selector: "p" });
			expect(progress.textContent).toContain("42.3 texts/s");
			expect(progress.textContent).toContain("ETA 6 min");
			expect(screen.getByText(/embedding/)).toBeTruthy();

			// Job completes → done summary with the resolved model.
			currentJob = embedJob({
				phase: "done",
				done: 38_380,
				total: 38_380,
				model: "qwen3-30b-a3b-instruct-2507",
			});
			await vi.advanceTimersByTimeAsync(2000);
			await settle();

			expect(await screen.findByText("Vectors rebuilt with your model")).toBeTruthy();
			expect(screen.getByText(/qwen3-30b-a3b-instruct-2507/)).toBeTruthy();
			expect(ondone).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("shows the phase badge for fetch-chunks and finalize", async () => {
		vi.useFakeTimers();
		try {
			let currentJob: JobSource | null = null;
			const started = { value: false };
			installFetch({
				status: () => currentJob,
				post: () => {
					started.value = true;
					currentJob = embedJob({ phase: "fetch-chunks", done: 0, total: 1 });
					return { ok: true, body: { ok: true, started: true } };
				},
			});
			renderCard({ context: "onboarding", indexPresent: false });
			await settle();
			await clickButton(/B — Build vectors locally/);
			await settle();

			expect(screen.getByText(/fetching chunks/)).toBeTruthy();

			currentJob = embedJob({ phase: "finalize", done: 38_380, total: 38_380 });
			await vi.advanceTimersByTimeAsync(2000);
			await settle();
			expect(screen.getByText(/finalizing/)).toBeTruthy();
		} finally {
			vi.useRealTimers();
		}
	});

	it("cancels via DELETE and returns to the options on the cancelled phase", async () => {
		vi.useFakeTimers();
		try {
			let currentJob: JobSource | null = null;
			let deletes = 0;
			installFetch({
				status: () => currentJob,
				post: () => {
					currentJob = embedJob({ phase: "embed" });
					return { ok: true, body: { ok: true, started: true } };
				},
				del: () => {
					deletes += 1;
					return { ok: true, body: { ok: true, cancelling: true } };
				},
			});
			renderCard({ context: "onboarding", indexPresent: false });
			await settle();
			await clickButton(/B — Build vectors locally/);
			await settle();

			await clickButton(/Cancel/);
			expect(deletes).toBe(1);

			currentJob = embedJob({
				phase: "cancelled",
				done: 100,
				error: "Embed rebuild cancelled.",
			});
			await vi.advanceTimersByTimeAsync(2000);
			await settle();

			expect(screen.getByText(/Cancelled — nothing was changed\./)).toBeTruthy();
			expect(screen.getByRole("button", { name: /B — Build vectors locally/ })).toBeTruthy();
		} finally {
			vi.useRealTimers();
		}
	});

	it("summarizes wrong-dimension batches on the done state", async () => {
		vi.useFakeTimers();
		try {
			let started = false;
			let currentJob: JobSource | null = null;
			installFetch({
				status: () => currentJob,
				post: () => {
					started = true;
					currentJob = embedJob({ phase: "embed" });
					return { ok: true, body: { ok: true, started: true } };
				},
			});
			renderCard({ context: "onboarding", indexPresent: false });
			await settle();
			await clickButton(/B — Build vectors locally/);
			await settle();

			currentJob = embedJob({
				phase: "done",
				done: 38_380,
				total: 38_380,
				model: "qwen3-30b-a3b-instruct-2507",
				failedBatches: 3,
			});
			await vi.advanceTimersByTimeAsync(2000);
			await settle();

			expect(
				screen.getByText(
					/3 batch\(es\) with unexpected dimensions — zero-filled in the index\./,
				),
			).toBeTruthy();
			expect(
				screen.getByRole("button", { name: /Rebuild with a different model/ }),
			).toBeTruthy();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("option C — skip (BM25-only)", () => {
	it("asks for confirmation, POSTs mode skip, then shows the honest degradation note", async () => {
		const posts: Array<Record<string, unknown>> = [];
		installFetch({
			status: () => null,
			post: (body) => {
				posts.push(body);
				return { ok: true, body: { ok: true, skipped: true } };
			},
		});
		renderCard({ context: "onboarding", indexPresent: false });
		await settle();

		await clickButton(/C — Skip vectors, BM25 only/);
		expect(screen.getByText(/BM25 still finds exact API names/)).toBeTruthy();

		// Not confirmed yet — nothing was posted.
		expect(posts.length).toBe(0);
		await clickButton(/Confirm skip/);

		expect(await screen.findByText(/Semantic leg disabled — BM25-only/)).toBeTruthy();
		expect(screen.getByText(/BM25 finds exact API names/)).toBeTruthy();
		expect(posts).toEqual([{ mode: "skip" }]);
		expect(ondone).toHaveBeenCalledTimes(1);

		// "Change mind" returns to the A/B/C options.
		await clickButton(/Change mind/);
		expect(screen.getByRole("button", { name: /A — Download prebuilt vectors/ })).toBeTruthy();
	});
});

describe("error treatments (§4.3)", () => {
	it("shows the 409 note when no other job is observable", async () => {
		installFetch({
			status: () => null,
			post: () => ({
				ok: false,
				status: 409,
				body: { error: "A docs-index download/rebuild is already in progress." },
			}),
		});
		renderCard({ context: "onboarding", indexPresent: false });
		await settle();

		await clickButton(/A — Download prebuilt vectors/);
		expect(
			await screen.findByText(
				/A docs-index download\/rebuild is already running — open this page in another tab\?/,
			),
		).toBeTruthy();
		// Options stay usable; the note does not disturb anything.
		expect(screen.getByRole("button", { name: /B — Build vectors locally/ })).toBeTruthy();
	});

	it("mirrors the other tab's running job after a 409 instead of blocking", async () => {
		vi.useFakeTimers();
		try {
			let currentJob: JobSource | null = null;
			installFetch({
				status: () => currentJob,
				post: () => {
					// The other tab's job is already visible to GET status by
					// the time OUR POST gets its 409.
					currentJob = embedJob({ phase: "embed", done: 512, total: 38_380 });
					return {
						ok: false,
						status: 409,
						body: { error: "A docs-index download/rebuild is already in progress." },
					};
				},
			});
			renderCard({ context: "onboarding", indexPresent: false });
			await settle();

			await clickButton(/A — Download prebuilt vectors/);
			await settle();
			await vi.advanceTimersByTimeAsync(2000);
			await settle();

			expect(screen.getByText(/Building vectors locally…/)).toBeTruthy();
			expect(screen.getByText(/embedded 512 \/ 38,380/, { selector: "p" })).toBeTruthy();
		} finally {
			vi.useRealTimers();
		}
	});

	it("shows the 422 no-key hint on B and keeps C available", async () => {
		installFetch({
			status: () => null,
			post: () => ({
				ok: false,
				status: 422,
				body: {
					error: "No API key configured — set it in the LLM provider settings or KI_CONNECT_API_KEY.",
				},
			}),
		});
		renderCard({ context: "onboarding", indexPresent: false });
		await settle();

		await clickButton(/B — Build vectors locally/);
		expect(
			await screen.findByText(
				/set your API key in the LLM provider step above, or in `\.env`/,
			),
		).toBeTruthy();
		// C remains available.
		await clickButton(/C — Skip vectors, BM25 only/);
		expect(screen.getByText(/BM25 still finds exact API names/)).toBeTruthy();
	});

	it("surfaces a provider failure with Retry, and Retry re-POSTs", async () => {
		vi.useFakeTimers();
		try {
			let currentJob: JobSource | null = null;
			let rebuildPosts = 0;
			installFetch({
				status: () => currentJob,
				post: (body) => {
					if (body.mode !== "rebuild") {
						return { ok: false, status: 400, body: { error: "bad mode" } };
					}
					rebuildPosts += 1;
					currentJob = embedJob({ phase: "embed" });
					return { ok: true, body: { ok: true, started: true } };
				},
			});
			renderCard({ context: "onboarding", indexPresent: false });
			await settle();
			await clickButton(/B — Build vectors locally/);
			await settle();

			currentJob = embedJob({
				phase: "failed",
				error: "model qwen3-30b-a3b-instruct-2507 not available on provider — pick from the model list.",
			});
			await vi.advanceTimersByTimeAsync(2000);
			await settle();

			expect(
				screen.getByText(/model qwen3-30b-a3b-instruct-2507 not available on provider/),
			).toBeTruthy();
			expect(rebuildPosts).toBe(1);

			await clickButton(/Retry/);
			await settle();
			expect(rebuildPosts).toBe(2);
			expect(screen.getByText(/Building vectors locally…/)).toBeTruthy();
		} finally {
			vi.useRealTimers();
		}
	});

	it("treats an interrupted phase as a retryable rebuild failure", async () => {
		vi.useFakeTimers();
		try {
			let currentJob: JobSource | null = null;
			installFetch({
				status: () => currentJob,
				post: () => {
					currentJob = embedJob({ phase: "embed" });
					return { ok: true, body: { ok: true, started: true } };
				},
			});
			renderCard({ context: "onboarding", indexPresent: false });
			await settle();
			await clickButton(/B — Build vectors locally/);
			await settle();

			currentJob = embedJob({
				phase: "interrupted",
				done: 2048,
				error: "interrupted by process death",
			});
			await vi.advanceTimersByTimeAsync(2000);
			await settle();

			expect(screen.getByText(/The rebuild was interrupted/)).toBeTruthy();
			expect(screen.getByRole("button", { name: /Retry rebuild/ })).toBeTruthy();
		} finally {
			vi.useRealTimers();
		}
	});

	it("surfaces a persisted interrupted job on page load (crash recovery)", async () => {
		installFetch({
			status: () =>
				embedJob({
					phase: "interrupted",
					done: 2048,
					error: "interrupted by process death",
				}),
			post: () => ({ ok: true, body: { ok: true, started: true } }),
		});
		renderCard({ context: "onboarding", indexPresent: false });
		await settle();

		expect(await screen.findByText(/The rebuild was interrupted/)).toBeTruthy();
		expect(screen.getByRole("button", { name: /Retry rebuild/ })).toBeTruthy();
	});

	it("opens the overwrite confirm dialog when the server demands overwrite:true", async () => {
		const posts: Array<Record<string, unknown>> = [];
		installFetch({
			status: () => null,
			post: (body) => {
				posts.push(body);
				if (body.overwrite === true) {
					return { ok: true, body: { ok: true, started: true } };
				}
				return {
					ok: false,
					status: 400,
					body: { error: "Vectors already exist — pass overwrite:true to replace them." },
				};
			},
		});
		renderCard({ context: "onboarding", indexPresent: false });
		await settle();

		await clickButton(/B — Build vectors locally/); // no overwrite → 400
		await settle();

		// The honest dialog appears instead of a dead-end failure.
		expect(await screen.findByText("Rebuild semantic vectors?")).toBeTruthy();
		await clickButton(/Start rebuild/);
		await settle();

		expect(posts).toEqual([{ mode: "rebuild" }, { mode: "rebuild", overwrite: true }]);
	});
});

describe("settings variant — confirm-dialog semantics (§4.2)", () => {
	it("requires the confirm dialog before overwriting an existing index", async () => {
		const posts: Array<Record<string, unknown>> = [];
		let statusJob: JobSource | null = null;
		installFetch({
			status: () => statusJob,
			post: (body) => {
				posts.push(body);
				if (body.mode === "rebuild") {
					statusJob = embedJob({ phase: "embed" });
					return { ok: true, body: { ok: true, started: true } };
				}
				return { ok: true, body: { ok: true } };
			},
			settings: () => {
				/* model probe — response carries embeddingModel custom-embed-1 */
			},
		});
		renderCard({ context: "settings", indexPresent: true });
		await settle();

		// An installed index shows the compact state; Reconfigure opens options.
		expect(
			screen.getByText(
				/Semantic vectors are installed — search uses BM25 \+ vector retrieval\./,
			),
		).toBeTruthy();
		await clickButton(/Reconfigure/);

		await clickButton(/B — Build vectors locally/);
		// Nothing posted yet — the dialog gates the rebuild.
		expect(posts.length).toBe(0);

		const dialog = await screen.findByText("Rebuild semantic vectors?");
		expect(dialog).toBeTruthy();
		// The doc's honesty wording (§4.2) — including the resolved model.
		expect(
			screen.getByText(
				/Rebuilding replaces your current vectors \(≈ 629 MB\) with custom-embed-1\./,
			),
		).toBeTruthy();
		expect(
			screen.getByText(
				/serves from the old vectors until the swap completes, then switches atomically/,
			),
		).toBeTruthy();
		expect(screen.getByText(/A failed rebuild leaves the old index intact/)).toBeTruthy();
		expect(screen.getByText(/10–30 min of embedding API calls/)).toBeTruthy();

		// Cancel → no POST; the options stay.
		await clickButton(/Cancel/);
		expect(screen.queryByText("Rebuild semantic vectors?")).toBeNull();
		expect(posts.length).toBe(0);

		// Confirm → POST carries overwrite: true.
		await clickButton(/B — Build vectors locally/);
		await clickButton(/Start rebuild/);
		expect(posts).toEqual([{ mode: "rebuild", overwrite: true }]);
	});

	it("rebuilds without a dialog when no index exists (no overwrite flag)", async () => {
		const posts: Array<Record<string, unknown>> = [];
		installFetch({
			status: () => null,
			post: (body) => {
				posts.push(body);
				return { ok: true, body: { ok: true, started: true } };
			},
		});
		renderCard({ context: "settings", indexPresent: false });
		await settle();

		await clickButton(/B — Build vectors locally/);
		await settle();
		expect(screen.queryByText("Rebuild semantic vectors?")).toBeNull();
		expect(posts).toEqual([{ mode: "rebuild" }]);
	});

	it("probes the onboarding status when the host page does not know the index state", async () => {
		installFetch({
			status: () => null,
			post: () => ({ ok: true, body: { ok: true, started: true } }),
			onboardingStatus: () => true,
			settings: () => {
				/* model probe hit */
			},
		});
		renderCard({ context: "settings" });
		await settle();

		// Probe reports docs-index done → the installed compact state.
		expect(
			await screen.findByText(
				/Semantic vectors are installed — search uses BM25 \+ vector retrieval\./,
			),
		).toBeTruthy();
	});
});
