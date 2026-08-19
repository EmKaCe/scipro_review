<script lang="ts">
	import GitCompareArrows from "@lucide/svelte/icons/git-compare-arrows";
	import type { CalibrationAdjustment } from "$lib/types/submissions.js";

	interface Props {
		/**
		 * Old→new score corrections from cross-submission cohort
		 * calibration. Empty/absent → nothing is rendered (the caller may
		 * pass `?? []`).
		 */
		adjustments: readonly CalibrationAdjustment[];
	}

	let { adjustments }: Props = $props();

	/** Human-readable dimension label: "code_execution_results" → "Code execution results". */
	function dimensionLabel(dim: string): string {
		const label = dim.replace(/_+/g, " ").trim();
		if (!label) return dim;
		return label.charAt(0).toUpperCase() + label.slice(1);
	}

	/** Score formatter: drop trailing zeros (2.5, 3, 3.5). */
	function fmt(n: number): string {
		return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
	}

	const hasAdjustments = $derived(adjustments.length > 0);
</script>

{#if hasAdjustments}
	<div class="cal-note" role="note" aria-label="Cohort calibration">
		<div class="cal-note-head">
			<GitCompareArrows size={13} />
			<span class="cal-note-title">Cohort calibration</span>
		</div>
		<p class="cal-note-explain">
			Dimension scores were shifted toward the cohort reference during pre-evaluation
			calibration.
		</p>
		<ul class="cal-note-list">
			{#each adjustments as adj (adj.dimension)}
				<li class="cal-note-item">
					<span class="cal-dim">{dimensionLabel(adj.dimension)}</span>
					<span class="cal-from">{fmt(adj.oldScore)}</span>
					<span class="cal-arrow">&rarr;</span>
					<span class="cal-to">{fmt(adj.newScore)}</span>
				</li>
			{/each}
		</ul>
	</div>
{/if}

<style>
	.cal-note {
		padding: 8px 16px 10px;
		border-top: 1px solid var(--border);
		border-bottom: 1px solid var(--border);
		background: color-mix(in oklch, var(--accent) 6%, transparent);
		font-size: 12px;
	}
	.cal-note-head {
		display: flex;
		align-items: center;
		gap: 6px;
		font-weight: 600;
		margin-bottom: 4px;
	}
	.cal-note-head :global(svg) {
		color: var(--muted-foreground);
		flex-shrink: 0;
	}
	.cal-note-explain {
		margin: 0 0 6px;
		color: var(--muted-foreground);
		line-height: 1.4;
	}
	.cal-note-list {
		margin: 0;
		padding: 0;
		list-style: none;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.cal-note-item {
		display: flex;
		align-items: baseline;
		gap: 8px;
	}
	.cal-dim {
		font-weight: 600;
	}
	.cal-from {
		margin-left: auto;
		color: var(--muted-foreground);
		font-variant-numeric: tabular-nums;
	}
	.cal-arrow {
		color: var(--warning);
	}
	.cal-to {
		font-weight: 700;
		font-variant-numeric: tabular-nums;
		min-width: 24px;
	}
</style>
