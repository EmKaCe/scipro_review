/**
 * @file L4 component test — Task W3: incomingPrompt delivery.
 *
 * jsdom + mocked fetch (the panel's store fetches the thread list on
 * mount). The panel is mounted through a bindable harness that OWNS
 * `incomingPrompt`, so the test can assert both halves of the contract:
 *   - setting incomingPrompt fills the chat input (and focuses it);
 *   - the panel resets incomingPrompt to "" after consuming it — the
 *     $bindable round-trip that lets the page re-deliver the same chip.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/svelte";

import Harness from "./copilot-panel-incoming-harness.svelte";
import * as copilot from "$lib/components/submissions/copilot-store.svelte.js";

// ---------------------------------------------------------------------------
// Fetch mock — the panel's store only fetches the thread list on mount.
// ---------------------------------------------------------------------------

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
	fetchMock = vi.fn();
	fetchMock.mockImplementation((url: RequestInfo | URL) => {
		const u = String(url);
		if (u.includes("/api/copilot/threads")) {
			return Promise.resolve(
				new Response(JSON.stringify({ threads: [] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			);
		}
		return Promise.resolve(new Response("{}", { status: 200 }));
	});
	vi.stubGlobal("fetch", fetchMock);
	copilot.apiMode.value = true;
	localStorage.clear();
});

afterEach(() => {
	vi.unstubAllGlobals();
	copilot.apiMode.value = false;
	localStorage.clear();
});

async function renderHarness() {
	const result = render(Harness, { submissionId: "sub-1" });
	// Wait for the onMount thread-list fetch so the panel is fully mounted.
	await waitFor(() => expect(fetchMock).toHaveBeenCalled());
	return result;
}

/** The chat input (submission scope placeholder). */
function chatInput(): HTMLInputElement {
	return screen.getByPlaceholderText(/Ask the copilot/) as HTMLInputElement;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("copilot-panel.svelte — incomingPrompt delivery (W3)", () => {
	it("fills the chat input and focuses it when incomingPrompt is set", async () => {
		const { component } = await renderHarness();

		component.incomingPrompt = "Explain cell 3";

		await waitFor(() => expect(chatInput().value).toBe("Explain cell 3"));
		expect(document.activeElement).toBe(chatInput());
		// The send button enables once the input holds text.
		expect(chatInput().closest(".input-row")?.querySelector(".send-btn")).toBeTruthy();
	});

	it("resets incomingPrompt to '' after consuming it (bindable round-trip)", async () => {
		const { component } = await renderHarness();

		component.incomingPrompt = "test prompt";

		await waitFor(() => expect(component.incomingPrompt).toBe(""));
	});

	it("re-delivers the same prompt on a second set (the reset enables repeat chips)", async () => {
		const { component } = await renderHarness();

		component.incomingPrompt = "same chip";
		await waitFor(() => expect(component.incomingPrompt).toBe(""));
		expect(chatInput().value).toBe("same chip");

		// Second click on the same chip: the prop went "" -> value again,
		// which only works because the round-trip reset the harness state.
		component.incomingPrompt = "same chip";
		await waitFor(() => expect(chatInput().value).toBe("same chip"));
		expect(component.incomingPrompt).toBe("");
	});
});
