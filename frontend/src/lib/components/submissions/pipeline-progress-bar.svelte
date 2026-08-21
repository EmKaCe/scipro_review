<script lang="ts">
	import Zap from "@lucide/svelte/icons/zap";
	import CheckCircle2 from "@lucide/svelte/icons/circle-check";

	interface Props {
		/** Notebooks settled (executed or error). */
		done: number;
		/** Total notebooks targeted by the run. */
		total: number;
		/** Student id of the notebook currently being processed. */
		currentId?: string | null;
		/** Formatted elapsed time of the whole run (e.g. "3m:22s"). */
		elapsed?: string;
		/** Automatic autofix re-runs attempted across the run. */
		autofixAttempts?: number;
		/** Automatic autofix re-runs that finished without an error. */
		autofixSucceeded?: number;
		/** True while a run is active (false renders the completed summary). */
		running: boolean;
		/** Run label for the header line (defaults to the process batch). */
		label?: string;
	}

	let {
		done,
		total,
		currentId = undefined,
		elapsed = undefined,
		autofixAttempts = 0,
		autofixSucceeded = 0,
		running,
		label = "Processing batch",
	}: Props = $props();

	/** Bar fill as a percentage, clamped to [0, 100]. */
	let percentage = $derived(total > 0 ? Math.min(Math.max((done / total) * 100, 0), 100) : 0);

	/** The auto-fix tally line only renders after the first attempt. */
	let showAutofix = $derived(autofixAttempts > 0);
</script>

<div
	class="pipeline-progress"
	role="progressbar"
	aria-valuenow={done}
	aria-valuemin={0}
	aria-valuemax={total}
	aria-label="Pipeline progress: {done} of {total} notebooks"
>
	<div class="pipeline-progress-head">
		<span class="pipeline-progress-title">
			<span class="pipeline-progress-icon" aria-hidden="true">
				{#if running}
					<Zap size={13} />
				{:else}
					<CheckCircle2 size={13} />
				{/if}
			</span>
			{running ? label : `${label} complete`}
		</span>
		<span class="pipeline-progress-stats">
			<span class="pipeline-progress-count">{done} of {total}</span>
			{#if elapsed}
				<span class="pipeline-progress-elapsed">elapsed {elapsed}</span>
			{/if}
		</span>
	</div>
	<div class="pipeline-progress-track">
		<div class="pipeline-progress-fill" style:width="{percentage}%"></div>
	</div>
	<div class="pipeline-progress-meta">
		{#if currentId}
			<span class="pipeline-progress-current">Current: {currentId}</span>
		{/if}
		{#if showAutofix}
			<span class="pipeline-progress-autofix">
				Auto-fix: {autofixSucceeded} succeeded / {autofixAttempts} attempts
			</span>
		{/if}
	</div>
</div>

<style>
	.pipeline-progress {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 10px 14px;
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		background: var(--card);
	}
	.pipeline-progress-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 12px;
		flex-wrap: wrap;
	}
	.pipeline-progress-title {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 13px;
		font-weight: 600;
		color: var(--fg);
	}
	.pipeline-progress-icon {
		display: inline-flex;
		align-items: center;
		color: var(--primary);
	}
	.pipeline-progress-stats {
		display: inline-flex;
		align-items: baseline;
		gap: 10px;
		font-size: 12px;
		color: var(--muted-foreground);
	}
	.pipeline-progress-count {
		font-weight: 600;
		color: var(--primary);
		font-variant-numeric: tabular-nums;
	}
	.pipeline-progress-elapsed {
		font-variant-numeric: tabular-nums;
	}
	/* ── Bar: primary fill over a border-tinted track ── */
	.pipeline-progress-track {
		height: 7px;
		border-radius: 999px;
		background: color-mix(in oklch, var(--border) 40%, transparent);
		overflow: hidden;
	}
	.pipeline-progress-fill {
		height: 100%;
		border-radius: 999px;
		background: var(--primary);
		transition: width 0.5s ease;
	}
	.pipeline-progress-meta {
		display: flex;
		align-items: baseline;
		gap: 14px;
		flex-wrap: wrap;
		font-family: var(--font-mono, ui-monospace, Menlo, Consolas, monospace);
		font-size: 11px;
		color: var(--muted-foreground);
	}
	.pipeline-progress-current {
		color: var(--fg);
	}
	.pipeline-progress-autofix {
		color: var(--warning);
	}
</style>
