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
	 * Block-level rendering: fenced code blocks AND pipe tables are
	 * extracted and placeholder-substituted FIRST (their content must not
	 * be escaped as prose), then the remaining text is escaped and split
	 * into heading / paragraph / list / quote / rule lines, each run
	 * through the inline renderer.
	 */
	let rendered = $derived.by(() => {
		const src = text ?? "";
		const blocks: string[] = [];
		const BLOCK_PREFIX = "\u0000MD_BLOCK_";
		// 1) Extract fenced code blocks FIRST (a table-looking block inside
		//    code must stay code).
		const withCode = src.replace(
			/```([^\n`]*)\n?([\s\S]*?)```/g,
			(_m, _lang: string, code: string) => {
				blocks.push(
					`<pre class="md-code-block"><code>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`,
				);
				return `${BLOCK_PREFIX}${blocks.length - 1}\u0000`;
			},
		);
		// 2) Extract pipe tables (header + separator + body rows) on the
		//    code-placeholder string, so a table inside code is untouched.
		const lines = withCode.split("\n");
		const outputLines: string[] = [];
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const next = lines[i + 1] ?? "";
			const isSep = /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(next.trim());
			if (/^\|.*\|$/.test(line.trim()) && isSep) {
				const headerRow = line
					.trim()
					.replace(/^\|/, "")
					.replace(/\|$/, "")
					.split("|")
					.map((c) => c.trim());
				const rows: string[][] = [];
				let j = i + 2;
				while (j < lines.length && /^\|.*\|$/.test(lines[j].trim())) {
					rows.push(
						lines[j]
							.trim()
							.replace(/^\|/, "")
							.replace(/\|$/, "")
							.split("|")
							.map((c) => c.trim()),
					);
					j++;
				}
				const tableHtml =
					`<table class="md-table"><thead><tr>` +
					headerRow.map((c) => `<th>${escapeHtml(c)}</th>`).join("") +
					`</tr></thead>` +
					(rows.length > 0
						? `<tbody>` +
							rows
								.map(
									(r) =>
										`<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`,
								)
								.join("") +
							`</tbody>`
						: "") +
					`</table>`;
				blocks.push(tableHtml);
				outputLines.push(`${BLOCK_PREFIX}${blocks.length - 1}\u0000`);
				i = j - 1;
				continue;
			}
			outputLines.push(line);
		}
		const withoutBlocks = outputLines.join("\n");
		const escaped = escapeHtml(withoutBlocks);
		const parts: string[] = [];
		let inList = false;
		let inOList = false;
		let inQuote = false;
		for (const rawLine of escaped.split("\n")) {
			// A line that is ONLY a block placeholder emits the block.
			if (rawLine.startsWith(BLOCK_PREFIX) && rawLine.endsWith("\u0000")) {
				if (inList) {
					parts.push("</ul>");
					inList = false;
				}
				if (inOList) {
					parts.push("</ol>");
					inOList = false;
				}
				if (inQuote) {
					parts.push("</blockquote>");
					inQuote = false;
				}
				const index = Number(rawLine.slice(BLOCK_PREFIX.length, -1));
				if (Number.isInteger(index) && blocks[index]) parts.push(blocks[index]);
				continue;
			}
			// Headings #–####.
			const headingMatch = rawLine.match(/^(#{1,4})\s+(.*)$/);
			if (headingMatch) {
				if (inList) {
					parts.push("</ul>");
					inList = false;
				}
				if (inOList) {
					parts.push("</ol>");
					inOList = false;
				}
				if (inQuote) {
					parts.push("</blockquote>");
					inQuote = false;
				}
				const level = headingMatch[1].length;
				parts.push(
					`<h${level} class="md-h${level}">${renderInline(headingMatch[2])}</h${level}>`,
				);
				continue;
			}
			// Horizontal rule — a line that is exactly --- (and NOT an
			// unordered-list dash; the list branch below handles "- x").
			if (/^-{3,}$/.test(rawLine.trim()) && !rawLine.trim().startsWith("- ")) {
				if (inList) {
					parts.push("</ul>");
					inList = false;
				}
				if (inOList) {
					parts.push("</ol>");
					inOList = false;
				}
				if (inQuote) {
					parts.push("</blockquote>");
					inQuote = false;
				}
				parts.push('<hr class="md-hr" />');
				continue;
			}
			// Consecutive "> " lines merge into one <blockquote>.
			const quoteMatch = rawLine.match(/^&gt;\s?(.*)$/);
			if (quoteMatch) {
				if (inList) {
					parts.push("</ul>");
					inList = false;
				}
				if (inOList) {
					parts.push("</ol>");
					inOList = false;
				}
				if (!inQuote) parts.push('<blockquote class="md-quote">');
				inQuote = true;
				parts.push(`<p>${renderInline(quoteMatch[1])}</p>`);
				continue;
			}
			// Consecutive "1. " / "2. " lines merge into one <ol>.
			const olistMatch = rawLine.match(/^\d+\.\s+(.*)$/);
			if (olistMatch) {
				if (inQuote) {
					parts.push("</blockquote>");
					inQuote = false;
				}
				if (!inOList) parts.push('<ol class="md-ol">');
				inOList = true;
				parts.push(`<li>${renderInline(olistMatch[1])}</li>`);
				continue;
			}
			// Consecutive "- item" / "* item" lines merge into one <ul>.
			const listMatch = rawLine.match(/^(\s*)[-*]\s+(.*)$/);
			if (listMatch) {
				if (inQuote) {
					parts.push("</blockquote>");
					inQuote = false;
				}
				if (inOList) {
					parts.push("</ol>");
					inOList = false;
				}
				if (!inList) parts.push("<ul>");
				inList = true;
				parts.push(`<li>${renderInline(listMatch[2])}</li>`);
				continue;
			}
			if (inQuote) {
				parts.push("</blockquote>");
				inQuote = false;
			}
			if (inOList) {
				parts.push("</ol>");
				inOList = false;
			}
			if (inList) {
				parts.push("</ul>");
				inList = false;
			}
			if (rawLine.trim() === "") continue;
			parts.push(`<p>${renderInline(rawLine)}</p>`);
		}
		if (inList) parts.push("</ul>");
		if (inOList) parts.push("</ol>");
		if (inQuote) parts.push("</blockquote>");
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
	:global(.md-h1),
	:global(.md-h2),
	:global(.md-h3),
	:global(.md-h4) {
		margin: 8px 0 4px;
		font-weight: 600;
		line-height: 1.25;
		color: var(--foreground);
	}
	:global(.md-h1) {
		font-size: 16px;
	}
	:global(.md-h2) {
		font-size: 15px;
	}
	:global(.md-h3) {
		font-size: 14px;
	}
	:global(.md-h4) {
		font-size: 13px;
	}
	:global(.msg-content ol) {
		margin: 4px 0;
		padding-left: 18px;
		list-style: decimal;
	}
	:global(.md-quote) {
		margin: 6px 0;
		padding: 4px 10px;
		border-left: 3px solid var(--border);
		color: var(--muted-foreground);
	}
	:global(.md-quote p) {
		margin: 2px 0;
	}
	:global(.md-hr) {
		margin: 8px 0;
		border: 0;
		border-top: 1px solid var(--border);
	}
	:global(.md-table) {
		margin: 6px 0;
		border-collapse: collapse;
		font-size: 12px;
		width: 100%;
	}
	:global(.md-table th),
	:global(.md-table td) {
		border: 1px solid var(--border);
		padding: 4px 8px;
		text-align: left;
	}
	:global(.md-table th) {
		background: var(--muted);
		font-weight: 600;
	}
	:global(.md-table td) {
		color: var(--foreground);
	}
</style>
