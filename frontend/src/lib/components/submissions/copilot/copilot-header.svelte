<script lang="ts">
	import Sparkles from "@lucide/svelte/icons/sparkles";
	import ShieldCheck from "@lucide/svelte/icons/shield-check";
	import ShieldAlert from "@lucide/svelte/icons/shield-alert";
	import SquarePen from "@lucide/svelte/icons/square-pen";
	import Trash2 from "@lucide/svelte/icons/trash-2";
	import History from "@lucide/svelte/icons/history";
	import ChevronDown from "@lucide/svelte/icons/chevron-down";
	import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
	import type { CopilotThreadMeta } from "../copilot-store.svelte.js";
	import type { CopilotMode } from "$lib/services/settings-api.js";

	type Props = {
		/** The active thread, if any (drives the selector + context meter). */
		activeThread: CopilotThreadMeta | null;
		/** Copilot approval mode (ask / auto-approve-all). */
		copilotMode: CopilotMode;
		/** Teacher-mode gate for the mode toggle (apiMode). */
		showModeToggle: boolean;
		/** True while the thread sidebar is open (toggle button active state). */
		sidebarOpen: boolean;
		/** Disables destructive/thread actions while the agent runs. */
		isStreaming: boolean;
		loadingHistory: boolean;
		/** Flip between ask and auto-approve-all (persists via settings API). */
		onToggleMode: () => void;
		/** Start a brand-new conversation. */
		onNewConversation: () => void;
		/** Open/close the thread sidebar. */
		onToggleSidebar: () => void;
		/** Delete the ACTIVE thread (called after the two-step confirm commits). */
		onDeleteActiveThread: () => void;
	};

	let {
		activeThread,
		copilotMode,
		showModeToggle,
		sidebarOpen,
		isStreaming,
		loadingHistory,
		onToggleMode,
		onNewConversation,
		onToggleSidebar,
		onDeleteActiveThread,
	}: Props = $props();

	// -----------------------------------------------------------------------
	// Context meter (Task 5.3)
	// -----------------------------------------------------------------------

	/** Filled width: how full the recall window is (recallCovered / lastMessages). */
	let fillPct = $derived(
		activeThread && activeThread.recallLimit > 0
			? Math.min(
					100,
					Math.round((activeThread.recallCovered / activeThread.recallLimit) * 100),
				)
			: 0,
	);
	/** Green < 60%, amber 60–85%, red > 85%. */
	let barColor = $derived(
		fillPct < 60 ? "var(--success)" : fillPct <= 85 ? "var(--warning)" : "var(--destructive)",
	);

	// -----------------------------------------------------------------------
	// Two-step delete of the ACTIVE thread (header Trash2)
	// -----------------------------------------------------------------------

	let deleteArmed = $state(false);
	let deleteTimer: ReturnType<typeof setTimeout> | undefined;
	let deleteBtnEl = $state<HTMLButtonElement | undefined>();

	function handleDeleteClick(): void {
		if (!activeThread || isStreaming) return;
		if (deleteArmed) {
			clearDeleteArm();
			onDeleteActiveThread();
			return;
		}
		deleteArmed = true;
		if (deleteTimer) clearTimeout(deleteTimer);
		deleteTimer = setTimeout(clearDeleteArm, 4000);
	}

	function clearDeleteArm(): void {
		deleteArmed = false;
		if (deleteTimer) {
			clearTimeout(deleteTimer);
			deleteTimer = undefined;
		}
	}

	// Auto-disarm on any click outside the delete button; also when the
	// active thread changes (a stale arm must never delete a new thread).
	$effect(() => {
		if (!deleteArmed) return;
		const onPointerDown = (e: PointerEvent) => {
			if (deleteBtnEl && e.target instanceof Node && !deleteBtnEl.contains(e.target)) {
				clearDeleteArm();
			}
		};
		document.addEventListener("pointerdown", onPointerDown, true);
		return () => document.removeEventListener("pointerdown", onPointerDown, true);
	});

	$effect(() => {
		// Re-run when the active thread changes so a stale arm can never
		// delete a NEW thread.
		void activeThread?.id;
		clearDeleteArm();
	});
</script>

