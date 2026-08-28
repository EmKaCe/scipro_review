<script lang="ts">
	import type { CellInfo, PreEvalData } from "$lib/types/submissions.js";
	import Sparkles from "@lucide/svelte/icons/sparkles";
	import FileText from "@lucide/svelte/icons/file-text";
	import Gauge from "@lucide/svelte/icons/gauge";
	import { hasRealMarkers } from "$lib/utils/marker-rendering.js";

	interface Props {
		/** The student's executed cells. */
		submissionCells: readonly CellInfo[];
		/**
		 * Pre-evaluation comparison data. Absent, or
		 * `preEval.markers === null`, means no comparison data yet — the
		 * pending/neutral notice is shown (cells are never defaulted to
		 * "different"). This is an EXPLAINER, not an auditor: "different"
		 * renders as a neutral "approach differs from reference", never as
		 * a flag.
		 */
		preEval?: PreEvalData | null;
		/**
		 * Fired when the teacher clicks "Apply suggested scores". Emits the
		 * full pre-evaluation envelope; the PAGE wraps it into a `grade`
		 * CopilotSuggestion and runs the normal apply path (dimensions +
		 * feedback draft + rubric selections).
		 */
		onApplyGradeSuggestion?: (preEval: PreEvalData) => void;
		/**
		 * Display titles for suggested-grade dimension keys (key → title),
		 * resolved from the grading config. Falls back to the raw key when
		 * a dimension has no entry.
		 */
		dimensionTitles?: Record<string, string>;
	}

	let {
		submissionCells,
		preEval = null,
		onApplyGradeSuggestion,
		dimensionTitles = {},
	}: Props = $props();

	/** Real comparison verdicts (null = no comparison data yet). */
	const markers = $derived(preEval?.markers ?? null);
	const hasMarkers = $derived(hasRealMarkers(markers));
	/** Verdicts sorted by cell index for a stable list. */
	const verdicts = $derived([...(markers ?? [])].sort((a, b) => a.cellIndex - b.cellIndex));
	const errorCells = $derived(submissionCells.filter((c) => c.marker === "error"));
	const questionableCount = $derived(verdicts.filter((v) => v.marker === "questionable").length);

	const notebookSummary = $derived(preEval?.notebookSummary ?? "");
	const gradeSuggestion = $derived(preEval?.gradeSuggestion ?? null);
</script>

<section class="ref-compare">
	<header class="ref-header">
		<span class="summary-title">Pre-evaluation results</span>
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
		{#if hasMarkers && gradeSuggestion && Object.keys(gradeSuggestion.dimensions).length > 0}
			<button
				type="button"
				class="ref-apply-btn"
				onclick={() => preEval && onApplyGradeSuggestion?.(preEval)}
			>
				<Sparkles size={13} />
				Apply suggested scores
			</button>
		{/if}
	</header>

	{#if !hasMarkers}
		<div class="ref-pending">
			<Sparkles size={14} />
			<span>
				Run pre-evaluation to get a notebook summary, suggested scores, and per-cell notes.
			</span>
		</div>
	{:else}
		{#if notebookSummary}
			<div class="ref-summary">
				<FileText size={13} class="icon-neutral" />
				<span>{notebookSummary}</span>
			</div>
		{/if}
		{#if gradeSuggestion}
			<div class="ref-suggestion">
				<div class="ref-suggestion-title">
					<Gauge size={13} class="icon-neutral" />
					<span>Suggested grade</span>
				</div>
				<div class="ref-suggestion-grid">
					{#each Object.entries(gradeSuggestion.dimensions) as [dimension, value] (dimension)}
						<span class="ref-dim">{dimensionTitles[dimension] ?? dimension}</span>
						<span class="ref-dim-value">{value}</span>
					{/each}
				</div>
				{#if gradeSuggestion.justification}
					<div class="ref-suggestion-just">{gradeSuggestion.justification}</div>
				{/if}
			</div>
		{/if}
	{/if}
</section>

<style>
	.ref-compare {
		border-bottom: 1px solid var(--border);
	}
	.ref-header {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 16px;
		font-size: 13px;
		font-weight: 500;
		background: var(--muted);
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
	.ref-pending :global(svg) {
		flex-shrink: 0;
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
	:global(.icon-neutral) {
		color: var(--muted-foreground);
		flex-shrink: 0;
	}
	.ref-apply-btn {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		background: var(--primary);
		color: var(--primary-foreground);
		border: none;
		border-radius: var(--radius);
		padding: 5px 14px;
		font-size: 12px;
		font-weight: 600;
		cursor: pointer;
	}
	.ref-apply-btn:hover {
		opacity: 0.9;
	}
</style>
