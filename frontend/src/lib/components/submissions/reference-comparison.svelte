<script lang="ts">
	import type { CellInfo } from "$lib/types/submissions.js";
	import CircleCheck from "@lucide/svelte/icons/circle-check";
	import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
	import CircleAlert from "@lucide/svelte/icons/circle-alert";
	import GitCompareArrows from "@lucide/svelte/icons/git-compare-arrows";
	import ChevronRight from "@lucide/svelte/icons/chevron-right";

	interface Props {
		/** The student's executed cells. */
		submissionCells: readonly CellInfo[];
		/** The reference key cells for comparison (optional). */
		referenceCells?: readonly CellInfo[];
	}

	let { submissionCells, referenceCells = [] }: Props = $props();

	let totalCells = $derived(submissionCells.length);
	let diffCount = $derived(
		submissionCells.filter((c) => c.marker === "questionable").length,
	);
	let errorCount = $derived(
		submissionCells.filter((c) => c.marker === "error").length,
	);
</script>

<details class="ref-compare">
	<summary>
		<ChevronRight size={14} class="chevron" />
		<span class="summary-title">Reference Comparison</span>
		<span class="summary-stats">
			<span class="stat">{totalCells} cells compared</span>
			{#if diffCount > 0}
				<span class="stat stat-diff">{diffCount} divergence{diffCount !== 1 ? "s" : ""}</span>
			{/if}
			{#if errorCount > 0}
				<span class="stat stat-error">{errorCount} error{errorCount !== 1 ? "s" : ""}</span>
			{/if}
		</span>
	</summary>
	<div class="ref-list">
		{#each submissionCells as cell (cell.index)}
			{@const isDiff = cell.marker === "questionable"}
			{@const isError = cell.marker === "error"}
			<div class="ref-row {isDiff ? 'row-diff' : isError ? 'row-error' : ''}">
				<span class="ref-idx">Cell {cell.index + 1}</span>
				{#if isError}
					<CircleAlert size={12} class="icon-error" />
				{:else if isDiff}
					<TriangleAlert size={12} class="icon-diff" />
				{:else}
					<CircleCheck size={12} class="icon-ok" />
				{/if}
				<span class="ref-desc">
					{cell.type === "code" ? "Code cell" : "Markdown"}
					{isError
						? "— execution failed"
						: isDiff
							? "— approach differs from reference"
							: "— approach matches reference"}
				</span>
				{#if isDiff}
					<span class="diff-badge">
						<GitCompareArrows size={10} />
						diverges
					</span>
				{/if}
			</div>
		{/each}
	</div>
</details>

<style>
	.ref-compare {
		border-bottom: 1px solid var(--border);
	}
	.ref-compare summary {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 16px;
		cursor: pointer;
		list-style: none;
		font-size: 13px;
		font-weight: 500;
		user-select: none;
		background: var(--muted);
	}
	.ref-compare summary::-webkit-details-marker {
		display: none;
	}

	.summary-title {
		font-weight: 600;
	}
	.summary-stats {
		margin-left: auto;
		display: flex;
		gap: 14px;
		font-size: 12px;
		font-weight: 400;
		color: var(--muted-foreground);
	}
	.stat-diff {
		color: var(--warning);
	}
	.stat-error {
		color: var(--destructive);
	}
	.ref-list {
		padding: 8px 16px 12px;
		border-top: 1px solid var(--border);
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.ref-row {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 12px;
		padding: 3px 0;
	}
	.ref-row.row-diff {
		background: color-mix(in oklch, var(--warning) 12%, transparent);
		margin: 0 -16px;
		padding: 3px 16px;
	}
	.ref-row.row-error {
		background: color-mix(in oklch, var(--destructive) 10%, var(--bg));
		margin: 0 -16px;
		padding: 3px 16px;
	}
	.ref-idx {
		width: 52px;
		font-weight: 600;
		flex-shrink: 0;
	}

	.ref-desc {
		color: var(--muted-foreground);
	}
	.diff-badge {
		margin-left: auto;
		display: inline-flex;
		align-items: center;
		gap: 3px;
		padding: 1px 5px;
		border-radius: 999px;
		font-size: 9px;
		font-weight: 600;
		background: color-mix(in oklch, var(--warning) 15%, transparent);
		color: var(--warning);
		flex-shrink: 0;
	}
</style>
