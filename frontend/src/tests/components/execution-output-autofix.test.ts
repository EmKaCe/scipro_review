/**
 * L4 component test — ExecutionOutput non-destructive autofix view.
 *
 * Covers the per-cell original ↔ auto-fixed toggle: authentic original by
 * default, the loud "Auto-fixed" strip + frame when toggled, the delta
 * block, and no toggle for cells without a verified fix. View state is
 * ephemeral — the component mutates the caller's SvelteSet, never
 * persisting anything.
 */
// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { SvelteSet } from "svelte/reactivity";

import ExecutionOutput from "$lib/components/submissions/execution-output.svelte";
import type { CellInfo } from "$lib/types/submissions";

function cell(
	index: number,
	source: string,
	error?: string,
	output?: string,
	marker: CellInfo["marker"] = "pending",
): CellInfo {
	return { index, type: "code", source, error, output, marker };
}

const ORIGINALS: CellInfo[] = [
	cell(0, "x = 5"),
	cell(1, "y = (x + 1", "SyntaxError: invalid syntax"),
	cell(2, "print(y)", "NameError: name 'y' is not defined"),
];

const FIXED: CellInfo[] = [
	cell(0, "x = 5"),
	cell(1, "y = (x + 1)"),
	cell(2, "print(y)", undefined, "6\n"),
];

function renderOutput(
	opts: { fixedCells?: CellInfo[] | null; fixedView?: SvelteSet<number> } = {},
) {
	return render(ExecutionOutput, {
		props: {
			cells: ORIGINALS,
			submissionId: "2026SS_03",
			assignmentId: "soil_contamination",
			...opts,
		},
	});
}

function cardFor(label: string): HTMLElement {
	const node = screen.getAllByText(label)[0];
	if (!node) throw new Error(`missing cell label ${label}`);
	const card = node.closest(".cell-card");
	if (!card) throw new Error(`no .cell-card ancestor for ${label}`);
	return card as HTMLElement;
}

/** Find the highlighted code <pre> whose full text equals `text` (hljs wraps
 *  tokens in spans, so the default text matcher can't see it). */
function codeBlock(text: string, scope: HTMLElement = document.body): HTMLElement {
	const found = within(scope).getByText(
		(_content, el) => el !== null && el.classList.contains("hljs") && el.textContent === text,
	);
	return found as HTMLElement;
}

describe("ExecutionOutput autofix view", () => {
	it("renders the authentic original source + error by default even when fixedCells exist", () => {
		renderOutput({ fixedCells: FIXED });

		codeBlock("y = (x + 1");
		expect(screen.getByText("SyntaxError: invalid syntax")).toBeTruthy();
		// The fixed source / clean output are NOT shown until toggled.
		expect(() => codeBlock("y = (x + 1)")).toThrow();
		expect(screen.queryByText(/Auto-fixed/)).toBeNull();
	});

	it("toggles a cell to the fixed version with the loud strip + frame", async () => {
		const fixedView = new SvelteSet<number>();
		renderOutput({ fixedCells: FIXED, fixedView });

		const card = cardFor("Cell 2");
		await fireEvent.click(within(card).getByRole("button", { name: "Show auto-fixed" }));

		// The caller's ephemeral view set is mutated (not persisted anywhere).
		expect(fixedView.has(1)).toBe(true);
		// Fixed source is shown; the original error is gone from the body.
		codeBlock("y = (x + 1)", card);
		expect(within(card).queryByText("SyntaxError: invalid syntax")).toBeNull();
		// Loud framing: the strip text + the frame class.
		expect(within(card).getByText(/Auto-fixed/)).toBeTruthy();
		expect(card.classList.contains("cell-autofixed")).toBe(true);
	});

	it("toggles back to the original and removes the frame", async () => {
		const fixedView = new SvelteSet<number>();
		renderOutput({ fixedCells: FIXED, fixedView });

		const card = cardFor("Cell 2");
		await fireEvent.click(within(card).getByRole("button", { name: "Show auto-fixed" }));
		expect(card.classList.contains("cell-autofixed")).toBe(true);

		await fireEvent.click(within(card).getAllByRole("button", { name: "Show original" })[0]!);

		expect(fixedView.has(1)).toBe(false);
		expect(within(card).getByText("SyntaxError: invalid syntax")).toBeTruthy();
		expect(within(card).queryByText(/Auto-fixed/)).toBeNull();
		expect(card.classList.contains("cell-autofixed")).toBe(false);
	});

	it("renders no toggle for cells without a verified fix", () => {
		// Only cells 0 and 1 have a fixed version — cell 2 (index 2) does not.
		renderOutput({ fixedCells: FIXED.slice(0, 2) });

		const card = cardFor("Cell 3");
		expect(within(card).queryByRole("button", { name: "Show auto-fixed" })).toBeNull();
		expect(within(card).queryByText(/Auto-fixed/)).toBeNull();
	});

	it("shows the delta block with changed lines and error before/after", async () => {
		renderOutput({ fixedCells: FIXED });

		const card = cardFor("Cell 2");
		await fireEvent.click(within(card).getByRole("button", { name: "Show delta" }));

		// Changed line pair, old → new.
		expect(within(card).getByText(/y = \(x \+ 1$/)).toBeTruthy();
		expect(within(card).getByText(/y = \(x \+ 1\)$/)).toBeTruthy();
		// Error state before → after.
		expect(within(card).getByText(/Before: SyntaxError/)).toBeTruthy();
		expect(within(card).getByText(/After: no error/)).toBeTruthy();
	});
});
