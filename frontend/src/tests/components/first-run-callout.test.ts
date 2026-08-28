/**
 * @file L3 component test — first-run-callout (dashboard empty state, B3).
 *
 * The callout greets a config-less first run with an invitation that points
 * at BOTH onboarding paths (set up an assignment OR restore a backup).
 */
// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/svelte";

import FirstRunCallout from "$lib/components/submissions/first-run-callout.svelte";

vi.mock("$app/paths", () => ({ base: "" }));

describe("first-run-callout", () => {
	it("invites the teacher to set up an assignment or restore a backup", () => {
		render(FirstRunCallout, { props: { message: "assignments.yaml missing" } });

		expect(screen.getByText(/No assignment configuration found/)).toBeTruthy();
		const link = screen.getByRole("link", { name: /Get started/ });
		expect(link.getAttribute("href")).toBe("/onboarding");
		expect(screen.getByText(/set up your first assignment or restore a backup/i)).toBeTruthy();
	});

	it("still shows the error detail when provided", () => {
		render(FirstRunCallout, { props: { message: "ENOENT: data/assignments.yaml" } });
		expect(screen.getByText("ENOENT: data/assignments.yaml")).toBeTruthy();
	});
});
