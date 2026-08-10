<script lang="ts">
	import SquarePen from "@lucide/svelte/icons/square-pen";
	import Pencil from "@lucide/svelte/icons/pencil";
	import Trash2 from "@lucide/svelte/icons/trash-2";
	import MessageSquare from "@lucide/svelte/icons/message-square";
	import type { CopilotThreadMeta } from "../copilot-store.svelte.js";

	type Props = {
		/** All threads for the current scope (submission or assignment). */
		threads: CopilotThreadMeta[];
		/** Id of the currently active thread (highlighted row), if any. */
		activeThreadId: string | undefined;
		/** Switch to a thread (the parent closes the sidebar after opening). */
		onOpen: (threadId: string) => void;
		/** Start a brand-new conversation. */
		onNew: () => void;
		/** Rename a thread (title already trimmed by the caller). */
		onRename: (threadId: string, title: string) => void;
		/** Delete a thread (called after the two-step arm commits). */
		onDelete: (threadId: string) => void;
	};

	let { threads, activeThreadId, onOpen, onNew, onRename, onDelete }: Props = $props();

	/** Thread id whose row title is being edited inline. */
	let editingThreadId = $state<string | null>(null);
	let renameDraft = $state("");
	/** Thread id armed for two-step delete ("Delete?" state). */
	let armedThreadId = $state<string | null>(null);
	let disarmTimer: ReturnType<typeof setTimeout> | undefined;
	let threadListEl = $state<HTMLDivElement | undefined>();

	/** Arm (first click) or commit (second click) a two-step delete. */
	function handleDeleteClick(threadId: string): void {
		if (armedThreadId === threadId) {
			// Second click on the SAME row — commit.
			clearArmed();
			onDelete(threadId);
			return;
		}
		clearArmed();
		armedThreadId = threadId;
		if (disarmTimer) clearTimeout(disarmTimer);
		disarmTimer = setTimeout(clearArmed, 4000);
	}

	function clearArmed(): void {
		armedThreadId = null;
		if (disarmTimer) {
			clearTimeout(disarmTimer);
			disarmTimer = undefined;
		}
	}

	// Auto-disarm on any click OUTSIDE the thread list (clicks inside the
	// list — other rows, the actions — keep the arm; the row/action handlers
	// manage it themselves).
	$effect(() => {
		if (!armedThreadId) return;
		const onPointerDown = (e: PointerEvent) => {
			if (threadListEl && e.target instanceof Node && !threadListEl.contains(e.target)) {
				clearArmed();
			}
		};
		document.addEventListener("pointerdown", onPointerDown, true);
		return () => document.removeEventListener("pointerdown", onPointerDown, true);
	});

	function startRename(thread: CopilotThreadMeta): void {
		editingThreadId = thread.id;
		renameDraft = thread.title;
	}

	function commitRename(threadId: string): void {
		const trimmed = renameDraft.trim();
		if (trimmed) onRename(threadId, trimmed);
		editingThreadId = null;
	}

	function cancelRename(): void {
		editingThreadId = null;
	}

	function handleRenameKeydown(threadId: string, e: KeyboardEvent): void {
		if (e.key === "Enter") {
			e.preventDefault();
			commitRename(threadId);
		} else if (e.key === "Escape") {
			e.preventDefault();
			cancelRename();
		}
	}

	/** Blur commits like Enter — but not after Escape already cancelled. */
	function handleRenameBlur(threadId: string): void {
		if (editingThreadId !== threadId) return;
		commitRename(threadId);
	}

	function handleRenameInput(e: Event): void {
		renameDraft = (e.target as HTMLInputElement).value;
	}

	function openThreadRow(threadId: string): void {
		clearArmed();
		onOpen(threadId);
	}

	/** Keyboard activation for the clickable thread row (a11y). */
	function handleRowKeydown(threadId: string, e: KeyboardEvent): void {
		if (e.key === "Enter" || e.key === " ") {
			e.preventDefault();
			openThreadRow(threadId);
		}
	}

	/** Absolute time, matching the message bubbles' .msg-time format. */
	function threadTime(iso: string): string {
		return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	}
</script>

