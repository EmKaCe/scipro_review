<script lang="ts">
	import type { ExecutorLogEntry } from "$lib/services/submissions-api.js";
	import Terminal from "@lucide/svelte/icons/terminal";
	import RefreshCw from "@lucide/svelte/icons/refresh-cw";
	import ChevronDown from "@lucide/svelte/icons/chevron-down";
	import ChevronUp from "@lucide/svelte/icons/chevron-up";
	import Radio from "@lucide/svelte/icons/radio";

	interface Props {
		entries: ExecutorLogEntry[];
		/** True while a batch run is in flight (the panel auto-refreshes). */
		live: boolean;
		/** True while a log fetch is in flight. */
		loading?: boolean;
		/** Set when the log fetch failed (shown instead of the list). */
		error?: string | null;
		/** Optional completed-run summary chip, e.g. "3/3 · auto-fix 1/1". */
		summary?: string | null;
		onRefresh: () => void;
	}

	let {
		entries,
		live,
		loading = false,
		error = null,
		summary = null,
		onRefresh,
	}: Props = $props();

	let open = $state(false);
	let scrollRef: HTMLDivElement | undefined = $state(undefined);

	// Follow the tail while live: keep the newest lines in view.
	$effect(() => {
		if (!open || !live) return;
		scrollRef?.scrollTo({ top: scrollRef.scrollHeight });
	});

	function formatTime(ts: number): string {
		return new Date(ts * 1000).toLocaleTimeString([], {
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
		});
	}

	function levelClass(level: string): string {
		if (level === "error" || level === "critical") return "log-error";
		if (level === "warning") return "log-warning";
		if (level === "debug") return "log-debug";
		return "log-info";
	}
</script>

<div class="pipeline-log-panel" class:pipeline-log-open={open}>
	<button
		class="pipeline-log-toggle"
		type="button"
		aria-expanded={open}
		onclick={() => (open = !open)}
	>
		<Terminal size={14} />
		<span class="pipeline-log-title">Pipeline log</span>
		{#if live}
			<span class="pipeline-log-live">
				<Radio size={11} />
				Live
			</span>
		{:else if summary}
			<span class="pipeline-log-summary">{summary}</span>
		{/if}
		<span class="pipeline-log-count">{entries.length}</span>
		{#if open}
			<ChevronUp size={14} />
		{:else}
			<ChevronDown size={14} />
		{/if}
	</button>

	{#if open}
		<div class="pipeline-log-body">
			<div class="pipeline-log-toolbar">
				<span class="pipeline-log-hint">
					Captured from the executor (preprocessing, execution, autofix, LLM).
				</span>
				<button
					class="pipeline-log-tool"
					type="button"
					onclick={onRefresh}
					disabled={loading}
					title="Refresh logs"
				>
					<RefreshCw size={12} class={loading ? "spin" : ""} />
					Refresh
				</button>
			</div>
			{#if error}
				<div class="pipeline-log-error">Logs unavailable: {error}</div>
			{:else if entries.length === 0}
				<div class="pipeline-log-empty">
					No pipeline activity captured yet. Start a batch to see executor logs here.
				</div>
			{:else}
				<div class="pipeline-log-lines" bind:this={scrollRef}>
					{#each entries as entry (entry.id)}
						<div class="pipeline-log-line {levelClass(entry.level)}">
							<span class="log-time">{formatTime(entry.ts)}</span>
							<span class="log-level">{entry.level}</span>
							<span class="log-logger">{entry.logger}</span>
							<span class="log-message">{entry.message}</span>
						</div>
					{/each}
				</div>
			{/if}
		</div>
	{/if}
</div>

<style>
	.pipeline-log-panel {
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--card);
		overflow: hidden;
	}
	.pipeline-log-toggle {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		padding: 8px 14px;
		background: transparent;
		border: none;
		cursor: pointer;
		font: inherit;
		color: var(--fg);
	}
	.pipeline-log-title {
		font-size: 13px;
		font-weight: 600;
	}
	.pipeline-log-live {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		font-size: 11px;
		font-weight: 600;
		color: var(--success);
		background: color-mix(in oklch, var(--success) 12%, transparent);
		border: 1px solid color-mix(in oklch, var(--success) 25%, transparent);
		border-radius: 999px;
		padding: 1px 7px;
	}
	.pipeline-log-summary {
		display: inline-flex;
		align-items: center;
		font-size: 11px;
		font-weight: 600;
		color: var(--primary);
		background: color-mix(in oklch, var(--accent) 12%, transparent);
		border: 1px solid color-mix(in oklch, var(--accent) 25%, transparent);
		border-radius: 999px;
		padding: 1px 7px;
	}
	.pipeline-log-count {
		margin-left: auto;
		font-size: 11px;
		color: var(--muted-foreground);
		font-variant-numeric: tabular-nums;
	}
	.pipeline-log-body {
		border-top: 1px solid var(--border);
	}
	.pipeline-log-toolbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: 6px 14px;
		background: var(--muted-bg);
	}
	.pipeline-log-hint {
		font-size: 11px;
		color: var(--muted-foreground);
	}
	.pipeline-log-tool {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-size: 11px;
		font-weight: 500;
		color: var(--fg);
		background: transparent;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 3px 8px;
		cursor: pointer;
	}
	.pipeline-log-tool:disabled {
		opacity: 0.6;
		cursor: default;
	}
	.pipeline-log-error {
		padding: 10px 14px;
		font-size: 12px;
		color: var(--destructive);
	}
	.pipeline-log-empty {
		padding: 14px;
		font-size: 12px;
		color: var(--muted-foreground);
	}
	.pipeline-log-lines {
		max-height: 260px;
		overflow-y: auto;
		padding: 6px 0;
		font-family: var(--font-mono, ui-monospace, "SF Mono", Menlo, Consolas, monospace);
		font-size: 11px;
		line-height: 1.55;
	}
	.pipeline-log-line {
		display: flex;
		gap: 8px;
		padding: 0 14px;
		white-space: pre-wrap;
		word-break: break-word;
	}
	.log-time {
		flex-shrink: 0;
		color: var(--muted-foreground);
		font-variant-numeric: tabular-nums;
	}
	.log-level {
		flex-shrink: 0;
		width: 46px;
		text-transform: uppercase;
		font-size: 10px;
		letter-spacing: 0.04em;
	}
	.log-logger {
		flex-shrink: 0;
		color: var(--muted-foreground);
	}
	.log-message {
		color: var(--fg);
	}
	.log-error .log-level,
	.log-error .log-message {
		color: var(--destructive);
	}
	.log-warning .log-level,
	.log-warning .log-message {
		color: color-mix(in oklch, var(--fg) 78%, var(--accent));
	}
	.log-debug .log-message {
		color: var(--muted-foreground);
	}
</style>
