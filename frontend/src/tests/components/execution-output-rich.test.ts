/**
 * B11 component test — rich notebook outputs in the teacher preview.
 *
 * image/png renders as a data-URI <img> (client-side downscaled to panel
 * width). text/html ships inside a SANDBOXED iframe: `sandbox=""` grants NO
 * tokens, so student HTML cannot execute scripts (`allow-scripts` absent) or
 * reach the application origin (`allow-same-origin` absent), and the srcdoc
 * attribute is HTML-attribute-escaped so a student string can never break
 * out of the iframe into the parent page. A malicious `<script>` / same-
 * origin attempt must never run and never appear as raw markup in the page.
 */
// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { SvelteSet } from "svelte/reactivity";

import ExecutionOutput from "$lib/components/submissions/execution-output.svelte";
import type { CellInfo, CellRichOutput } from "$lib/types/submissions";

const PNG_B64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const EVIL_HTML =
	"<script>window.__pwned=1</script><img src=x onerror=\"parent.document.body.innerHTML='pwned'\">";
// srcdoc is the RAZED attribute value the browser would parse back.
const ESCAPED_EVIL_HTML =
	"&lt;script&gt;window.__pwned=1&lt;/script&gt;&lt;img src=x onerror=&quot;parent.document.body.innerHTML='pwned'&quot;&gt;";

function cell(index: number, outputs: CellRichOutput[], opts: Partial<CellInfo> = {}): CellInfo {
	return { index, type: "code", source: "x = 1", marker: "pending", outputs, ...opts };
}

const ORIGINALS: CellInfo[] = [
	cell(0, [
		{ mime_type: "image/png", data: PNG_B64 },
		{ mime_type: "text/html", data: EVIL_HTML },
	]),
];

const FIXED: CellInfo[] = [cell(0, [{ mime_type: "image/png", data: PNG_B64 }])];

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

describe("ExecutionOutput rich outputs", () => {
	it("renders image/png as a data-URI <img>", () => {
		renderOutput();
		const card = cardFor("Cell 1");
		const img = within(card).queryByAltText("cell output");
		expect(img).not.toBeNull();
		expect(img!.getAttribute("src")).toBe(`data:image/png;base64,${PNG_B64}`);
	});

	it("renders text/html inside a sandboxed iframe with sandbox=''", () => {
		renderOutput();
		const card = cardFor("Cell 1");
		const iframe = within(card).queryByTitle("cell HTML output");
		expect(iframe).not.toBeNull();
		// sandbox="" → NO tokens: block scripts + require same origin.
		expect(iframe!.getAttribute("sandbox")).toBe("");
		const sandbox = iframe!.getAttribute("sandbox") ?? "";
		expect(sandbox).not.toContain("allow-scripts");
		expect(sandbox).not.toContain("allow-same-origin");
	});

	it("HTML-attribute-escapes the srcdoc so a script cannot break out", () => {
		renderOutput();
		const card = cardFor("Cell 1");
		const iframe = within(card).queryByTitle("cell HTML output");
		// The raw `<script>` must NOT appear in the attribute — it is razed so
		// the browser re-parses it safely inside the opaque-origin iframe.
		expect(iframe!.getAttribute("srcdoc")).toBe(ESCAPED_EVIL_HTML);
		expect(iframe!.getAttribute("srcdoc")).not.toContain("<script>");
	});

	it("never injects raw student HTML into the document body", () => {
		renderOutput();
		// No live <script> element in the parent document (jsdom may parse
		// the iframe's srcdoc into ITS OWN child document, never the parent).
		expect(document.querySelectorAll("script").length).toBe(0);
		// The malicious markup exists ONLY as the escaped srcdoc attribute
		// value (e.g. &lt;script&gt;…), never as raw markup that could parse
		// or execute on the page's own DOM.
		expect(document.body.innerHTML).not.toContain("<script>");
		expect(document.body.innerHTML).not.toContain("<img src=x");
	});

	it("renders rich outputs in the auto-fixed view too", async () => {
		const fixedView = new SvelteSet<number>();
		const FIXED_ORIGINALS: CellInfo[] = [cell(0, [], { error: "boom" })];
		render(ExecutionOutput, {
			props: {
				cells: FIXED_ORIGINALS,
				fixedCells: FIXED,
				fixedView,
				submissionId: "2026SS_03",
				assignmentId: "soil_contamination",
			},
		});

		const card = cardFor("Cell 1");
		// Original view (default): no fixed outputs shown yet.
		expect(within(card).queryByAltText("cell output")).toBeNull();
		await fireEvent.click(within(card).getByRole("button", { name: "Show auto-fixed" }));

		const img = within(card).queryByAltText("cell output");
		expect(img).not.toBeNull();
		expect(img!.getAttribute("src")).toBe(`data:image/png;base64,${PNG_B64}`);
	});
});
