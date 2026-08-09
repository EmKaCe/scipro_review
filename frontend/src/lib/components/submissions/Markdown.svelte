<script lang="ts">
	/**
	 * Minimal dependency-free markdown renderer for copilot chat bubbles.
	 *
	 * Supports: fenced code blocks (```), inline code (`), bold (**),
	 * italic (*), links ([text](url)) and unordered lists (- item).
	 *
	 * Sanitization: every character that is not inside a fenced code block
	 * is HTML-escaped before inline rendering, so raw HTML in a message can
	 * never inject elements or execute (the output goes through {@html},
	 * which does not escape). Code-block contents are escaped too — they
	 * render as literal text inside <pre><code>.
	 *
	 * NOTE: Svelte scoped CSS does NOT reach {@html} content — every
	 * selector below is :global(...) on purpose.
	 */

	let { text = "" }: { text?: string } = $props();

	/** Escape HTML metacharacters (also covers attribute context). */
	function escapeHtml(value: string): string {
		return value
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;")
			.replace(/'/g, "&#39;");
	}

	/**
	 * Inline spans on ALREADY-escaped source: inline code, bold, italic,
	 * links. Applied after escaping, so the emitted tags are the only
	 * live markup.
	 */
	function renderInline(src: string): string {
		return (
			src
				// Inline code first — its content is not processed further.
				.replace(
					/`([^`]+)`/g,
					(_m, code: string) => `<code class="md-inline-code">${code}</code>`,
				)
				// Bold.
				.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
				// Italic — single asterisks around non-asterisk content.
				.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
				// Links [text](url) — javascript: URLs are dropped to "#".
				.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) => {
					const safe = url.startsWith("javascript:") ? "#" : url;
					return `<a class="md-link" href="${escapeHtml(safe)}" target="_blank" rel="noreferrer">${label}</a>`;
				})
		);
	}

	/**
	 * Block-level rendering: fenced code blocks are extracted and
	 * placeholder-substituted FIRST (their content must not be escaped as
	 * prose), then the remaining text is escaped and split into paragraph /
	 * list / code-block lines, each run through the inline renderer.
	 */
	let rendered = $derived.by(() => {
		const src = text ?? "";
		const blocks: string[] = [];
		const withoutBlocks = src.replace(
			/```([^\n`]*)\n?([\s\S]*?)```/g,
			(_m, _lang: string, code: string) => {
				blocks.push(
					`<pre class="md-code-block"><code>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`,
				);
				return `\u0000MD_BLOCK_${blocks.length - 1}\u0000`;
			},
		);
		const escaped = escapeHtml(withoutBlocks);
		const parts: string[] = [];
		let inList = false;
		// Block placeholder prefix — a NUL-prefixed token that prose can
		// never contain (regex literals may not carry the control char per
		// eslint no-control-regex, so detection uses string ops).
		const BLOCK_PREFIX = "\u0000MD_BLOCK_";
		for (const rawLine of escaped.split("\n")) {
			// A line that is ONLY a code-block placeholder emits the block.
			if (rawLine.startsWith(BLOCK_PREFIX) && rawLine.endsWith("\u0000")) {
				if (inList) {
					parts.push("</ul>");
					inList = false;
				}
				const index = Number(rawLine.slice(BLOCK_PREFIX.length, -1));
				if (Number.isInteger(index) && blocks[index]) parts.push(blocks[index]);
				continue;
			}
			// Consecutive "- item" / "* item" lines merge into one <ul>.
			const listMatch = rawLine.match(/^(\s*)[-*]\s+(.*)$/);
			if (listMatch) {
				if (!inList) parts.push("<ul>");
				inList = true;
				parts.push(`<li>${renderInline(listMatch[2])}</li>`);
				continue;
			}
			if (inList) {
				parts.push("</ul>");
				inList = false;
			}
			if (rawLine.trim() === "") continue;
			parts.push(`<p>${renderInline(rawLine)}</p>`);
		}
		if (inList) parts.push("</ul>");
		return parts.join("\n");
	});
</script>

{@html rendered}

<style>
	/* {@html} content is not scoped — global selectors only. */
	:global(.md-code-block) {
		margin: 6px 0;
		padding: 8px 10px;
		background: var(--muted);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		overflow-x: auto;
	}
	:global(.md-code-block code) {
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		font-size: 11px;
		line-height: 1.45;
		color: var(--foreground);
	}
	:global(.md-inline-code) {
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		font-size: 11px;
		background: var(--muted);
		border: 1px solid var(--border);
		border-radius: 3px;
		padding: 0 3px;
	}
	:global(.md-link) {
		color: var(--primary);
		text-decoration: underline;
	}
	:global(.msg-content p) {
		margin: 2px 0;
	}
	:global(.msg-content ul) {
		margin: 4px 0;
		padding-left: 18px;
	}
</style>
