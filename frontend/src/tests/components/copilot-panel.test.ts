/**
 * @file L4 component test — copilot-panel thread switcher (Task T.4).
 *
 * jsdom + mocked fetch (the panel's store fetches on mount and on every
 * thread action). Covers: threads toggle opens the list, clicking a row
 * opens the thread (detail GET) and closes the list, New conversation
 * resets, the inline rename flow (Pencil -> type -> Enter -> PATCH), and
 * the two-step delete (arm on first click, commit on second, auto-disarm
 * after 4s with fake timers).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";

import CopilotPanel from "$lib/components/submissions/copilot-panel.svelte";
import * as copilot from "$lib/components/submissions/copilot-store.svelte.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const THREADS = [
	{
		id: "t-1",
		title: "Review submission 1",
		createdAt: "2026-08-01T10:00:00.000Z",
		updatedAt: "2026-08-01T12:00:00.000Z",
		messageCount: 2,
		lastPreview: "Done.",
		recallLimit: 10,
		recallCovered: 2,
		droppedCount: 0,
		estimatedTokens: 200,
	},
	{
		id: "t-2",
		title: "Second thread",
		createdAt: "2026-08-01T09:00:00.000Z",
		updatedAt: "2026-08-01T11:00:00.000Z",
		messageCount: 1,
		lastPreview: "Hi",
		recallLimit: 10,
		recallCovered: 1,
		droppedCount: 0,
		estimatedTokens: 100,
	},
];

const THREAD_DETAIL = {
	...THREADS[0],
	messages: [
		{ id: "m1", role: "user", createdAt: "2026-08-01T11:00:00.000Z", text: "Compare cell 3" },
		{ id: "m2", role: "assistant", createdAt: "2026-08-01T11:02:00.000Z", text: "Done." },
	],
};

/** A thread that has outgrown the recall window (25 stored, only 10 seen). */
const BIG_THREAD = {
	id: "t-big",
	title: "Long conversation",
	createdAt: "2026-08-01T08:00:00.000Z",
	updatedAt: "2026-08-01T13:00:00.000Z",
	messageCount: 25,
	lastPreview: "Still going",
	recallLimit: 10,
	recallCovered: 10,
	droppedCount: 15,
	estimatedTokens: 1200,
};

const BIG_DETAIL = {
	...BIG_THREAD,
	messages: Array.from({ length: 25 }, (_, i) => ({
		id: `m${i}`,
		role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
		createdAt: "2026-08-01T08:00:00.000Z",
		text: `Message ${i}`,
	})),
};

/** A long thread that has been auto-compacted twice (Task V). */
const COMPACTED_THREAD = {
	...BIG_THREAD,
	id: "t-compact",
	messageCount: 40,
	recallCovered: 10,
	droppedCount: 30,
	compactionCount: 2,
	hasSummary: true,
};