<div class="copilot-header">
	<Sparkles size={14} class="copilot-icon" />
	<span>AI Copilot</span>
	{#if activeThread}
		<button
			type="button"
			class="thread-selector"
			class:thread-selector-active={sidebarOpen}
			title={activeThread.title}
			aria-label="Select conversation"
			aria-expanded={sidebarOpen}
			onclick={onToggleSidebar}
		>
			<span class="active-thread-title">{activeThread.title}</span>
			<span class="chevron-wrap"><ChevronDown size={12} /></span>
		</button>
	{/if}
	<div class="header-spacer"></div>
	{#if showModeToggle}
		<button
			type="button"
			class="header-btn"
			class:header-btn-active={copilotMode === "auto-approve-all"}
			aria-label={copilotMode === "auto-approve-all"
				? "Auto-approve all tool calls"
				: "Ask before running tools"}
			title={copilotMode === "auto-approve-all"
				? "Auto-approve all tool calls"
				: "Ask before running tools"}
			onclick={onToggleMode}
		>
			{#if copilotMode === "auto-approve-all"}
				<ShieldCheck size={13} />
			{:else}
				<ShieldAlert size={13} />
			{/if}
		</button>
	{/if}
	<button
		type="button"
		class="header-btn"
		aria-label="New conversation"
		title="New conversation"
		disabled={isStreaming || loadingHistory}
		onclick={onNewConversation}
	>
		<SquarePen size={13} />
	</button>
	<button
		type="button"
		class="header-btn"
		class:header-btn-active={deleteArmed}
		class:delete-armed={deleteArmed}
		aria-label="Delete current conversation"
		title={deleteArmed ? "Delete?" : "Delete conversation"}
		disabled={!activeThread || isStreaming}
		onclick={handleDeleteClick}
		bind:this={deleteBtnEl}
	>
		{#if deleteArmed}
			<span class="delete-label">Delete?</span>
		{/if}
		<Trash2 size={13} />
	</button>
	<button
		type="button"
		class="header-btn"
		class:header-btn-active={sidebarOpen}
		aria-label="Conversation history"
		aria-expanded={sidebarOpen}
		title="Conversation history"
		onclick={onToggleSidebar}
	>
		<History size={13} />
	</button>
</div>

{#if activeThread}
	{@const thread = activeThread}
	<div
		class="context-meter"
		title={`Recall window: last ${thread.recallLimit} messages`}
		aria-label={`Context meter: ${thread.recallCovered} of ${thread.messageCount} messages`}
	>
		<div class="context-meter-track">
			<div
				class="context-meter-fill"
				style:width={`${fillPct}%`}
				style:background={barColor}
			></div>
		</div>
		<div class="context-line">
			Context: last {thread.recallCovered} of {thread.messageCount} messages - est. ~{thread.estimatedTokens}
			tokens{#if thread.compactionCount > 0}
				- compacted {thread.compactionCount}×{/if}
		</div>
	</div>
	{#if thread.droppedCount > 0}
		<div class="context-warning">
			<TriangleAlert size={11} />
			<span>
				{#if thread.hasSummary}
					Oldest {thread.droppedCount} message(s) are summarized into context — start a new
					conversation for full fidelity.
				{:else}
					Oldest {thread.droppedCount} message(s) are outside the model's context — start a
					new conversation for full context.
				{/if}
			</span>
		</div>
	{/if}
{/if}

<style>
	.copilot-header {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 10px 12px;
		border-bottom: 1px solid var(--border);
		font-size: 13px;
		font-weight: 600;
		background: var(--muted);
	}

	.header-spacer {
		flex: 1;
	}

	.thread-selector {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		min-width: 0;
		max-width: 160px;
		padding: 2px 6px;
		border: 1px solid transparent;
		border-radius: var(--radius);
		background: none;
		color: var(--foreground);
		cursor: pointer;
		font-size: 11px;
		font-weight: 500;
	}
	.thread-selector:hover,
	.thread-selector-active {
		border-color: var(--border);
		background: var(--card);
	}
	.active-thread-title {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.chevron-wrap {
		display: inline-flex;
		flex-shrink: 0;
		color: var(--muted-foreground);
	}

	.header-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 4px;
		width: 26px;
		height: 26px;
		border-radius: var(--radius);
		border: 1px solid transparent;
		background: none;
		color: var(--muted-foreground);
		cursor: pointer;
		flex-shrink: 0;
		padding: 0;
	}
	.header-btn:hover:not(:disabled) {
		color: var(--foreground);
		background: var(--card);
	}
	.header-btn:disabled {
		opacity: 0.4;
		cursor: default;
	}
	.header-btn-active {
		color: var(--primary);
		border-color: var(--border);
		background: var(--card);
	}
	.delete-armed {
		color: var(--destructive);
		border-color: color-mix(in oklch, var(--destructive) 45%, var(--border));
		background: color-mix(in oklch, var(--destructive) 8%, transparent);
	}
	.delete-label {
		font-size: 9px;
		font-weight: 700;
	}

	/* Context window visibility (Task U.4 + Issue 11 meter bar). */
	.context-meter {
		padding: 6px 12px;
		border-bottom: 1px solid var(--border);
		background: var(--card);
	}
	.context-meter-track {
		height: 4px;
		border-radius: 999px;
		background: var(--muted);
		overflow: hidden;
	}
	.context-meter-fill {
		height: 100%;
		border-radius: 999px;
		transition: width 0.2s;
	}
	.context-line {
		font-size: 11px;
		color: var(--muted-foreground);
		padding-top: 4px;
	}
	.context-warning {
		display: flex;
		align-items: flex-start;
		gap: 6px;
		font-size: 11px;
		line-height: 1.4;
		color: var(--destructive);
		padding: 6px 12px;
		border-bottom: 1px solid color-mix(in oklch, var(--destructive) 30%, var(--border));
		background: color-mix(in oklch, var(--destructive) 6%, var(--card));
	}
</style>
