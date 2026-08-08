<script lang="ts">
	import type { CellInfo, PreEvalData, PreEvalMarker } from "$lib/types/submissions.js";
	import CircleCheck from "@lucide/svelte/icons/circle-check";
	import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
	import CircleAlert from "@lucide/svelte/icons/circle-alert";
	import Sparkles from "@lucide/svelte/icons/sparkles";
	import GitCompareArrows from "@lucide/svelte/icons/git-compare-arrows";
	import ChevronRight from "@lucide/svelte/icons/chevron-right";
	import FileText from "@lucide/svelte/icons/file-text";
	import Gauge from "@lucide/svelte/icons/gauge";
	import { hasRealMarkers, markerTone } from "$lib/utils/marker-rendering.js";

	interface Props {
		/** The student's executed cells. */
		submissionCells: readonly CellInfo[];
		/**
		 * Pre-evaluation comparison data (Phase 4c). Absent, or
		 * `preEval.markers === null`, means no comparison data yet — the
		 * pending/neutral notice is shown (cells are never defaulted to
		 * "different"). This is an EXPLAINER, not an auditor: "different"
		 * renders as a neutral "approach differs from reference", never as
		 * a flag.
		 */
		preEval?: PreEvalData | null;
	}

	/** One row of the overview list: a comparison verdict or an execution error. */
	type OverviewRow =
		| { kind: "verdict"; index: number; marker: PreEvalMarker; reason: string }
		| { kind: "error"; index: number; cell: CellInfo };

	let { submissionCells, preEval = null }: Props = $props();

	/** Real comparison verdicts (null = no comparison data yet). */
	const markers = $derived(preEval?.markers ?? null);
	const hasMarkers = $derived(hasRealMarkers(markers));
	/** Verdicts sorted by cell index for a stable list. */
	const verdicts = $derived([...(markers ?? [])].sort((a, b) => a.cellIndex - b.cellIndex));
	const errorCells = $derived(submissionCells.filter((c) => c.marker === "error"));
	const questionableCount = $derived(verdicts.filter((v) => v.marker === "questionable").length);

	const notebookSummary = $derived(preEval?.notebookSummary ?? "");
	const gradeSuggestion = $derived(preEval?.gradeSuggestion ?? null);

	/**
	 * Verdict rows plus execution-error rows the verdicts do not cover,
	 * ordered by cell index. An error cell that also has a verdict is shown
	 * once (the verdict row — its reason explains the comparison).
	 */
	const rows = $derived.by(() => {
		const result: OverviewRow[] = [];
		for (const v of verdicts) {
			result.push({
				kind: "verdict",
				index: v.cellIndex,
				marker: v.marker,
				reason: v.reason,
			});
		}
		for (const cell of errorCells) {
			if (!verdicts.some((v) => v.cellIndex === cell.index)) {
				result.push({ kind: "error", index: cell.index, cell });
			}
		}
		result.sort((a, b) => a.index - b.index);
		return result;
	});
</script>

<details class="ref-compare">
	<summary>
		<ChevronRight size={14} class="chevron" />
		<span class="summary-title">Reference Comparison</span>
		{#if hasMarkers}
			<span class="summary-stats">
				<span class="stat">{verdicts.length} cells compared</span>
				{#if questionableCount > 0}
					<span class="stat stat-diff">{questionableCount} questionable</span>
				{/if}
				{#if errorCells.length > 0}
					<span class="stat stat-error"
						>{errorCells.length} error{errorCells.length !== 1 ? "s" : ""}</span
					>
				{/if}
			</span>
		{/if}
	</summary>

	{#if !hasMarkers}
		<div class="ref-pending">
			<Sparkles size={14} />
			<span>
				Per-cell comparison with the reference key appears once pre-evaluation has run.
				Execution errors (if any) are shown below.
			</span>
		</div>
		{#if errorCells.length > 0}
			<div class="ref-list">
				{#each errorCells as cell (cell.index)}
					<div class="ref-row row-error">
						<span class="ref-idx">Cell {cell.index + 1}</span>
						<CircleAlert size={12} class="icon-error" />
						<span class="ref-desc">
							{cell.type === "code" ? "Code cell" : "Markdown"} — execution failed
						</span>
					</div>
				{/each}
			</div>
		{/if}
	{:else}
		{#if notebookSummary}
			<div class="ref-summary">
				<FileText size={13} class="icon-neutral" />
				<span>{notebookSummary}</span>
			</div>
		{/if}
		<div class="ref-list">
			{#each rows as row (row.index)}
				{#if row.kind === "verdict"}
					{@const tone = markerTone(row.marker)}
					<div class="ref-row {tone === 'warning' ? 'row-diff' : ''}">
						<span class="ref-idx">Cell {row.index + 1}</span>
						{#if row.marker === "same"}
							<CircleCheck size={12} class="icon-ok" />
						{:else if row.marker === "questionable"}
							<TriangleAlert size={12} class="icon-diff" />
						{:else}
							<GitCompareArrows size={12} class="icon-neutral" />
						{/if}
						<span class="ref-desc">
							{row.marker === "same"
								? "Approach matches reference"
								: row.marker === "questionable"
									? "Approach is questionable"
									: "Approach differs from reference"}
						</span>
						{#if row.reason}
							<span class="ref-reason">{row.reason}</span>
						{/if}
					</div>
				{:else}
					<div class="ref-row row-error">
						<span class="ref-idx">Cell {row.index + 1}</span>
						<CircleAlert size={12} class="icon-error" />
						<span class="ref-desc">
							{row.cell.type === "code" ? "Code cell" : "Markdown"} — execution failed
						</span>
					</div>
				{/if}
			{/each}
		</div>
		{#if gradeSuggestion}
			<div class="ref-suggestion">
				<div class="ref-suggestion-title">
					<Gauge size={13} class="icon-neutral" />
					<span>Suggested grade</span>
				</div>
				<div class="ref-suggestion-grid">
					{#each Object.entries(gradeSuggestion.dimensions) as [dimension, value] (dimension)}
						<span class="ref-dim">{dimension}</span>
						<span class="ref-dim-value">{value}</span>
					{/each}
				</div>
				{#if gradeSuggestion.justification}
					<div class="ref-suggestion-just">{gradeSuggestion.justification}</div>
				{/if}
			</div>
		{/if}
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
	.ref-summary {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		padding: 10px 16px;
		font-size: 12px;
		color: var(--muted-foreground);
		border-top: 1px solid var(--border);
		background: color-mix(in oklch, var(--info) 6%, transparent);
	}
	.ref-summary :global(svg) {
		margin-top: 1px;
		flex-shrink: 0;
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
	.ref-reason {
		color: var(--muted-foreground);
		margin-left: auto;
		text-align: right;
		font-size: 11px;
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
	.ref-suggestion {
		padding: 8px 16px 10px;
		border-top: 1px solid var(--border);
		font-size: 12px;
	}
	.ref-suggestion-title {
		display: flex;
		align-items: center;
		gap: 6px;
		font-weight: 600;
		margin-bottom: 6px;
	}
	.ref-suggestion-grid {
		display: grid;
		grid-template-columns: 1fr auto;
		gap: 2px 16px;
		max-width: 320px;
	}
	.ref-dim {
		color: var(--muted-foreground);
	}
	.ref-dim-value {
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}
	.ref-suggestion-just {
		margin-top: 6px;
		color: var(--muted-foreground);
	}
</style>