const COMPACTED_DETAIL = {
	...COMPACTED_THREAD,
	messages: Array.from({ length: 40 }, (_, i) => ({
		id: `cm${i}`,
		role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
		createdAt: "2026-08-01T08:00:00.000Z",
		text: `Message ${i}`,
	})),
};

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function bodyOf(call: [RequestInfo | URL, RequestInit?]): Record<string, unknown> {
	return JSON.parse((call[1]?.body as string) ?? "{}") as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Fetch mock — routes by URL, records calls for assertions.
// ---------------------------------------------------------------------------

let fetchMock: ReturnType<typeof vi.fn>;

/** Mutable server-side state so rename/delete reflect into later list fetches. */
let serverThreads: Array<(typeof THREADS)[number]>;

function mockThreadRoutes(threads: Array<(typeof THREADS)[number]> = THREADS): void {
	serverThreads = threads.map((t) => ({ ...t }));
	fetchMock.mockImplementation((url: RequestInfo | URL, init?: RequestInit) => {
		const u = String(url);
		if (u.includes("/api/copilot/threads/")) {
			if (init?.method === "DELETE") {
				serverThreads = serverThreads.filter((t) => !u.includes(`/threads/${t.id}`));
				return Promise.resolve(new Response(null, { status: 204 }));
			}
			if (init?.method === "PATCH") {
				const title = String(bodyOf([url, init]).title ?? "");
				const target = serverThreads.find((t) => u.includes(`/threads/${t.id}`));
				if (target) target.title = title;
				return Promise.resolve(jsonResponse({ thread: { ...target! } }));
			}
			const target = serverThreads.find((t) => u.includes(`/threads/${t.id}`));
			if (target?.id === "t-big") {
				return Promise.resolve(jsonResponse({ thread: { ...BIG_DETAIL } }));
			}
			if (target?.id === "t-compact") {
				return Promise.resolve(jsonResponse({ thread: { ...COMPACTED_DETAIL } }));
			}
			return Promise.resolve(jsonResponse({ thread: { ...THREAD_DETAIL, ...target } }));
		}
		if (u.includes("/api/copilot/threads")) {
			return Promise.resolve(jsonResponse({ threads: serverThreads }));
		}
		return Promise.resolve(jsonResponse({}));
	});
}

beforeEach(() => {
	fetchMock = vi.fn();
	vi.stubGlobal("fetch", fetchMock);
	copilot.apiMode.value = true;
	localStorage.clear();
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	copilot.apiMode.value = false;
	localStorage.clear();
});

/** Render the panel and wait for the onMount thread-list fetch. */
async function renderPanel(threads?: Array<(typeof THREADS)[number]>) {
	mockThreadRoutes(threads);
	const result = render(CopilotPanel, { submissionId: "sub-1" });
	await waitFor(() => expect(fetchMock).toHaveBeenCalled());
	return result;
}

async function openThreadList() {
	await renderPanel();
	fireEvent.click(screen.getByRole("button", { name: "Conversation history" }));
	await screen.findByText("Review submission 1");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("copilot-panel.svelte — thread switcher (T.4)", () => {
	it("loads the thread list on mount and the toggle opens the list", async () => {
		await renderPanel();

		// onMount fired a scoped list fetch.
		expect(String(fetchMock.mock.calls[0][0])).toContain(
			"/api/copilot/threads?submissionId=sub-1",
		);
		// List hidden until the toggle.
		expect(screen.queryByText("Review submission 1")).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "Conversation history" }));

		expect(await screen.findByText("Review submission 1")).toBeTruthy();
		expect(screen.getByText("Second thread")).toBeTruthy();
		// A "New conversation" row sits at the top of the list (the header
		// button is the second match).
		expect(screen.getAllByRole("button", { name: /New conversation/ })).toHaveLength(2);
	});

	it("shows the empty state when the scope has no conversations", async () => {
		fetchMock.mockResolvedValue(jsonResponse({ threads: [] }));
		render(CopilotPanel, { submissionId: "sub-1" });
		await waitFor(() => expect(fetchMock).toHaveBeenCalled());

		fireEvent.click(screen.getByRole("button", { name: "Conversation history" }));
		expect(await screen.findByText("No conversations yet")).toBeTruthy();
	});

	it("clicking a thread row opens it (detail GET), closes the list and renders history", async () => {
		await openThreadList();

		fireEvent.click(screen.getByText("Review submission 1"));

		// The detail GET for the clicked thread, scoped.
		await waitFor(() => {
			expect(
				fetchMock.mock.calls.some(
					(call) =>
						String(call[0]).includes("/api/copilot/threads/t-1?submissionId=sub-1") &&
						(call[1]?.method ?? "GET") === "GET",
				),
			).toBe(true);
		});
		// List closed, history rendered, thread id persisted.
		expect(screen.queryByText("Second thread")).toBeNull();
		expect(await screen.findByText("Compare cell 3")).toBeTruthy();
		expect(screen.getByText("Done.")).toBeTruthy();
		expect(localStorage.getItem("copilot:activeThread:sub-1")).toBe("t-1");
	});

	it("New conversation resets the transcript and clears the stored thread", async () => {
		await openThreadList();
		fireEvent.click(screen.getByText("Review submission 1"));
		await screen.findByText("Compare cell 3");
		expect(localStorage.getItem("copilot:activeThread:sub-1")).toBe("t-1");

		// The header button is the FIRST "New conversation" match (the row is
		// in the list, which is closed now).
		fireEvent.click(screen.getAllByRole("button", { name: "New conversation" })[0]);

		// Transcript reset to the empty state; storage cleared; list refreshed.
		await screen.findByText(/Ask questions about this submission/);
		expect(localStorage.getItem("copilot:activeThread:sub-1")).toBeNull();
		expect(
			fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/copilot/threads?")),
		).toBe(true);
	});

	it("renames a thread inline: Pencil -> type -> Enter -> PATCH, row updates", async () => {
		await openThreadList();

		fireEvent.click(screen.getByRole("button", { name: "Rename Review submission 1" }));

		const input = screen.getByRole("textbox", { name: "Rename Review submission 1" });
		expect(input).toBeTruthy();
		await fireEvent.input(input, { target: { value: "Renamed title" } });
		await fireEvent.keyDown(input, { key: "Enter" });

		// The PATCH call carries the trimmed title.
		await waitFor(() => {
			expect(fetchMock.mock.calls.some((call) => call[1]?.method === "PATCH")).toBe(true);
		});
		const patchCall = fetchMock.mock.calls.find((call) => call[1]?.method === "PATCH");
		expect(patchCall).toBeDefined();
		const patch = patchCall as [RequestInfo | URL, RequestInit?];
		expect(String(patch[0])).toContain("/api/copilot/threads/t-1?submissionId=sub-1");
		expect(bodyOf(patch)).toEqual({ title: "Renamed title" });
		// The refreshed list shows the new title.
		expect(await screen.findByText("Renamed title")).toBeTruthy();
	});

	it("cancels a rename with Escape (no PATCH)", async () => {
		await openThreadList();

		fireEvent.click(screen.getByRole("button", { name: "Rename Review submission 1" }));
		const input = screen.getByRole("textbox", { name: "Rename Review submission 1" });
		await fireEvent.keyDown(input, { key: "Escape" });

		// The inline rename input is gone (the chat input below is still there).
		await waitFor(() =>
			expect(
				screen.queryByRole("textbox", { name: "Rename Review submission 1" }),
			).toBeNull(),
		);
		expect(fetchMock.mock.calls.some((call) => call[1]?.method === "PATCH")).toBe(false);
	});

	it("two-step delete: first click arms, second click DELETEs", async () => {
		await openThreadList();

		const deleteBtn = screen.getByRole("button", { name: "Delete Review submission 1" });
		fireEvent.click(deleteBtn);

		// Armed — the row shows the "Delete?" label.
		expect(screen.getByText("Delete?")).toBeTruthy();
		expect(fetchMock.mock.calls.some((call) => call[1]?.method === "DELETE")).toBe(false);

		fireEvent.click(screen.getByRole("button", { name: "Delete Review submission 1" }));

		await waitFor(() => {
			expect(
				fetchMock.mock.calls.some(
					(call) =>
						call[1]?.method === "DELETE" &&
						String(call[0]).includes("/api/copilot/threads/t-1"),
				),
			).toBe(true);
		});
		// The deleted row is gone from the list.
		expect(screen.queryByText("Review submission 1")).toBeNull();
		expect(screen.getByText("Second thread")).toBeTruthy();
	});

	it("two-step delete auto-disarms after ~4s", async () => {
		vi.useFakeTimers();
		await openThreadList();

		fireEvent.click(screen.getByRole("button", { name: "Delete Review submission 1" }));
		expect(screen.getByText("Delete?")).toBeTruthy();

		await vi.advanceTimersByTimeAsync(4001);

		await waitFor(() => expect(screen.queryByText("Delete?")).toBeNull());
		// The arm expired — a later click only arms again, never deletes.
		expect(fetchMock.mock.calls.some((call) => call[1]?.method === "DELETE")).toBe(false);
	});

	it("shows the context line + dropped-from-context warning when messages are outside the window (U.4)", async () => {
		await renderPanel([{ ...BIG_THREAD }]);
		fireEvent.click(screen.getByRole("button", { name: "Conversation history" }));
		await screen.findByText("Long conversation");

		fireEvent.click(screen.getByText("Long conversation"));

		// Context line: window size, coverage, estimated tokens.
		await screen.findByText("Context: last 10 of 25 messages - est. ~1200 tokens");
		// Warning: 15 of the 25 stored messages are invisible to the model.
		expect(
			screen.getByText(
				"Oldest 15 message(s) are outside the model's context — start a new conversation for full context.",
			),
		).toBeTruthy();
	});

	it("hides the warning when nothing is dropped, and rows show the message count (U.4)", async () => {
		await openThreadList();

		// The thread rows carry a message-count badge before opening.
		expect(screen.getByText("2", { selector: ".thread-count span" })).toBeTruthy();

		fireEvent.click(screen.getByText("Review submission 1"));
		await screen.findByText("Compare cell 3");

		// Context line renders; the warning does not (droppedCount is 0).
		expect(screen.getByText("Context: last 2 of 2 messages - est. ~200 tokens")).toBeTruthy();
		expect(screen.queryByText(/Oldest .* message/)).toBeNull();
	});

	it("shows the compaction count in the context line (V.4)", async () => {
		await renderPanel([{ ...COMPACTED_THREAD }]);
		fireEvent.click(screen.getByRole("button", { name: "Conversation history" }));
		await screen.findByText("Long conversation");

		fireEvent.click(screen.getByText("Long conversation"));
		await waitFor(() =>
			expect(document.querySelector(".context-line")?.textContent).toContain("compacted 2×"),
		);
	});

	it("renders the summarized-into-context warning when hasSummary is true (V.4)", async () => {
		await renderPanel([{ ...COMPACTED_THREAD }]);
		fireEvent.click(screen.getByRole("button", { name: "Conversation history" }));
		await screen.findByText("Long conversation");

		fireEvent.click(screen.getByText("Long conversation"));

		expect(
			await screen.findByText(
				"Oldest 30 message(s) are summarized into context — start a new conversation for full fidelity.",
			),
		).toBeTruthy();
		// The plain out-of-context wording is NOT shown for a compacted thread.
		expect(screen.queryByText(/are outside the model's context/)).toBeNull();
	});
});
