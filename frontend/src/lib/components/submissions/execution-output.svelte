<script lang="ts">
	import type { CellInfo } from "$lib/types/submissions.js";
	import CircleCheck from "@lucide/svelte/icons/circle-check";
	import GitFork from "@lucide/svelte/icons/git-fork";
	import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
	import CircleAlert from "@lucide/svelte/icons/circle-alert";
	import { marked } from "marked";

	interface Props {
		cells: readonly CellInfo[];
	}

	let { cells }: Props = $props();

	function renderMarkdown(src: string): string {
		try {
			return marked.parse(src, { async: false }) as string;
		} catch {
			return src;
		}
	}

	const markerConfig: Record<
		string,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		{ label: string; icon: any; class: string }
	> = {
		same: {
			label: "Same approach",
			icon: CircleCheck,
			class: "badge-info",
		},
		different: {
			label: "Different approach",
			icon: GitFork,
			class: "badge-neutral",
		},
		questionable: {
			label: "Questionable",
			icon: TriangleAlert,
			class: "badge-warning",
		},
		error: {
			label: "Error",
			icon: CircleAlert,
			class: "badge-error",
		},
	};
</script>

<div class="cell-list">
	{#each cells as cell (cell.index)}
		{@const marker = markerConfig[cell.marker] ?? markerConfig.different}
		<div
			class="cell-card {cell.marker === 'error'
				? 'cell-error'
				: cell.marker === 'questionable'
					? 'cell-questionable'
					: cell.marker === 'same'
						? 'cell-same'
						: ''}"
		>
			<div class="cell-header">
				<span class="cell-num">Cell {cell.index + 1}</span>
				<span class="cell-type">· {cell.type}</span>
				<span class="cell-marker {marker.class}">
					{#if marker.icon}
						{@const MarkerIcon = marker.icon}
						<MarkerIcon size={12} />
					{/if}
					{marker.label}
				</span>
			</div>
			{#if cell.type === "code"}
				<div class="cell-code"><pre>{cell.source}</pre></div>
				{#if cell.error}
					<div class="cell-error-block">{cell.error}</div>
				{/if}
				{#if cell.output}
					<div class="cell-output">{cell.output}</div>
				{/if}
			{:else}
				<div class="cell-markdown">{@html renderMarkdown(cell.source)}</div>
			{/if}
		</div>
	{/each}
</div>

<style>
	.cell-list {
		display: flex;
		flex-direction: column;
		gap: 12px;
		padding: 12px 16px;
	}
	.cell-card {
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--card);
		overflow: hidden;
	}
	.cell-card.cell-error {
		border-left: 3px solid var(--destructive);
	}
	.cell-card.cell-questionable {
		border-left: 3px solid var(--warning);
	}
	.cell-card.cell-same {
		border-left: 3px solid var(--info);
	}
	.cell-header {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 6px 12px;
		background: var(--muted);
		border-bottom: 1px solid var(--border);
		font-size: 12px;
		font-weight: 500;
	}
	.cell-num {
		font-weight: 600;
	}
	.cell-type {
		color: var(--muted-foreground);
	}
	.cell-marker {
		margin-left: auto;
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 1px 6px;
		border-radius: 999px;
		font-size: 10px;
		font-weight: 600;
	}
	.badge-info {
		background: color-mix(in oklch, var(--info) 15%, transparent);
		color: var(--info);
	}
	.badge-neutral {
		background: color-mix(in oklch, var(--muted-foreground) 12%, transparent);
		color: var(--muted-foreground);
	}
	.badge-warning {
		background: color-mix(in oklch, var(--warning) 18%, transparent);
		color: var(--warning);
	}
	.badge-error {
		background: color-mix(in oklch, var(--destructive) 15%, transparent);
		color: var(--destructive);
	}
	.cell-code {
		background: oklch(0.148 0.004 228.8);
		color: oklch(0.987 0.002 197.1);
		padding: 10px 12px;
		font-family: ui-monospace, "SFMono-Regular", monospace;
		font-size: 12px;
		line-height: 1.5;
		overflow-x: auto;
	}
	.cell-code pre {
		margin: 0;
		white-space: pre;
	}
	.cell-output {
		padding: 8px 12px;
		background: var(--muted);
		font-family: ui-monospace, "SFMono-Regular", monospace;
		font-size: 12px;
		border-top: 1px solid var(--border);
	}
	.cell-error-block {
		padding: 8px 12px;
		background: color-mix(in oklch, var(--destructive) 8%, var(--bg));
		color: var(--destructive);
		font-family: ui-monospace, "SFMono-Regular", monospace;
		font-size: 12px;
		border-top: 1px solid var(--border);
		white-space: pre-wrap;
	}
	.cell-markdown {
		padding: 10px 12px;
		font-size: 13px;
		line-height: 1.5;
		white-space: pre-wrap;
	}
</style>
