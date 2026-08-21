/**
 * @file Shared markdown rendering with KaTeX math + syntax highlighting.
 *
 * Used by the teacher's submission cell view (execution-output) and the
 * legacy evaluation page. The pipeline:
 *   1. Protect display math ($$...$$) and inline math ($...$)
 *   2. Parse markdown with `marked` (fenced code blocks highlighted via hljs)
 *   3. Restore math placeholders as KaTeX HTML
 *
 * KaTeX CSS is imported here so any consumer gets fonts/styles. hljs themes
 * are NOT imported globally — components pick a theme that matches their
 * code background (execution-output imports github-dark itself).
 */

import { marked } from "marked";
import katex from "katex";
import hljs from "highlight.js";
import "katex/dist/katex.min.css";

// ---------------------------------------------------------------------------
// Syntax highlighting (fenced code blocks inside markdown)
// ---------------------------------------------------------------------------

/**
 * Extend marked's renderer: highlight fenced code blocks with highlight.js.
 * Falls back to plain escaped output when the language is unknown so a
 * mis-tagged block never breaks the page.
 */
marked.use({
	renderer: {
		code({ text, lang }) {
			const language = lang && hljs.getLanguage(lang) ? lang : "";
			try {
				const highlighted = language
					? hljs.highlight(text, { language, ignoreIllegals: true }).value
					: hljs.highlightAuto(text).value;
				const cls = language ? `hljs language-${language}` : "hljs";
				return `<pre><code class="${cls}">${highlighted}</code></pre>`;
			} catch {
				return `<pre><code>${escapeHtml(text)}</code></pre>`;
			}
		},
	},
});

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// Markdown + math
// ---------------------------------------------------------------------------

/**
 * Render markdown source with LaTeX math to HTML.
 *
 * Math is protected before markdown parsing (so `marked` does not mangle
 * `$` in tables/emphasis), then restored as KaTeX HTML. Invalid math is
 * left as the original LaTeX source rather than throwing.
 */
export function renderMarkdown(src: string): string {
	// Protect display math $$...$$ blocks. Placeholders MUST avoid markdown
	// syntax (no underscores — `__` becomes <strong> in marked) or the
	// restore step can never match them.
	const displayMathBlocks: string[] = [];
	let text = src.replace(/\$\$([\s\S]*?)\$\$/g, (_match, latex: string) => {
		displayMathBlocks.push(latex);
		return `DMATH${displayMathBlocks.length - 1}`;
	});

	// Protect inline math $...$ blocks (single $, not $$). Require non-space
	// boundaries so dollar amounts ("$5 and $10") are not eaten as math.
	const inlineMathBlocks: string[] = [];
	text = text.replace(
		/(?<!\$)\$(?!\$)(?!\s)([^$\n]+?)(?<!\s)\$(?!\$)/g,
		(_match, latex: string) => {
			inlineMathBlocks.push(latex);
			return `IMATH${inlineMathBlocks.length - 1}`;
		},
	);

	// Parse markdown
	let html: string;
	try {
		html = marked.parse(text, { async: false }) as string;
	} catch {
		return src;
	}

	// Restore and render display math with KaTeX
	html = html.replace(/DMATH(\d+)/g, (_match, index: string) => {
		const latex = displayMathBlocks[Number(index)];
		if (latex === undefined) return _match;
		try {
			return katex.renderToString(latex, { throwOnError: false, displayMode: true });
		} catch {
			return latex;
		}
	});

	// Restore and render inline math with KaTeX
	html = html.replace(/IMATH(\d+)/g, (_match, index: string) => {
		const latex = inlineMathBlocks[Number(index)];
		if (latex === undefined) return _match;
		try {
			return katex.renderToString(latex, { throwOnError: false, displayMode: false });
		} catch {
			return latex;
		}
	});

	return html;
}

// ---------------------------------------------------------------------------
// Code cell highlighting (whole-cell source, not fenced blocks)
// ---------------------------------------------------------------------------

/** Highlight a full code-cell source string. Language defaults to python. */
export function highlightCode(source: string, language = "python"): string {
	try {
		if (language && hljs.getLanguage(language)) {
			return hljs.highlight(source, { language, ignoreIllegals: true }).value;
		}
		return hljs.highlightAuto(source).value;
	} catch {
		return escapeHtml(source);
	}
}
