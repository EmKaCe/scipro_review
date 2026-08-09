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
	},
	{
		id: "t-2",
		title: "Second thread",
		createdAt: "2026-08-01T09:00:00.000Z",
		updatedAt: "2026-08-01T11:00:00.000Z",
		messageCount: 1,
		lastPreview: "Hi",
	},
];

const THREAD_DETAIL = {
	...THREADS[0],
	messages: [
		{ id: "m1", role: "user", createdAt: "2026-08-01T11:00:00.000Z", text: "Compare cell 3" },
		{ id: "m2", role: "assistant", createdAt: "2026-08-01T11:02:00.000Z", text: "Done." },
	],
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

function mockThreadRoutes(): void {
	serverThreads = THREADS.map((t) => ({ ...t }));
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
async function renderPanel() {
	mockThreadRoutes();
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
			expect(
				fetchMock.mock.calls.some((call) => call[1]?.method === "PATCH"),
			).toBe(true);
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
			expect(screen.queryByRole("textbox", { name: "Rename Review submission 1" })).toBeNull(),
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
					(call) => call[1]?.method === "DELETE" && String(call[0]).includes("/api/copilot/threads/t-1"),
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
});
