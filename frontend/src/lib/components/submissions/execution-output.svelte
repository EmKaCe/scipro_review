<script lang="ts">
	import type { CellInfo } from "$lib/types/submissions.js";
	import CircleCheck from "@lucide/svelte/icons/circle-check";
	import GitFork from "@lucide/svelte/icons/git-fork";
	import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
	import CircleAlert from "@lucide/svelte/icons/circle-alert";
	import Sparkles from "@lucide/svelte/icons/sparkles";
	import type { LucideIcon } from "@lucide/svelte";
	import { SvelteMap, SvelteSet } from "svelte/reactivity";
	import AutofixCard from "./autofix-card.svelte";
	import { cellDelta } from "$lib/utils/cell-diff.js";
	import { renderMarkdown, highlightCode } from "$lib/utils/markdown.js";
	import "highlight.js/styles/github-dark.min.css";

	interface Props {
		cells: readonly CellInfo[];
		/** Submission id — autofix suggestions + notes target. */
		submissionId: string;
		/** Assignment id — route scoping. */
		assignmentId: string;
		/** Existing submission notes (autofix notes append to them). */
		existingNotes?: string;
		/** Forwarded to AutofixCard: top-level notes changed after a save. */
		onNotesSaved?: (notes: string) => void;
		/**
		 * Verified fixed execution from the automatic autofix stage, aligned
		 * by index. The original `cells` are never modified — this is the
		 * opt-in derived view (student work stays authentic).
		 */
		fixedCells?: readonly CellInfo[] | null;
		/**
		 * Ephemeral per-cell view set: indices currently showing the fixed
		 * version. The PAGE owns this (sticky counter + reset); when absent
		 * the component keeps its own local set. Never persisted.
		 */
		fixedView?: SvelteSet<number>;
		/**
		 * Teacher decision on a verified fix (durable via the grading save).
		 * Fired from the Accept/Ignore buttons on the fixed-view strip.
		 */
		onDisposition?: (cellIndex: number, disposition: "accepted" | "ignored") => void;
	}

	let {
		cells,
		submissionId,
		assignmentId,
		existingNotes = "",
		onNotesSaved,
		fixedCells = null,
		fixedView,
		onDisposition,
	}: Props = $props();

	/** Local view set when the page does not pass one down. */
	let localFixedView = new SvelteSet<number>();
	/** Which cells show the fixed version (page-owned or local). */
	const activeFixedView = $derived(fixedView ?? localFixedView);
	/** Cell index -> verified fixed cell (aligned with `cells`). */
	const fixedByIndex = $derived(new SvelteMap(fixedCells?.map((c) => [c.index, c]) ?? []));
	/** Per-cell open/closed state of the delta block (view state, ephemeral). */
	let openDeltas = new SvelteSet<number>();

	/** Toggle a cell between original and fixed view (mutates the view set). */
	function toggleFixed(index: number): void {
		if (activeFixedView.has(index)) {
			activeFixedView.delete(index);
		} else {
			activeFixedView.add(index);
		}
	}

	/** Toggle the delta block for a cell. */
	function toggleDelta(index: number): void {
		if (openDeltas.has(index)) {
			openDeltas.delete(index);
		} else {
			openDeltas.add(index);
		}
	}

	/** Line-number gutter for a code cell. */
	function lineNumbers(source: string): number[] {
		const count = source.split("\n").length;
		return Array.from({ length: Math.max(1, count) }, (_, i) => i + 1);
	}

	/** True when at least one cell carries a real Phase 4 comparison marker. */
	let hasComparison = $derived(
		cells.some(
			(c) => c.marker === "same" || c.marker === "different" || c.marker === "questionable",
		),
	);

	const markerConfig: Record<string, { label: string; icon: LucideIcon; class: string }> = {
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
	{#if !hasComparison}
		<div class="phase-notice">
			<Sparkles size={13} />
			<span>
				Approach markers (same / different / questionable) arrive with pre-evaluation —
				Phase 4.
			</span>
		</div>
	{/if}

	{#each cells as cell (cell.index)}
		{@const marker = markerConfig[cell.marker] ?? markerConfig.different}
		{@const showMarker = cell.marker === "error" || hasComparison}
		{@const fixed = fixedByIndex.get(cell.index)}
		{@const showFixed = fixed !== undefined && activeFixedView.has(cell.index)}
		{@const delta = fixed !== undefined ? cellDelta(cell, fixed) : null}
		<div
			class="cell-card {cell.marker === 'error'
				? 'cell-error'
				: cell.marker === 'questionable'
					? 'cell-questionable'
					: cell.marker === 'same'
						? 'cell-same'
						: ''}{showFixed ? ' cell-autofixed' : ''}"
		>
			<div class="cell-header">
				<span class="cell-num">Cell {cell.index + 1}</span>
				<span class="cell-type">· {cell.type}</span>
				{#if showMarker}
					<span class="cell-marker {marker.class}">
						{#if marker.icon}
							{@const MarkerIcon = marker.icon}
							<MarkerIcon size={12} />
						{/if}
						{marker.label}
					</span>
				{/if}
				{#if fixed}
					<button
						type="button"
						class="cell-toggle"
						onclick={() => toggleFixed(cell.index)}
					>
						{showFixed ? "Show original" : "Show auto-fixed"}
					</button>
				{/if}
				{#if delta}
					<button
						type="button"
						class="cell-toggle"
						onclick={() => toggleDelta(cell.index)}
					>
						{openDeltas.has(cell.index) ? "Hide delta" : "Show delta"}
					</button>
				{/if}
			</div>
			{#if cell.type === "code"}
				{#if showFixed && fixed}
					<!-- Loud, always-visible marker: the teacher must never
					     mistake the derived view for student work. -->
					<div class="autofix-strip">
						<Sparkles size={12} />
						<span>Auto-fixed — KI-verified fix</span>
						{#if onDisposition}
							<button
								type="button"
								class="strip-btn"
								onclick={() => onDisposition(cell.index, "accepted")}
							>
								Accept
							</button>
							<button
								type="button"
								class="strip-btn"
								onclick={() => onDisposition(cell.index, "ignored")}
							>
								Ignore
							</button>
						{/if}
						<button
							type="button"
							class="strip-link"
							onclick={() => activeFixedView.delete(cell.index)}
						>
							Show original
						</button>
					</div>
					<div class="cell-code">
						<div class="code-gutter" aria-hidden="true">
							{#each lineNumbers(fixed.source) as n (n)}<span>{n}</span>{/each}
						</div>
						<pre class="hljs">{@html highlightCode(fixed.source)}</pre>
					</div>
					{#if fixed.error}
						<div class="cell-error-block">{fixed.error}</div>
					{/if}
					{#if fixed.output}
						<div class="cell-output">{fixed.output}</div>
					{/if}
				{:else}
					<div class="cell-code">
						<div class="code-gutter" aria-hidden="true">
							{#each lineNumbers(cell.source) as n (n)}<span>{n}</span>{/each}
						</div>
						<pre class="hljs">{@html highlightCode(cell.source)}</pre>
					</div>
					{#if cell.error}
						<div class="cell-error-block">{cell.error}</div>
					{/if}
					{#if cell.output}
						<div class="cell-output">{cell.output}</div>
					{/if}
				{/if}
				{#if cell.error && fixed === undefined}
					<!-- Autofix card (P3-3): suggestion on demand, teacher writes
					     the final note. Only for failing code cells WITHOUT a
					     pipeline-verified fix (that cell has the toggle instead). -->
					<AutofixCard
						cellIndex={cell.index}
						source={cell.source}
						error={cell.error}
						{submissionId}
						{assignmentId}
						{existingNotes}
						{onNotesSaved}
					/>
				{/if}
			{:else}
				<div class="cell-markdown">{@html renderMarkdown(cell.source)}</div>
			{/if}
			{#if delta && openDeltas.has(cell.index)}
				<div class="delta-block">
					<div class="delta-title">What the auto-fix changed</div>
					{#each delta.changedLines as change (change.oldLine + change.newLine)}
						<div class="delta-line">
							<span class="delta-old">- {change.oldLine}</span>
							<span class="delta-new">+ {change.newLine}</span>
						</div>
					{/each}
					<div class="delta-state">
						Before: {delta.errorBefore || "no error"} · After: {delta.errorAfter ||
							"no error"}
					</div>
					{#if delta.outputBefore || delta.outputAfter}
						<div class="delta-state">
							Output before: {delta.outputBefore || "(none)"} → after: {delta.outputAfter ||
								"(none)"}
						</div>
					{/if}
				</div>
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
	.phase-notice {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 6px 10px;
		border-radius: var(--radius);
		border: 1px dashed color-mix(in oklch, var(--accent) 40%, transparent);
		background: color-mix(in oklch, var(--accent) 6%, transparent);
		color: var(--muted-foreground);
		font-size: 12px;
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
	/* Loud frame for the derived (auto-fixed) view — the teacher must never
	   mistake it for student work. */
	.cell-card.cell-autofixed {
		border: 2px solid var(--warning);
		border-left: 3px solid var(--warning);
		box-shadow: 0 0 0 1px color-mix(in oklch, var(--warning) 40%, transparent);
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
	.cell-toggle {
		margin-left: 8px;
		padding: 1px 8px;
		border: 1px solid var(--border);
		border-radius: 999px;
		background: var(--card);
		color: var(--foreground);
		font-size: 11px;
		font-weight: 600;
		cursor: pointer;
	}
	.cell-toggle:first-of-type {
		margin-left: auto;
	}
	.cell-toggle:hover {
		border-color: var(--accent);
		color: var(--accent);
	}
	/* In-cell strip — scrolls with the cell, never visible without it. */
	.autofix-strip {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 5px 12px;
		background: color-mix(in oklch, var(--warning) 18%, transparent);
		color: var(--warning);
		font-size: 11px;
		font-weight: 600;
		border-bottom: 1px solid color-mix(in oklch, var(--warning) 40%, transparent);
	}
	.strip-link {
		margin-left: auto;
		background: none;
		border: none;
		padding: 0;
		color: inherit;
		font-size: inherit;
		font-weight: 600;
		text-decoration: underline;
		cursor: pointer;
	}
	.strip-btn {
		padding: 1px 8px;
		border: 1px solid color-mix(in oklch, var(--warning) 50%, transparent);
		border-radius: 999px;
		background: transparent;
		color: inherit;
		font-size: 11px;
		font-weight: 600;
		cursor: pointer;
	}
	.strip-btn:hover {
		background: color-mix(in oklch, var(--warning) 25%, transparent);
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
		display: flex;
		background: oklch(0.148 0.004 228.8);
		color: oklch(0.987 0.002 197.1);
		font-family: ui-monospace, "SFMono-Regular", monospace;
		font-size: 12px;
		line-height: 1.5;
	}
	.code-gutter {
		flex-shrink: 0;
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		padding: 10px 8px 10px 12px;
		border-right: 1px solid oklch(0.3 0.01 228.8);
		background: oklch(0.19 0.005 228.8);
		color: oklch(0.65 0.01 228.8);
		user-select: none;
		text-align: right;
	}
	.cell-code pre {
		margin: 0;
		padding: 10px 12px;
		white-space: pre;
		overflow-x: auto;
		flex: 1;
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
	.delta-block {
		padding: 8px 12px;
		background: color-mix(in oklch, var(--info) 6%, var(--bg));
		border-top: 1px solid var(--border);
		font-size: 12px;
	}
	.delta-title {
		font-weight: 600;
		margin-bottom: 6px;
	}
	.delta-line {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 2px 0;
		font-family: ui-monospace, "SFMono-Regular", monospace;
		white-space: pre-wrap;
	}
	.delta-old {
		color: var(--destructive);
	}
	.delta-new {
		color: var(--success);
	}
	.delta-state {
		margin-top: 6px;
		color: var(--muted-foreground);
		white-space: pre-wrap;
	}
</style>
