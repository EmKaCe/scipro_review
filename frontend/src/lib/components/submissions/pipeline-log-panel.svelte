<script lang="ts">
	import type {
		ExecutorLogEntry,
		PipelineLogSource,
		PreEvalRunSummary,
	} from "$lib/services/submissions-api.js";
	import Terminal from "@lucide/svelte/icons/terminal";
	import RefreshCw from "@lucide/svelte/icons/refresh-cw";
	import ChevronDown from "@lucide/svelte/icons/chevron-down";
	import ChevronUp from "@lucide/svelte/icons/chevron-up";
	import ChevronRight from "@lucide/svelte/icons/chevron-right";
	import Radio from "@lucide/svelte/icons/radio";
	import ListFilter from "@lucide/svelte/icons/list-filter";
	import Search from "@lucide/svelte/icons/search";
	import X from "@lucide/svelte/icons/x";
	import Copy from "@lucide/svelte/icons/copy";
	import Check from "@lucide/svelte/icons/check";
	import Sparkles from "@lucide/svelte/icons/sparkles";
	import CheckCircle2 from "@lucide/svelte/icons/circle-check";
	import XCircle from "@lucide/svelte/icons/x-circle";
	import ArrowDownToLine from "@lucide/svelte/icons/arrow-down-to-line";

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
		/** Completed pre-evaluation run tallies (banner shown when not live). */
		preEvalSummary?: PreEvalRunSummary | null;
		/** Run progress for the compact collapsed strip (done/total). */
		progress?: { done: number; total: number } | null;
		onRefresh: () => void;
	}

	let {
		entries,
		live,
		loading = false,
		error = null,
		summary = null,
		preEvalSummary = null,
		progress = null,
		onRefresh,
	}: Props = $props();

	let open = $state(false);
	let scrollRef: HTMLDivElement | undefined = $state(undefined);
	/** Composite key of the row whose detail pane is expanded (one at a time). */
	let expandedKey = $state<string | null>(null);
	/** Whether the scroll view is pinned to the newest entries. */
	let stickToTail = $state(true);

	/** Source filter: all sources, executor only, or pre-evaluation only. */
	let sourceFilter = $state<"all" | PipelineLogSource>("all");

	/** Case-insensitive message search over the source-filtered timeline. */
	let searchQuery = $state("");

	/** Entries under the active source filter. */
	let visibleEntries = $derived(
		entries.filter((e) => sourceFilter === "all" || (e.source ?? "executor") === sourceFilter),
	);

	/** Entries after the message search (on top of the source filter). */
	let filteredEntries = $derived(
		searchQuery === ""
			? visibleEntries
			: visibleEntries.filter((e) =>
					e.message.toLowerCase().includes(searchQuery.toLowerCase()),
				),
	);

	/** Whether pre-eval entries exist at all (filter affordance visibility). */
	let hasPreEval = $derived(entries.some((e) => e.source === "pre-eval"));

	/** Newest visible entry — the compact collapsed strip previews this. */
	let latestEntry = $derived(filteredEntries[filteredEntries.length - 1] ?? null);

	/** True briefly after a successful copy of the visible entries. */
	let copied = $state(false);
	let copyResetTimer: ReturnType<typeof setTimeout> | undefined;

	// Track the run lifecycle: expand when a run starts (the first time
	// `live` flips true), and collapse when the run ends so the compact
	// collapsed strip (latest entry + progress) is shown again. A manual
	// collapse mid-run is respected — the effect only reacts to `live`
	// transitions, not to the current value. `wasLive` starts false so a
	// panel that mounts mid-run (already live) still auto-opens on the
	// first effect run.
	let wasLive = $state(false);
	$effect(() => {
		if (live !== wasLive) {
			open = live;
			wasLive = live;
		}
	});

	// Follow the tail while live: keep the newest lines in view, but only
	// when the user is already at the bottom — never yank the scroll position
	// out from under someone reading history. The method is optional-chained
	// so non-browser environments (jsdom) don't crash.
	$effect(() => {
		if (!open || !live || !stickToTail || filteredEntries.length === 0) return;
		scrollRef?.scrollTo?.({ top: scrollRef.scrollHeight });
	});

	function handleLinesScroll(): void {
		const el = scrollRef;
		if (!el) return;
		stickToTail = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
	}

	function jumpToLatest(): void {
		stickToTail = true;
		scrollRef?.scrollTo?.({ top: scrollRef.scrollHeight });
	}

	function toggleRow(key: string): void {
		expandedKey = expandedKey === key ? null : key;
	}

	/** Stable per-entry key that keeps executor and pre-eval ids apart. */
	function rowKey(entry: ExecutorLogEntry): string {
		return entry.source === "pre-eval" ? `pre-eval:${entry.id}` : `exec:${entry.id}`;
	}

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

	/** Copy the visible entries as one plain-text line per entry. */
	function copyVisibleLog(): void {
		const lines = filteredEntries.map(
			(e) =>
				`[${formatTime(e.ts)}] [${e.source === "pre-eval" ? "PRE-EVAL" : "EXEC"}] [${e.level}] ${
					e.message
				}`,
		);
		const text = lines.join("\n");
		try {
			if (navigator.clipboard?.writeText) {
				void navigator.clipboard.writeText(text).then(flashCopied, () => {
					// Clipboard rejected — leave the button in its default state.
				});
			} else {
				// Non-secure context / jsdom: legacy textarea copy fallback.
				const ta = document.createElement("textarea");
				ta.value = text;
				ta.style.position = "fixed";
				ta.style.opacity = "0";
				document.body.appendChild(ta);
				ta.select();
				document.execCommand?.("copy");
				ta.remove();
				flashCopied();
			}
		} catch {
			// Copy failed — keep the button in its default state.
		}
	}

	function flashCopied(): void {
		copied = true;
		if (copyResetTimer) clearTimeout(copyResetTimer);
		copyResetTimer = setTimeout(() => (copied = false), 1500);
	}

	function escapeHtml(value: string): string {
		return value
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;");
	}

	/**
	 * Minimal JSON tokenizer for the syntax-highlighted pre-eval summary.
	 * Token colors come from design tokens only (see .tok-* rules below);
	 * every literal is escaped before emission so {@html} never injects raw
	 * log content.
	 */
	const JSON_TOKEN =
		/("(?:[^"\\]|\\.)*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([{}[\],:])/g;

	function highlightJson(source: string): string {
		let out = "";
		let last = 0;
		for (const m of source.matchAll(JSON_TOKEN)) {
			out += escapeHtml(source.slice(last, m.index));
			const [full, str, colon, lit, num, punct] = m;
			if (str) {
				out += `<span class="tok-str">${escapeHtml(str)}</span>`;
				if (colon) out += `<span class="tok-punct">${escapeHtml(colon)}</span>`;
			} else if (lit) {
				out += `<span class="tok-lit">${escapeHtml(lit)}</span>`;
			} else if (num) {
				out += `<span class="tok-num">${escapeHtml(num)}</span>`;
			} else if (punct) {
				out += `<span class="tok-punct">${escapeHtml(punct)}</span>`;
			}
			last = m.index + full.length;
		}
		out += escapeHtml(source.slice(last));
		return out;
	}

	/** Compact JSON summary of one pre-eval row (expanded detail block). */
	function preEvalSummaryJson(entry: ExecutorLogEntry): string {
		return JSON.stringify(
			{
				submission: entry.submissionId,
				ok: entry.ok,
				grades: entry.grades ?? {},
				markers: entry.markerCount ?? 0,
				rubricSelections: entry.rubricSelections ?? [],
			},
			null,
			2,
		);
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
			<span class="pipeline-log-live" aria-live="polite" aria-label="Live updates active">
				<Radio size={11} />
				Live
			</span>
		{:else if summary}
			<span class="pipeline-log-summary">{summary}</span>
		{/if}
		<span class="pipeline-log-count">{filteredEntries.length}</span>
		{#if open}
			<ChevronUp size={14} />
		{:else}
			<ChevronDown size={14} />
		{/if}
	</button>

	{#if !open && latestEntry && !error}
		<!-- Compact collapsed mode: latest entry + run progress in one line. -->
		<button
			class="pipeline-log-compact"
			type="button"
			onclick={() => (open = true)}
			aria-label="Show latest log entry"
		>
			<span class="compact-dot {levelClass(latestEntry.level)}" aria-hidden="true"></span>
			<span class="compact-source"
				>{latestEntry.source === "pre-eval" ? "PRE-EVAL" : "EXEC"}</span
			>
			<span class="compact-message">{latestEntry.message}</span>
			{#if live && progress && progress.total > 0}
				<span class="compact-progress">
					{progress.done}/{progress.total}
				</span>
			{/if}
			<ChevronDown size={12} />
		</button>
	{/if}

	{#if open}
		<div class="pipeline-log-body">
			{#if preEvalSummary && !live}
				<div
					class="pipeline-log-banner"
					class:pipeline-log-banner-failed={preEvalSummary.failed > 0}
					role="status"
				>
					<Sparkles size={13} />
					<span class="pipeline-log-banner-text">
						{`Pre-evaluation complete — ${preEvalSummary.succeeded}/${preEvalSummary.submitted} succeeded${
							preEvalSummary.failed > 0 ? `, ${preEvalSummary.failed} failed` : ""
						}`}
					</span>
				</div>
			{/if}
			<div class="pipeline-log-toolbar">
				<span class="pipeline-log-hint">
					Captured from the executor (preprocessing, execution, autofix, LLM) and
					pre-evaluation.
				</span>
				<div class="pipeline-log-tools">
					<div class="log-search">
						<span class="log-search-icon" aria-hidden="true">
							<Search size={12} />
						</span>
						<input
							class="log-search-input"
							type="text"
							placeholder="Filter messages…"
							aria-label="Filter log messages"
							bind:value={searchQuery}
						/>
						{#if searchQuery}
							<button
								class="log-search-clear"
								type="button"
								aria-label="Clear log search"
								title="Clear the message filter"
								onclick={() => (searchQuery = "")}
							>
								<X size={11} />
							</button>
						{/if}
						{#if searchQuery}
							<span class="log-search-count">
								{filteredEntries.length} match{filteredEntries.length === 1
									? ""
									: "es"}
							</span>
						{/if}
					</div>
					{#if hasPreEval}
						<div
							class="pipeline-log-filter"
							role="radiogroup"
							aria-label="Log source filter"
						>
							<ListFilter size={12} />
							<button
								class="pipeline-log-filter-opt"
								class:pipeline-log-filter-active={sourceFilter === "all"}
								type="button"
								role="radio"
								aria-checked={sourceFilter === "all"}
								onclick={() => (sourceFilter = "all")}
								title="Show executor and pre-evaluation entries"
							>
								All
							</button>
							<button
								class="pipeline-log-filter-opt"
								class:pipeline-log-filter-active={sourceFilter === "executor"}
								type="button"
								role="radio"
								aria-checked={sourceFilter === "executor"}
								onclick={() => (sourceFilter = "executor")}
								title="Show executor entries only"
							>
								Executor
							</button>
							<button
								class="pipeline-log-filter-opt"
								class:pipeline-log-filter-active={sourceFilter === "pre-eval"}
								type="button"
								role="radio"
								aria-checked={sourceFilter === "pre-eval"}
								onclick={() => (sourceFilter = "pre-eval")}
								title="Show pre-evaluation entries only"
							>
								Pre-eval
							</button>
						</div>
					{/if}
					<button
						class="pipeline-log-tool"
						type="button"
						onclick={copyVisibleLog}
						disabled={filteredEntries.length === 0}
						title="Copy the visible entries as plain text"
					>
						<span class="pipeline-log-tool-icon">
							{#if copied}
								<Check size={12} />
							{:else}
								<Copy size={12} />
							{/if}
						</span>
						{copied ? "Copied" : "Copy"}
					</button>
					<button
						class="pipeline-log-tool"
						type="button"
						onclick={onRefresh}
						disabled={loading}
						title="Refresh logs"
					>
						<span class="pipeline-log-tool-icon" class:pipeline-log-spin={loading}>
							<RefreshCw size={12} />
						</span>
						Refresh
					</button>
				</div>
			</div>
			{#if error}
				<div class="pipeline-log-error">Logs unavailable: {error}</div>
			{:else if filteredEntries.length === 0}
				<div class="pipeline-log-empty">
					{#if searchQuery}
						No entries match “{searchQuery}”.
					{:else}
						No pipeline activity captured yet. Start a batch or a pre-evaluation to see
						logs here.
					{/if}
				</div>
			{:else}
				<div class="pipeline-log-lines" bind:this={scrollRef} onscroll={handleLinesScroll}>
					{#each filteredEntries as entry (rowKey(entry))}
						<div
							class="pipeline-log-row {levelClass(entry.level)}"
							class:row-pre-eval={entry.source === "pre-eval"}
							class:row-expanded={expandedKey === rowKey(entry)}
						>
							<button
								class="pipeline-log-line"
								type="button"
								aria-expanded={expandedKey === rowKey(entry)}
								onclick={() => toggleRow(rowKey(entry))}
							>
								<span class="log-time">{formatTime(entry.ts)}</span>
								<span
									class="log-source"
									class:log-source-pre={entry.source === "pre-eval"}
								>
									{entry.source === "pre-eval" ? "PRE-EVAL" : "EXEC"}
								</span>
								<span class="log-level">{entry.level}</span>
								<span class="log-message">{entry.message}</span>
								<span
									class="row-caret"
									class:row-caret-open={expandedKey === rowKey(entry)}
									aria-hidden="true"
								>
									<ChevronRight size={12} />
								</span>
							</button>
							{#if expandedKey === rowKey(entry)}
								<div class="pipeline-log-detail">
									{#if entry.source === "pre-eval"}
										<div class="log-detail-head">
											{#if entry.submissionId}
												<span class="log-detail-chip log-detail-id"
													>{entry.submissionId}</span
												>
											{/if}
											{#if entry.ok === false}
												<span class="log-detail-chip log-detail-fail">
													<XCircle size={11} />
													failed
												</span>
											{:else}
												<span class="log-detail-chip log-detail-ok">
													<CheckCircle2 size={11} />
													ok
												</span>
											{/if}
											<span
												class="log-detail-chip"
												title="Cell comparison markers"
											>
												markers: {entry.markerCount ?? 0}
											</span>
											<span
												class="log-detail-chip"
												title="Rubric sub-point selections"
											>
												selections: {entry.selectionCount ?? 0}
											</span>
										</div>
										{#if entry.grades && Object.keys(entry.grades).length > 0}
											<div class="log-detail-section">
												<span class="log-detail-label">Suggested grade</span
												>
												<div class="log-dim-grid">
													{#each Object.entries(entry.grades) as [dimension, value] (dimension)}
														<span class="log-dim-key">{dimension}</span>
														<span class="log-dim-value">{value}</span>
													{/each}
												</div>
											</div>
										{/if}
										{#if entry.rubricSelections && entry.rubricSelections.length > 0}
											<div class="log-detail-section">
												<span class="log-detail-label"
													>Rubric selections</span
												>
												<ul class="log-rubric-list">
													{#each entry.rubricSelections as sel (sel.categoryKey + sel.optionKey)}
														<li>
															<span class="log-rubric-cat"
																>{sel.categoryKey}</span
															>
															<span class="log-rubric-opt"
																>{sel.optionKey}</span
															>
														</li>
													{/each}
												</ul>
											</div>
										{/if}
										<div class="log-detail-section">
											<span class="log-detail-label"
												>Pre-evaluation summary</span
											>
											<pre class="log-json">{@html highlightJson(
													preEvalSummaryJson(entry),
												)}</pre>
										</div>
									{:else}
										<div class="log-detail-meta">
											<span class="log-detail-logger"
												>logger: {entry.logger}</span
											>
										</div>
										<div class="log-detail-message">{entry.message}</div>
									{/if}
								</div>
							{/if}
						</div>
					{/each}
					{#if live && !stickToTail}
						<button class="log-jump" type="button" onclick={jumpToLatest}>
							<ArrowDownToLine size={12} />
							Latest
						</button>
					{/if}
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
	/* ── Compact collapsed strip ── */
	.pipeline-log-compact {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		padding: 5px 14px 8px;
		background: transparent;
		border: none;
		border-top: 1px solid var(--border);
		cursor: pointer;
		font: inherit;
		color: var(--fg);
	}
	.pipeline-log-compact:hover {
		background: color-mix(in oklch, var(--accent) 6%, transparent);
	}
	.compact-dot {
		flex-shrink: 0;
		width: 7px;
		height: 7px;
		border-radius: 999px;
	}
	.compact-dot.log-error {
		background: var(--destructive);
	}
	.compact-dot.log-warning {
		background: var(--warning);
	}
	.compact-dot.log-debug {
		background: var(--muted-foreground);
	}
	.compact-dot.log-info {
		background: var(--success);
	}
	.compact-source {
		flex-shrink: 0;
		font-family: var(--font-mono);
		font-size: 9px;
		font-weight: 700;
		letter-spacing: 0.05em;
		color: var(--muted-foreground);
	}
	.compact-message {
		flex: 1;
		min-width: 0;
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--muted-foreground);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.compact-progress {
		flex-shrink: 0;
		font-size: 11px;
		font-weight: 600;
		color: var(--primary);
		font-variant-numeric: tabular-nums;
	}
	.pipeline-log-body {
		border-top: 1px solid var(--border);
	}
	.pipeline-log-banner {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 7px 14px;
		font-size: 12px;
		font-weight: 600;
		color: var(--success);
		background: color-mix(in oklch, var(--success) 10%, transparent);
		border-bottom: 1px solid color-mix(in oklch, var(--success) 25%, transparent);
	}
	.pipeline-log-banner-failed {
		color: var(--destructive);
		background: color-mix(in oklch, var(--destructive) 10%, transparent);
		border-bottom-color: color-mix(in oklch, var(--destructive) 25%, transparent);
	}
	.pipeline-log-toolbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		flex-wrap: wrap;
		padding: 6px 14px;
		background: var(--muted-bg);
	}
	.pipeline-log-hint {
		font-size: 11px;
		color: var(--muted-foreground);
	}
	.pipeline-log-tools {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}
	/* ── Message search ── */
	.log-search {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 2px 8px;
		border: 1px solid var(--border);
		border-radius: 999px;
		background: var(--card);
	}
	.log-search-icon {
		display: inline-flex;
		align-items: center;
		color: var(--muted-foreground);
	}
	.log-search-input {
		width: 150px;
		border: none;
		background: transparent;
		outline: none;
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--fg);
	}
	.log-search-input:focus-visible {
		outline: 2px solid var(--ring);
		outline-offset: 2px;
		border-radius: 4px;
	}
	.log-search-input::placeholder {
		color: var(--muted-foreground);
	}
	.log-search-clear {
		display: inline-flex;
		align-items: center;
		padding: 0;
		border: none;
		background: transparent;
		color: var(--muted-foreground);
		cursor: pointer;
	}
	.log-search-clear:hover {
		color: var(--fg);
	}
	.log-search-count {
		font-size: 10px;
		color: var(--muted-foreground);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}
	/* ── Source filter (pill segmented control) ── */
	.pipeline-log-filter {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-size: 11px;
		color: var(--muted-foreground);
	}
	.pipeline-log-filter-opt {
		font-size: 11px;
		font-weight: 500;
		color: var(--muted-foreground);
		background: transparent;
		border: 1px solid var(--border);
		border-radius: 999px;
		padding: 2px 9px;
		cursor: pointer;
	}
	.pipeline-log-filter-opt:hover {
		color: var(--fg);
	}
	.pipeline-log-filter-active {
		color: var(--primary-foreground);
		background: var(--primary);
		border-color: var(--primary);
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
	.pipeline-log-tool-icon {
		display: inline-flex;
	}
	.pipeline-log-spin {
		animation: pipeline-log-spin 0.9s linear infinite;
	}
	@keyframes pipeline-log-spin {
		to {
			transform: rotate(360deg);
		}
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
	/* ── Log lines (terminal grid: time | source | level | message | caret) ── */
	.pipeline-log-lines {
		position: relative;
		max-height: 260px;
		overflow-y: auto;
		padding: 6px 0;
		font-family: "JetBrains Mono", "Fira Code", "Cascadia Code", monospace;
		font-size: 12px;
		line-height: 1.55;
	}
	.pipeline-log-row {
		border-left: 2px solid transparent;
	}
	.pipeline-log-row.row-pre-eval {
		border-left-color: color-mix(in oklch, var(--primary) 40%, transparent);
	}
	.pipeline-log-row.row-expanded {
		background: color-mix(in oklch, var(--accent) 7%, transparent);
	}
	/* Level tinting (row background + inherited text color). */
	.pipeline-log-row.log-error {
		background: color-mix(in oklch, var(--destructive) 8%, transparent);
	}
	.log-error .log-level,
	.log-error .log-message {
		color: var(--destructive);
	}
	.log-warning .log-level,
	.log-warning .log-message {
		color: var(--warning);
	}
	.log-debug .log-level,
	.log-debug .log-message {
		color: var(--muted-foreground);
	}
	.pipeline-log-line {
		display: grid;
		grid-template-columns: 70px 55px 55px 1fr 20px;
		align-items: baseline;
		gap: 6px;
		width: 100%;
		padding: 1px 14px;
		background: transparent;
		border: none;
		cursor: pointer;
		font: inherit;
		text-align: left;
		color: var(--fg);
	}
	.pipeline-log-line:hover {
		background: color-mix(in oklch, var(--accent) 10%, transparent);
	}
	.log-time {
		color: var(--muted-foreground);
		font-variant-numeric: tabular-nums;
	}
	.log-source {
		font-size: 9px;
		font-weight: 700;
		letter-spacing: 0.05em;
		align-self: center;
		justify-self: start;
		color: var(--muted-foreground);
		background: color-mix(in oklch, var(--muted-foreground) 12%, transparent);
		border: 1px solid color-mix(in oklch, var(--muted-foreground) 22%, transparent);
		border-radius: 4px;
		padding: 0 4px;
		line-height: 1.4;
	}
	.log-source-pre {
		color: var(--primary);
		background: color-mix(in oklch, var(--accent) 14%, transparent);
		border-color: color-mix(in oklch, var(--accent) 30%, transparent);
	}
	.log-level {
		text-transform: uppercase;
		font-size: 10px;
		letter-spacing: 0.04em;
		color: var(--muted-foreground);
	}
	.log-message {
		min-width: 0;
		color: var(--fg);
		white-space: pre-wrap;
		word-break: break-word;
	}
	.row-caret {
		align-self: center;
		display: inline-flex;
		color: var(--muted-foreground);
		transition: transform 0.15s ease;
	}
	.row-caret-open {
		transform: rotate(90deg);
		color: var(--primary);
	}
	/* ── Expanded per-row detail (card surface) ── */
	.pipeline-log-detail {
		margin: 2px 10px 6px;
		padding: 8px 10px;
		background: var(--card);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		font-size: 11px;
		color: var(--muted-foreground);
	}
	.log-detail-meta {
		margin-bottom: 4px;
	}
	.log-detail-logger {
		font-family: var(--font-mono, ui-monospace, "SF Mono", Menlo, Consolas, monospace);
		color: var(--muted-foreground);
	}
	.log-detail-message {
		font-family: var(--font-mono, ui-monospace, "SF Mono", Menlo, Consolas, monospace);
		white-space: pre-wrap;
		word-break: break-word;
		color: var(--fg);
	}
	.log-detail-head {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 10px;
		padding-bottom: 4px;
	}
	.log-detail-chip {
		display: inline-flex;
		align-items: center;
		gap: 3px;
	}
	.log-detail-id {
		font-family: var(--font-mono, ui-monospace, "SF Mono", Menlo, Consolas, monospace);
		color: var(--primary);
	}
	.log-detail-ok {
		color: var(--success);
	}
	.log-detail-fail {
		color: var(--destructive);
	}
	.log-detail-section {
		border-top: 1px dashed var(--border);
		padding: 6px 0 2px;
	}
	.log-detail-label {
		display: block;
		font-size: 10px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--muted-foreground);
		margin-bottom: 4px;
	}
	.log-dim-grid {
		display: grid;
		grid-template-columns: 1fr auto;
		gap: 2px 16px;
		font-family: var(--font-mono, ui-monospace, "SF Mono", Menlo, Consolas, monospace);
	}
	.log-dim-key {
		color: var(--fg);
		word-break: break-word;
	}
	.log-dim-value {
		color: var(--primary);
		font-variant-numeric: tabular-nums;
	}
	.log-rubric-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
		font-family: var(--font-mono, ui-monospace, "SF Mono", Menlo, Consolas, monospace);
	}
	.log-rubric-cat {
		color: var(--fg);
	}
	.log-rubric-cat::after {
		content: " → ";
		color: var(--muted-foreground);
	}
	.log-rubric-opt {
		color: var(--primary);
	}
	.log-json {
		margin: 0;
		padding: 8px 10px;
		background: color-mix(in oklch, var(--muted) 55%, transparent);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		overflow-x: auto;
		font-family: var(--font-mono, ui-monospace, "SF Mono", Menlo, Consolas, monospace);
		font-size: 11px;
		line-height: 1.5;
		color: var(--fg);
	}
	.tok-str {
		color: var(--success);
	}
	.tok-num {
		color: var(--info);
	}
	.tok-lit {
		color: var(--warning);
	}
	.tok-punct {
		color: var(--muted-foreground);
	}
	/* ── Jump-to-latest affordance (live, user scrolled up) ── */
	.log-jump {
		position: sticky;
		bottom: 8px;
		left: 50%;
		transform: translateX(-50%);
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-size: 11px;
		font-weight: 600;
		color: var(--primary-foreground);
		background: var(--primary);
		border: none;
		border-radius: 999px;
		padding: 4px 10px;
		cursor: pointer;
		box-shadow: 0 2px 8px color-mix(in oklch, var(--foreground) 25%, transparent);
	}
	.log-jump:hover {
		background: color-mix(in oklch, var(--primary) 85%, var(--foreground));
	}
</style>
