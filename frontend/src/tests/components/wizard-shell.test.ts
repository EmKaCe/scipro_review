/**
 * @file Component tests — WizardShell step shell (2.8.0-w2).
 *
 * The shell is strictly presentational: completion marks are derived from
 * the `steps` prop, Next/Back walk the visible rail via `ongoto`, and the
 * welcome step's fork choice reports through `onfork` (the page owns the
 * state mutation). Restore appears on the rail only in restore flows.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";

import WizardShell from "$lib/components/onboarding/WizardShell.svelte";
import { deriveSteps, type WizardStep } from "$lib/states/onboarding-wizard.svelte";

/** Provider + seed done, docs-index pending, executor pending (no probe). */
function makeSteps(fork: "fresh" | "restore" | null = null): WizardStep[] {
	return deriveSteps(
		{
			items: [
				{ id: "create-assignment", done: true },
				{ id: "wire-scoring", done: true },
				{ id: "llm-provider", done: true },
				{ id: "docs-index", done: false },
				{ id: "first-pipeline", done: false },
			],
		},
		{ fork: fork ?? undefined },
	);
}

function renderShell(
	opts: {
		steps?: WizardStep[];
		current?: WizardStep["id"];
		fork?: "fresh" | "restore" | null;
	} = {},
) {
	const onfork = vi.fn();
	const ongoto = vi.fn();
	const result = render(WizardShell, {
		steps: opts.steps ?? makeSteps(),
		current: opts.current ?? "welcome",
		fork: opts.fork ?? null,
		onfork,
		ongoto,
	});
	return { ...result, onfork, ongoto };
}

describe("WizardShell.svelte", () => {
	it("renders the visible step rail with derived completion marks", () => {
		renderShell({ current: "provider" });

		// Fresh flow (fork null): restore is not on the rail.
		expect(screen.queryByText("Restore a backup")).toBeNull();
		// The current step's title shows in both the rail and the header.
		expect(screen.getAllByText("LLM provider").length).toBeGreaterThan(0);
		expect(screen.getByText("Docs index")).toBeTruthy();
		expect(screen.getByText("Executor check")).toBeTruthy();
		expect(screen.getByText("Reference assignment")).toBeTruthy();

		// Done badges only for complete steps: welcome, provider, seed.
		expect(screen.getAllByText("Done")).toHaveLength(3);
	});

	it("shows the restore step on the rail only in restore flows", () => {
		const restoreFlow = makeSteps("restore");
		expect(restoreFlow.find((s) => s.id === "restore")?.complete).toBe(false);

		const { unmount } = renderShell({
			steps: restoreFlow,
			current: "restore",
			fork: "restore",
		});
		// Rail entry + step header both carry the title in a restore flow.
		expect(screen.getAllByText("Restore a backup").length).toBeGreaterThan(0);

		unmount();
		const freshFlow = makeSteps("fresh");
		renderShell({ steps: freshFlow, current: "provider", fork: "fresh" });
		expect(screen.queryByText("Restore a backup")).toBeNull();
	});

	it("steps are all navigable: next/back walk the visible rail via ongoto", async () => {
		const { ongoto } = renderShell({ current: "provider" });

		// Visible rail: welcome, provider, docs-index, executor, seed, done.
		await fireEvent.click(screen.getByRole("button", { name: /Next/ }));
		expect(ongoto).toHaveBeenCalledWith("docs-index");

		await fireEvent.click(screen.getByRole("button", { name: /Back/ }));
		expect(ongoto).toHaveBeenCalledWith("welcome");
	});

	it("incomplete steps do not block navigation (skip semantics)", () => {
		const { ongoto } = renderShell({ current: "docs-index" }); // docs-index pending
		const next = screen.getByRole("button", { name: /Next/ });
		expect((next as HTMLButtonElement).disabled).toBe(false);
		fireEvent.click(next);
		expect(ongoto).toHaveBeenCalledWith("executor");
	});

	it("welcome offers the fork choice and reports it through onfork", () => {
		const { onfork, ongoto } = renderShell({ current: "welcome" });

		// No back/next chrome on the entry step — the fork decides the path.
		expect(screen.queryByRole("button", { name: /Next/ })).toBeNull();
		expect(screen.queryByRole("button", { name: /Back/ })).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: /Start fresh setup/ }));
		expect(onfork).toHaveBeenCalledWith("fresh");

		fireEvent.click(
			screen.getByRole("button", { name: /Restore a backup from another machine/ }),
		);
		expect(onfork).toHaveBeenCalledWith("restore");
		expect(ongoto).not.toHaveBeenCalled();
	});

	it("done step keeps Back but drops Next (the Finish action lives in the body)", () => {
		const { ongoto } = renderShell({ current: "done" });

		expect(screen.queryByRole("button", { name: /Next/ })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: /Back/ }));
		expect(ongoto).toHaveBeenCalledWith("seed");
	});
});
