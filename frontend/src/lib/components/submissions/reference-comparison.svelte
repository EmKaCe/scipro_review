<script lang="ts">
	import type { CellInfo } from "$lib/types/submissions.js";
	import CircleCheck from "@lucide/svelte/icons/circle-check";
	import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
	import CircleAlert from "@lucide/svelte/icons/circle-alert";
	import Sparkles from "@lucide/svelte/icons/sparkles";
	import GitCompareArrows from "@lucide/svelte/icons/git-compare-arrows";
	import ChevronRight from "@lucide/svelte/icons/chevron-right";

	interface Props {
		/** The student's executed cells. */
		submissionCells: readonly CellInfo[];
	}

	let { submissionCells }: Props = $props();

	/** Cells with a real Phase 4 comparison verdict. */
	let comparedCount = $derived(
		submissionCells.filter(
			(c) => c.marker === "same" || c.marker === "different" || c.marker === "questionable",
		).length,
	);
	let diffCount = $derived(submissionCells.filter((c) => c.marker === "questionable").length);
	let errorCount = $derived(submissionCells.filter((c) => c.marker === "error").length);
</script>

<details class="ref-compare">
	<summary>
		<ChevronRight size={14} class="chevron" />
		<span class="summary-title">Reference Comparison</span>
		{#if comparedCount === 0}
			<span class="phase-chip">Phase 4</span>
		{:else}
			<span class="summary-stats">
				<span class="stat">{comparedCount} cells compared</span>
				{#if diffCount > 0}
					<span class="stat stat-diff"
						>{diffCount} divergence{diffCount !== 1 ? "s" : ""}</span
					>
				{/if}
				{#if errorCount > 0}
					<span class="stat stat-error"
						>{errorCount} error{errorCount !== 1 ? "s" : ""}</span
					>
				{/if}
			</span>
		{/if}
	</summary>

	{#if comparedCount === 0}
		<div class="ref-pending">
			<Sparkles size={14} />
			<span>
				Per-cell comparison with the reference key arrives with pre-evaluation — Phase 4.
				Execution errors (if any) are shown below.
			</span>
		</div>
		{#if errorCount > 0}
			<div class="ref-list">
				{#each submissionCells as cell (cell.index)}
					{#if cell.marker === "error"}
						<div class="ref-row row-error">
							<span class="ref-idx">Cell {cell.index + 1}</span>
							<CircleAlert size={12} class="icon-error" />
							<span class="ref-desc">
								{cell.type === "code" ? "Code cell" : "Markdown"} — execution failed
							</span>
						</div>
					{/if}
				{/each}
			</div>
		{/if}
	{:else}
		<div class="ref-list">
			{#each submissionCells as cell (cell.index)}
				{@const isDiff = cell.marker === "questionable"}
				{@const isError = cell.marker === "error"}
				{@const isSame = cell.marker === "same"}
				{#if cell.marker !== "pending"}
					<div class="ref-row {isDiff ? 'row-diff' : isError ? 'row-error' : ''}">
						<span class="ref-idx">Cell {cell.index + 1}</span>
						{#if isError}
							<CircleAlert size={12} class="icon-error" />
						{:else if isDiff}
							<TriangleAlert size={12} class="icon-diff" />
						{:else if isSame}
							<CircleCheck size={12} class="icon-ok" />
						{:else}
							<GitCompareArrows size={12} class="icon-neutral" />
						{/if}
						<span class="ref-desc">
							{cell.type === "code" ? "Code cell" : "Markdown"}
							{isError
								? "— execution failed"
								: isDiff
									? "— approach is questionable"
									: isSame
										? "— approach matches reference"
										: "— approach differs from reference"}
						</span>
						{#if isDiff}
							<span class="diff-badge">
								<GitCompareArrows size={10} />
								diverges
							</span>
						{/if}
					</div>
				{/if}
			{/each}
		</div>
	{/if}
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
	.phase-chip {
		margin-left: auto;
		display: inline-flex;
		align-items: center;
		padding: 1px 8px;
		border-radius: 999px;
		font-size: 10px;
		font-weight: 700;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		background: color-mix(in oklch, var(--accent) 14%, transparent);
		color: var(--accent);
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
	.ref-pending {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 10px 16px;
		font-size: 12px;
		color: var(--muted-foreground);
		background: color-mix(in oklch, var(--accent) 5%, transparent);
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
	:global(.icon-ok) {
		color: var(--info);
		flex-shrink: 0;
	}
	:global(.icon-diff) {
		color: var(--warning);
		flex-shrink: 0;
	}
	:global(.icon-error) {
		color: var(--destructive);
		flex-shrink: 0;
	}
	:global(.icon-neutral) {
		color: var(--muted-foreground);
		flex-shrink: 0;
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