<div class="thread-list" bind:this={threadListEl}>
	<button type="button" class="new-conv-row" onclick={onNew}>
		<SquarePen size={13} />
		<span>New conversation</span>
	</button>
	{#if threads.length === 0}
		<p class="thread-empty">No conversations yet</p>
	{:else}
		{#each threads as t (t.id)}
			<div
				class="thread-row"
				class:thread-row-active={t.id === activeThreadId}
				class:thread-row-armed={armedThreadId === t.id}
				role="button"
				tabindex="0"
				onclick={() => openThreadRow(t.id)}
				onkeydown={(e) => handleRowKeydown(t.id, e)}
			>
				{#if editingThreadId === t.id}
					<input
						type="text"
						class="rename-input"
						value={renameDraft}
						oninput={handleRenameInput}
						onkeydown={(e) => handleRenameKeydown(t.id, e)}
						onblur={() => handleRenameBlur(t.id)}
						aria-label={`Rename ${t.title}`}
					/>
				{:else}
					<div class="thread-row-main">
						<span class="thread-title" title={t.title}>{t.title}</span>
						<span class="thread-time">{threadTime(t.updatedAt)}</span>
					</div>
					<div class="thread-count" title={`${t.messageCount} messages`}>
						<MessageSquare size={10} />
						<span>{t.messageCount}</span>
					</div>
				{/if}
				<div class="thread-actions">
					{#if editingThreadId !== t.id}
						<button
							type="button"
							class="row-btn"
							aria-label={`Rename ${t.title}`}
							title="Rename"
							onclick={(e) => {
								e.stopPropagation();
								startRename(t);
							}}
						>
							<Pencil size={12} />
						</button>
						<button
							type="button"
							class="row-btn"
							class:row-btn-armed={armedThreadId === t.id}
							aria-label={`Delete ${t.title}`}
							title={armedThreadId === t.id ? "Delete?" : "Delete"}
							onclick={(e) => {
								e.stopPropagation();
								handleDeleteClick(t.id);
							}}
						>
							{#if armedThreadId === t.id}
								<span class="delete-label">Delete?</span>
							{/if}
							<Trash2 size={12} />
						</button>
					{/if}
				</div>
			</div>
		{/each}
	{/if}
</div>

<style>
	.thread-list {
		flex: 1;
		overflow-y: auto;
		padding: 8px;
		display: flex;
		flex-direction: column;
		gap: 4px;
		background: var(--card);
	}
	.new-conv-row {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		padding: 8px 10px;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: none;
		color: var(--foreground);
		font-size: 12px;
		font-weight: 600;
		cursor: pointer;
		text-align: left;
	}
	.new-conv-row:hover {
		border-color: var(--primary);
		color: var(--primary);
	}
	.thread-empty {
		font-size: 12px;
		color: var(--muted-foreground);
		text-align: center;
		padding: 24px 8px;
		margin: 0;
	}
	.thread-row {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 7px 10px;
		border-radius: var(--radius);
		border: 1px solid transparent;
		cursor: pointer;
	}
	.thread-row:hover {
		background: var(--muted);
	}
	.thread-row-active {
		background: color-mix(in oklch, var(--primary) 10%, var(--card));
		border-color: color-mix(in oklch, var(--primary) 35%, var(--border));
	}
	.thread-row-armed {
		background: color-mix(in oklch, var(--destructive) 10%, var(--card));
		border-color: color-mix(in oklch, var(--destructive) 45%, var(--border));
	}
	.thread-row-main {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.thread-title {
		font-size: 12px;
		font-weight: 500;
		color: var(--foreground);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.thread-time {
		font-size: 10px;
		color: var(--muted-foreground);
	}
	.thread-count {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		font-size: 10px;
		color: var(--muted-foreground);
		flex-shrink: 0;
	}
	.thread-actions {
		display: inline-flex;
		align-items: center;
		gap: 2px;
		flex-shrink: 0;
	}
	.row-btn {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 4px;
		border: none;
		border-radius: var(--radius);
		background: none;
		color: var(--muted-foreground);
		cursor: pointer;
	}
	.row-btn:hover {
		color: var(--foreground);
		background: var(--muted);
	}
	.row-btn-armed {
		color: var(--destructive);
		background: color-mix(in oklch, var(--destructive) 10%, transparent);
	}
	.delete-label {
		font-size: 10px;
		font-weight: 700;
	}
	.rename-input {
		flex: 1;
		min-width: 0;
		padding: 4px 8px;
		font-size: 12px;
		color: var(--foreground);
		background: var(--card);
		border: 1px solid var(--input);
		border-radius: var(--radius);
		outline: none;
	}
	.rename-input:focus {
		border-color: var(--ring);
		box-shadow: 0 0 0 2px color-mix(in oklch, var(--ring) 30%, transparent);
	}
</style>
