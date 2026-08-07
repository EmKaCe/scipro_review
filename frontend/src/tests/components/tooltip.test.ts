/**
 * L4 component test — Tooltip primitive (shadcn-svelte pattern on bits-ui 2).
 *
 * Guards the keyboard-reachability contract that the button polish depends
 * on: the trigger is a real button that opens the tooltip on focus, and the
 * content renders with role="tooltip" once open. (aria-describedby is wired
 * by bits-ui but its resolved id is environment-dependent — verified live in
 * the browser instead.)
 */
// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";

import TooltipHarness from "./tooltip-harness.svelte";

describe("Tooltip primitive", () => {
	it("renders the trigger button with its accessible label", () => {
		render(TooltipHarness);
		const trigger = screen.getByRole("button", { name: "Delete item" });
		expect(trigger).toBeTruthy();
		expect(trigger.getAttribute("data-state")).toBe("closed");
	});

	it("opens on keyboard focus and shows the tooltip content with role=tooltip", async () => {
		render(TooltipHarness);
		fireEvent.focus(screen.getByRole("button", { name: "Delete item" }));
		await waitFor(() => {
			expect(
				screen.getByRole("button", { name: "Delete item" }).getAttribute("data-state"),
			).toBe("instant-open");
		});
		await waitFor(() => {
			const content = screen.getByTestId("tooltip-content");
			expect(content.getAttribute("role")).toBe("tooltip");
			expect(content.textContent).toContain("Delete this item");
		});
	});

	it("keeps the content hidden until opened", () => {
		render(TooltipHarness);
		expect(screen.queryByTestId("tooltip-content")).toBeNull();
	});
});
