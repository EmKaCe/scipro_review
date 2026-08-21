/**
 * @file Unit tests for the shared markdown renderer (lib/utils/markdown.ts).
 *
 * Covers: inline + display LaTeX via KaTeX, fenced code highlighting via hljs,
 * safe fallback for unknown languages, and code-cell highlighting.
 */
import { describe, expect, it } from "vitest";

import { highlightCode, renderMarkdown } from "$lib/utils/markdown.js";

describe("renderMarkdown", () => {
	it("renders inline math $...$ with KaTeX", () => {
		const html = renderMarkdown("The slope is $m = \\frac{1}{2}$.");
		// KaTeX produces a .katex span; the math itself survives in the DOM.
		expect(html).toContain("katex");
		expect(html).toContain("frac");
	});

	it("renders display math $$...$$ with KaTeX in display mode", () => {
		const html = renderMarkdown("$$\\int_0^1 x^2 dx$$");
		expect(html).toContain("katex-display");
		expect(html).toContain("katex");
	});

	it("leaves invalid math as-is instead of throwing", () => {
		const html = renderMarkdown("Bad: $\\invalid{");
		expect(html).toContain("\\invalid{");
	});

	it("renders plain markdown (headings, emphasis, lists)", () => {
		const html = renderMarkdown("# Title\n\n**bold** and *italic*");
		expect(html).toContain("<h1");
		expect(html).toContain("<strong>bold</strong>");
		expect(html).toContain("<em>italic</em>");
	});

	it("does not corrupt $ that is not math (dollar amounts)", () => {
		const html = renderMarkdown("Price: $5 and $10");
		expect(html).toContain("Price: $5 and $10");
	});

	it("highlights fenced code blocks with hljs", () => {
		const html = renderMarkdown("```python\ndef f(x):\n    return x\n```");
		expect(html).toContain("hljs");
		expect(html).toContain("language-python");
	});

	it("escapes raw HTML in fenced code (never injects unescaped tags)", () => {
		const html = renderMarkdown("```nope-unknown\n<b>x</b>\n```");
		expect(html).not.toContain("<b>x</b>");
		expect(html).toContain("&lt;");
	});
});

describe("highlightCode", () => {
	it("highlights python source", () => {
		const html = highlightCode("def f(x):\n    return x + 1\n");
		expect(html).toContain("hljs-keyword");
	});

	it("escapes raw HTML in the source", () => {
		const html = highlightCode("x = '<b>'");
		expect(html).not.toContain("<b>");
		expect(html).toContain("&lt;b&gt;");
	});

	it("falls back to auto-detection for empty/unknown language", () => {
		const html = highlightCode("print('hi')", "");
		expect(html).toContain("print");
	});
});
