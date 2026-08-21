<script lang="ts">
	/**
	 * Readable rendering of tool arguments for the copilot chat.
	 *
	 * Flat key/value pairs render as rows (key muted, value foreground);
	 * nested objects/arrays collapse into a <details> whose escaped JSON is
	 * available for copy but is NOT the primary display. Malformed or empty
	 * input falls back to escaped raw text — this component never crashes a
	 * card and never emits unescaped HTML (all output goes through Svelte
	 * text interpolation only).
	 */

	let { args = "" }: { args?: string } = $props();

	/** Parse JSON text; null when not parseable. */
	function tryParse(text: string): unknown {
		try {
			const trimmed = text.trim();
			if (trimmed === "") return null;
			const value: unknown = JSON.parse(trimmed);
			return typeof value === "object" && value !== null ? value : null;
		} catch {
			return null;
		}
	}

	/** Rows of a flat object; nested values collapse under a <details>. */
	interface Row {
		key: string;
		value: string;
		json: string;
	}

	interface ArgsView {
		rows: Row[];
		fallbackText: string;
		parseOk: boolean;
	}

	let view = $derived.by((): ArgsView => {
		const parsed = tryParse(args);
		if (parsed === null) {
			return { rows: [], fallbackText: args, parseOk: false };
		}
		const obj = parsed as Record<string, unknown>;
		const out: Row[] = [];
		for (const [key, value] of Object.entries(obj)) {
			out.push({
				key,
				value: value === null || typeof value !== "object" ? String(value) : "",
				json: JSON.stringify(value, null, 2),
			});
		}
		return { rows: out, fallbackText: "", parseOk: true };
	});
</script>

{#if view.parseOk && view.rows.length > 0}
	<dl class="tool-args" role="list">
		{#each view.rows as row (row.key)}
			<div class="tool-args-row" role="listitem">
				<dt class="tool-args-key">{row.key}</dt>
				<dd class="tool-args-value">
					{#if row.value !== ""}
						{row.value}
					{:else}
						<details class="tool-args-nested">
							<summary class="tool-args-nested-summary">nested object</summary>
							<pre class="tool-args-json">{row.json}</pre>
						</details>
					{/if}
				</dd>
			</div>
		{/each}
	</dl>
{:else if view.fallbackText !== ""}
	<pre class="tool-args-fallback">{view.fallbackText}</pre>
{/if}

<style>
	.tool-args {
		display: flex;
		flex-direction: column;
		gap: 2px;
		margin: 0;
		padding: 0;
	}
	.tool-args-row {
		display: flex;
		gap: 8px;
		align-items: baseline;
		font-size: 12px;
		line-height: 1.4;
	}
	.tool-args-key {
		flex: none;
		min-width: 120px;
		color: var(--muted-foreground);
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
	}
	.tool-args-value {
		margin: 0;
		color: var(--foreground);
		word-break: break-word;
	}
	.tool-args-nested-summary {
		cursor: pointer;
		color: var(--primary);
		font-size: 12px;
		list-style: none;
	}
	.tool-args-nested-summary::-webkit-details-marker {
		display: none;
	}
	.tool-args-json,
	.tool-args-fallback {
		margin: 4px 0 0;
		padding: 6px 8px;
		background: var(--muted);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		font-size: 11px;
		line-height: 1.45;
		color: var(--foreground);
		overflow-x: auto;
		white-space: pre-wrap;
		word-break: break-word;
	}
</style>
