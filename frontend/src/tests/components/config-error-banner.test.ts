/**
 * @file L3 component test — config-error-banner.
 *
 * The banner surfaces a failed assignment-config load (assignments registry /
 * materials) on the dashboard. It is purely props-driven: `message` is the
 * error detail, `onDismiss` is invoked when the teacher clicks the X button.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";

import ConfigErrorBanner from "$lib/components/submissions/config-error-banner.svelte";

describe("config-error-banner", () => {
	it("renders the headline and the error message", () => {
		render(ConfigErrorBanner, { props: { message: "Failed to fetch /api/assignments" } });

		expect(screen.getByText(/Assignment configuration could not be loaded/)).toBeTruthy();
		expect(screen.getByText("Failed to fetch /api/assignments")).toBeTruthy();
	});

	it("fires onDismiss when the close button is clicked", async () => {
		const onDismiss = vi.fn();
		render(ConfigErrorBanner, {
			props: { message: "boom", onDismiss },
		});

		await fireEvent.click(screen.getByLabelText("Dismiss configuration error"));

		expect(onDismiss).toHaveBeenCalledTimes(1);
	});

	it("renders without a close button when no onDismiss is provided", () => {
		render(ConfigErrorBanner, { props: { message: "boom" } });

		expect(screen.queryByLabelText("Dismiss configuration error")).toBeNull();
	});
});
