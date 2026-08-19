// @vitest-environment jsdom
/**
 * P14-A1 tests — Markdown.svelte new block support + tool-args.svelte.
 *
 * Markdown: the chat renderer stays dependency-free and escape-first; these
 * tests pin the new blocks (headings, ordered lists, blockquotes, hr, tables)
 * and the security regression (raw HTML in input must stay escaped).
 * ToolArgs: flat args render as key/value rows; nested values collapse;
 * malformed input falls back to escaped text.
 */

import { describe, expect, it } from "vitest";
import { render } from "@testing-library/svelte";

import Markdown from "$lib/components/submissions/Markdown.svelte";
import ToolArgs from "$lib/components/submissions/copilot/tool-args.svelte";

describe("Markdown.svelte new blocks (P14-A1)", () => {
	it("renders headings", () => {
		const { container } = render(Markdown, { props: { text: "# Title\n## Sub\n### Deep" } });
		expect(container.querySelector("h1")?.textContent).toBe("Title");
		expect(container.querySelector("h2")?.textContent).toBe("Sub");
		expect(container.querySelector("h3")?.textContent).toBe("Deep");
	});

	it("renders ordered lists", () => {
		const { container } = render(Markdown, { props: { text: "1. one\n2. two\n3. three" } });
		const ol = container.querySelector("ol");
		expect(ol).not.toBeNull();
		expect(ol?.querySelectorAll("li")).toHaveLength(3);
		expect(ol?.textContent).toContain("one");
	});

	it("renders blockquotes", () => {
		const { container } = render(Markdown, { props: { text: "> quoted text\n> more quote" } });
		const bq = container.querySelector("blockquote");
		expect(bq).not.toBeNull();
		expect(bq?.textContent).toContain("quoted text");
		expect(bq?.textContent).toContain("more quote");
	});

	it("renders horizontal rules", () => {
		const { container } = render(Markdown, { props: { text: "before\n---\nafter" } });
		expect(container.querySelector("hr")).not.toBeNull();
	});

	it("renders a pipe table", () => {
		const { container } = render(Markdown, {
			props: { text: "| A | B |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |" },
		});
		const table = container.querySelector("table");
		expect(table).not.toBeNull();
		expect(table?.querySelectorAll("th")).toHaveLength(2);
		expect(table?.querySelectorAll("td")).toHaveLength(4);
		expect(table?.textContent).toContain("1");
		expect(table?.textContent).toContain("4");
	});

	it("keeps existing unordered lists + inline code working", () => {
		const { container } = render(Markdown, { props: { text: "- item\n- `code` here" } });
		const ul = container.querySelector("ul");
		expect(ul).not.toBeNull();
		expect(ul?.querySelector("code")?.textContent).toBe("code");
	});

	it("does NOT render raw HTML (escape-first security regression)", () => {
		const { container } = render(Markdown, {
			props: { text: "hello <script>alert(1)</script> world" },
		});
		expect(container.querySelector("script")).toBeNull();
		expect(container.textContent).toContain("<script>");
	});

	it("does NOT treat a table-looking block inside fenced code as a table", () => {
		const { container } = render(Markdown, {
			props: { text: "```\n| A | B |\n|---|---|\n| 1 | 2 |\n```" },
		});
		expect(container.querySelector("table")).toBeNull();
		expect(container.querySelector("pre code")?.textContent).toContain("| A | B |");
	});
});

describe("ToolArgs.svelte (P14-A1)", () => {
	it("renders flat key/value rows", () => {
		const { container } = render(ToolArgs, {
			props: { args: JSON.stringify({ submissionId: "2026SS_00", assignmentId: "soil" }) },
		});
		const rows = container.querySelectorAll(".tool-args-row");
		expect(rows).toHaveLength(2);
		expect(container.textContent).toContain("2026SS_00");
		expect(container.textContent).toContain("soil");
	});

	it("collapses nested objects under a details element", () => {
		const { container } = render(ToolArgs, {
			props: { args: JSON.stringify({ data: { a: 1 } }) },
		});
		expect(container.querySelector("details")).not.toBeNull();
		expect(container.textContent).toContain("nested object");
	});

	it("falls back to escaped text on malformed JSON", () => {
		const { container } = render(ToolArgs, { props: { args: "not json <b>" } });
		expect(container.querySelector(".tool-args-fallback")).not.toBeNull();
		expect(container.querySelector("b")).toBeNull();
	});
});
