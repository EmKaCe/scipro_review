<script lang="ts">
	import { onMount } from "svelte";
	import {
		createCopilotStore,
		type CopilotMessage,
		type CopilotSuggestion,
		type CopilotThreadMeta,
	} from "./copilot-store.svelte.js";
	import Sparkles from "@lucide/svelte/icons/sparkles";
	import Send from "@lucide/svelte/icons/send";
	import Wrench from "@lucide/svelte/icons/wrench";
	import CircleCheck from "@lucide/svelte/icons/circle-check";
	import CircleX from "@lucide/svelte/icons/circle-x";
	import ShieldAlert from "@lucide/svelte/icons/shield-alert";
	import Lock from "@lucide/svelte/icons/lock";
	import Lightbulb from "@lucide/svelte/icons/lightbulb";
	import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
	import ChevronRight from "@lucide/svelte/icons/chevron-right";
	import History from "@lucide/svelte/icons/history";
	import SquarePen from "@lucide/svelte/icons/square-pen";
	import Pencil from "@lucide/svelte/icons/pencil";
	import Trash2 from "@lucide/svelte/icons/trash-2";
	import MessageSquare from "@lucide/svelte/icons/message-square";

	interface Props {
		/**
		 * Submission the copilot operates on. Optional — when absent (and
		 * `assignmentId` is set) the copilot runs in assignment scope: the
		 * whole assignment is the context, and the empty state shows
		 * assignment prompts instead of per-submission slash commands.
		 */
		submissionId?: string;
		/**
		 * Assignment the copilot operates on (dashboard entry point). When
		 * provided without a submissionId, the store is created in
		 * assignment scope.
		 */
		assignmentId?: string;
		/**
		 * Fired when the teacher applies a pending suggestion (clicked the
		 * actionLabel button). Receives the FULL suggestion payload, including
		 * `data` — the structured apply payload emitted by the tool.
		 *
		 * Convention (4e): the repo communicates child→parent via callback
		 * props (`onXxx`) — rubric-category, upload-panel, autofix-card,
		 * right-panel-tabs (onTabChange/onSelectionsChange) — and has zero
		 * `createEventDispatcher` call sites. The panel sits inside a wrapper
		 * (right-panel-tabs) that the page wires, so the apply signal is a
		 * callback prop the wrapper forwards, matching that convention.
		 */
		onapply?: (suggestion: CopilotSuggestion) => void;
	}

	let { submissionId = "", assignmentId = "", onapply }: Props = $props();

	/** True in assignment scope: no per-submission context, assignment prompts. */
	let assignmentScope = $derived(!!assignmentId && !submissionId);

	/** Assignment-scope prompt hints (replaces the per-submission slash commands). */
	const assignmentHints = [
		"How is the class doing?",
		"Summarize pipeline status",
		"Which submissions need attention?",
	];

	/**
	 * One store per component instance — created once at mount. The previous
	 * `$derived(createCopilotStore())` built a fresh store on every reactive
	 * recomputation, discarding messages mid-stream. The scope capture is
	 * intentionally one-time (the store binds to the submission/assignment
	 * for its whole lifetime), so the state_referenced_locally hint is
	 * suppressed.
	 */
	// svelte-ignore state_referenced_locally
	const copilot = createCopilotStore(
		assignmentScope ? { assignmentId } : submissionId ? { submissionId } : undefined,
	);

	function handleSend() {
		const text = copilot.inputValue.trim();
		if (!text || copilot.isStreaming) return;
		// After the turn completes, refresh the thread list (a brand-new
		// thread appears with its derived title; existing threads re-sort by
		// updatedAt and gain their latest preview).
		void copilot.sendMessage(text).then(() => copilot.loadThreads());
		copilot.inputValue = "";
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			handleSend();
		}
	}

	let showCommands = $state(false);

	function handleInput(e: Event) {
		const input = e.target as HTMLInputElement;
		copilot.inputValue = input.value;
		showCommands = input.value === "/";
	}

	function selectCommand(cmd: string) {
		copilot.inputValue = cmd + " ";
		showCommands = false;
	}

	/** Fill the input with an assignment-scope prompt hint (no send). */
	function selectHint(hint: string) {
		copilot.inputValue = hint;
		showCommands = false;
	}

	// -----------------------------------------------------------------------
	// Thread switcher (Task T)
	// -----------------------------------------------------------------------

	let showThreads = $state(false);
	/** Thread id whose row title is being edited inline. */
	let editingThreadId = $state<string | null>(null);
	let renameDraft = $state("");
	/** Thread id armed for two-step delete ("Delete?" state). */
	let armedThreadId = $state<string | null>(null);
	let disarmTimer: ReturnType<typeof setTimeout> | undefined;
	let threadListEl = $state<HTMLDivElement | undefined>();

	onMount(() => {
		// Load the thread list and restore the conversation the teacher was
		// in (localStorage holds the active thread id per scope).
		void copilot.loadThreads();
		void copilot.restoreActiveThread();
	});

	/** Arm (first click) or commit (second click) a two-step delete. */
	function handleDeleteClick(threadId: string): void {
		if (armedThreadId === threadId) {
			// Second click on the SAME row — commit.
			clearArmed();
			void copilot.deleteThread(threadId);
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
		if (trimmed) void copilot.renameThread(threadId, trimmed);
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
		void copilot.openThread(threadId);
		showThreads = false;
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

	/** True when this approval message is the live pending request. */
	function isPendingApproval(msg: CopilotMessage): boolean {
		const pending = copilot.pendingApproval;
		return (
			pending !== null && pending.runId === msg.runId && pending.toolCallId === msg.toolCallId
		);
	}

	/** True while the suggestion is still actionable (not applied/dismissed). */
	function isPendingSuggestion(suggestion: CopilotSuggestion | undefined): boolean {
		return (
			suggestion !== undefined &&
			copilot.pendingSuggestions.some((s) => s.id === suggestion.suggestionId)
		);
	}

	/** Apply the suggestion: removes it from pending and forwards it to the page. */
	function handleApply(suggestion: CopilotSuggestion | undefined): void {
		if (!suggestion) return;
		const applied = copilot.applySuggestion(suggestion.suggestionId);
		if (applied) onapply?.(applied);
	}

	/** Dismiss the suggestion: removes it from pending without applying. */
	function handleDismiss(suggestion: CopilotSuggestion | undefined): void {
		if (!suggestion) return;
		copilot.dismissSuggestion(suggestion.suggestionId);
	}
</script>

<div class="copilot-container">
	<div class="copilot-header">
		<Sparkles size={14} class="copilot-icon" />
		<span>AI Copilot</span>
		{#if copilot.activeThread}
			<span class="active-thread-title" title={copilot.activeThread.title}>
				{copilot.activeThread.title}
			</span>
		{/if}
		<div class="header-spacer"></div>
		<button
			type="button"
			class="header-btn"
			aria-label="New conversation"
			title="New conversation"
			disabled={copilot.isStreaming || copilot.loadingHistory}
			onclick={() => copilot.newConversation()}
		>
			<SquarePen size={13} />
		</button>
		<button
			type="button"
			class="header-btn"
			class:header-btn-active={showThreads}
			aria-label="Conversation history"
			title="Conversation history"
			onclick={() => (showThreads = !showThreads)}
		>
			<History size={13} />
		</button>
	</div>

	{#if copilot.activeThread}
		<div class="context-line" title={`Recall window: last ${copilot.activeThread.recallLimit} messages`}>
			Context: last {copilot.activeThread.recallCovered} of {copilot.activeThread.messageCount} messages - est. ~{copilot.activeThread.estimatedTokens} tokens
		</div>
		{#if copilot.activeThread.droppedCount > 0}
			<div class="context-warning">
				<TriangleAlert size={11} />
				<span>
					Oldest {copilot.activeThread.droppedCount} message(s) are outside the model's context — start a new conversation for full context.
				</span>
			</div>
		{/if}
	{/if}

	{#if showThreads}
		<div class="thread-list" bind:this={threadListEl}>
			<button type="button" class="new-conv-row" onclick={() => copilot.newConversation()}>
				<SquarePen size={13} />
				<span>New conversation</span>
			</button>
			{#if copilot.threads.length === 0}
				<p class="thread-empty">No conversations yet</p>
			{:else}
				{#each copilot.threads as t (t.id)}
					<div
						class="thread-row"
						class:thread-row-active={t.id === copilot.activeThread?.id}
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
	{:else}
	<div class="copilot-messages">
		{#if copilot.messages.length === 0}
			<div class="empty-state">
				<Sparkles size={24} class="empty-icon" />
				<p class="empty-title">AI Copilot</p>
				<p class="empty-desc">
					{assignmentScope
						? "Ask questions about this assignment, or type / for commands."
						: "Ask questions about this submission, or type / for commands."}
				</p>
				<div class="command-hints">
					{#if assignmentScope}
						{#each assignmentHints as hint (hint)}
							<button class="hint-chip" onclick={() => selectHint(hint)}
								>{hint}</button
							>
						{/each}
					{:else}
						{#each copilot.availableCommands as cmd (cmd.command)}
							<button class="hint-chip" onclick={() => selectCommand(cmd.command)}>
								{cmd.command}
							</button>
						{/each}
					{/if}
				</div>
			</div>
		{:else}
			{#each copilot.messages as msg (msg.id)}
				{#if msg.kind === "tool-call"}
					<div class="copilot-card tool-call-card">
						<div class="card-header">
							<Wrench size={12} />
							<span class="card-label">Tool call</span>
							<code class="tool-name">{msg.tool}</code>
						</div>
						{#if msg.args}
							<details class="args-toggle">
								<summary class="args-summary">
									<span class="chevron-wrap"><ChevronRight size={12} /></span>
									<span>Arguments</span>
								</summary>
								<pre class="args-pre">{msg.args}</pre>
							</details>
						{/if}
					</div>
				{:else if msg.kind === "tool-result"}
					<div
						class="copilot-card tool-result-card"
						class:tool-result-ok={msg.ok === true}
						class:tool-result-err={msg.ok !== true}
					>
						{#if msg.ok === true}
							<CircleCheck size={12} />
						{:else}
							<CircleX size={12} />
						{/if}
						{#if msg.tool}
							<code class="tool-name">{msg.tool}</code>
						{/if}
						<span class="tool-result-summary">{msg.summary}</span>
					</div>
				{:else if msg.kind === "approval"}
					<div class="copilot-card approval-card">
						<div class="card-header">
							<ShieldAlert size={14} />
							<span class="card-label">Approval required</span>
						</div>
						<div class="approval-body">
							<code class="tool-name">{msg.tool}</code>
							{#if msg.args}
								<pre class="args-pre">{msg.args}</pre>
							{/if}
						</div>
						{#if msg.approvalDecision === "blocked"}
							<div class="approval-blocked">
								<Lock size={12} />
								<span>Blocked by policy</span>
							</div>
						{:else if isPendingApproval(msg)}
							<div class="approval-actions">
								<button
									type="button"
									class="approve-btn"
									onclick={() => copilot.approve("approve")}
									aria-label={`Approve ${msg.tool ?? "tool"} call`}
									title={`Approve ${msg.tool ?? "tool"} call`}
								>
									Approve
								</button>
								<button
									type="button"
									class="deny-btn"
									onclick={() => copilot.approve("deny")}
									aria-label={`Deny ${msg.tool ?? "tool"} call`}
									title={`Deny ${msg.tool ?? "tool"} call`}
								>
									Deny
								</button>
							</div>
						{:else}
							<div class="approval-resolved">
								<CircleCheck size={12} />
								<span>Resolved</span>
							</div>
						{/if}
					</div>
				{:else if msg.suggestion}
					<div class="copilot-card suggestion-card">
						<div class="card-header">
							<Lightbulb size={12} />
							<span class="card-label">Suggestion</span>
						</div>
						<p class="suggestion-title">{msg.suggestion.title}</p>
						{#if msg.suggestion.body}
							<p class="suggestion-body">{msg.suggestion.body}</p>
						{/if}
						{#if isPendingSuggestion(msg.suggestion)}
							<div class="suggestion-actions">
								<button
									type="button"
									class="apply-btn"
									onclick={() => handleApply(msg.suggestion)}
									aria-label={`Apply suggestion: ${msg.suggestion?.title ?? ""}`}
									title={msg.suggestion?.actionLabel || "Apply"}
								>
									{msg.suggestion.actionLabel || "Apply"}
								</button>
								<button
									type="button"
									class="dismiss-btn"
									onclick={() => handleDismiss(msg.suggestion)}
									aria-label="Dismiss suggestion"
									title="Dismiss suggestion"
								>
									Dismiss
								</button>
							</div>
						{:else}
							<span class="suggestion-resolved">
								<CircleCheck size={12} />
								<span>Resolved</span>
							</span>
						{/if}
					</div>
				{:else if msg.kind === "error"}
					<div class="msg msg-assistant msg-error">
						<div class="msg-error-line">
							<TriangleAlert size={12} />
							<div class="msg-content">{msg.content}</div>
						</div>
						<span class="msg-time">
							{new Date(msg.timestamp).toLocaleTimeString([], {
								hour: "2-digit",
								minute: "2-digit",
							})}
						</span>
					</div>
				{:else}
					<div class="msg {msg.role === 'teacher' ? 'msg-teacher' : 'msg-assistant'}">
						<div class="msg-content">{msg.content}</div>
						<span class="msg-time">
							{new Date(msg.timestamp).toLocaleTimeString([], {
								hour: "2-digit",
								minute: "2-digit",
							})}
						</span>
					</div>
				{/if}
			{/each}
		{/if}

		{#if copilot.isStreaming}
			<div class="typing-indicator">
				<span class="dot"></span>
				<span class="dot"></span>
				<span class="dot"></span>
				<span class="typing-label">AI is thinking...</span>
			</div>
		{/if}
	</div>
	{/if}

	<div class="copilot-input-area">
		{#if showCommands}
			<div class="command-dropdown">
				{#each copilot.availableCommands as cmd (cmd.command)}
					<button class="command-item" onclick={() => selectCommand(cmd.command)}>
						<span class="cmd-name">{cmd.command}</span>
						<span class="cmd-desc">{cmd.description}</span>
					</button>
				{/each}
			</div>
		{/if}
		<div class="input-row">
			<Sparkles size={14} class="input-icon" />
			<input
				type="text"
				class="input-field"
				placeholder={assignmentScope
					? "Ask about the assignment..."
					: "Ask the copilot or type / for commands..."}
				value={copilot.inputValue}
				oninput={handleInput}
				onkeydown={handleKeydown}
				disabled={copilot.isStreaming}
			/>
			<button
				class="send-btn"
				onclick={handleSend}
				disabled={!copilot.inputValue.trim() || copilot.isStreaming}
				aria-label="Send message"
				title="Send message"
			>
				<Send size={14} />
			</button>
		</div>
	</div>
</div>

<style>
	.copilot-container {
		display: flex;
		flex-direction: column;
		height: 100%;
		overflow: hidden;
	}
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

	.active-thread-title {
		font-size: 11px;
		font-weight: 500;
		color: var(--muted-foreground);
		max-width: 140px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.header-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
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

	/* Context window visibility (Task U.4). */
	.context-line {
		font-size: 11px;
		color: var(--muted-foreground);
		padding: 6px 12px;
		border-bottom: 1px solid var(--border);
		background: var(--card);
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

	/* Thread switcher (Task T). */
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

	.copilot-messages {
		flex: 1;
		overflow-y: auto;
		padding: 12px;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.empty-state {
		text-align: center;
		padding: 40px 16px;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 8px;
	}

	.empty-title {
		font-size: 15px;
		font-weight: 600;
	}
	.empty-desc {
		font-size: 12px;
		color: var(--muted-foreground);
		max-width: 240px;
	}
	.command-hints {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		justify-content: center;
		margin-top: 8px;
	}
	.hint-chip {
		padding: 4px 10px;
		border-radius: 999px;
		border: 1px solid var(--border);
		font-size: 11px;
		font-weight: 500;
		color: var(--muted-foreground);
		background: var(--bg);
		cursor: pointer;
	}
	.hint-chip:hover {
		border-color: var(--primary);
		color: var(--primary);
	}
	.msg {
		max-width: 85%;
		padding: 8px 12px;
		border-radius: var(--radius);
		font-size: 12px;
		line-height: 1.5;
	}
	.msg-teacher {
		align-self: flex-end;
		background: var(--primary);
		color: var(--primary-foreground);
	}
	.msg-assistant {
		align-self: flex-start;
		background: var(--card);
		border: 1px solid var(--border);
		color: var(--foreground);
	}
	.msg-error {
		border-color: color-mix(in oklch, var(--destructive) 40%, var(--border));
		background: color-mix(in oklch, var(--destructive) 8%, var(--card));
	}
	.msg-error-line {
		display: flex;
		align-items: flex-start;
		gap: 6px;
		color: var(--destructive);
	}
	.msg-time {
		font-size: 10px;
		color: var(--muted-foreground);
		display: block;
		margin-top: 4px;
	}

	/* Agent stream cards (tool-call / tool-result / approval / suggestion). */
	.copilot-card {
		align-self: stretch;
		background: var(--card);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 8px 10px;
		font-size: 12px;
		line-height: 1.5;
		color: var(--foreground);
	}
	.card-header {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.card-label {
		font-size: 11px;
		font-weight: 600;
		color: var(--muted-foreground);
	}
	.tool-name {
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		font-size: 11px;
		font-weight: 600;
		color: var(--primary);
		margin-left: auto;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.args-toggle {
		margin-top: 8px;
	}
	.args-summary {
		list-style: none;
		display: flex;
		align-items: center;
		gap: 4px;
		cursor: pointer;
		font-size: 11px;
		font-weight: 500;
		color: var(--muted-foreground);
		user-select: none;
	}
	.args-summary::-webkit-details-marker {
		display: none;
	}
	.chevron-wrap {
		display: inline-flex;
		transition: transform 0.15s;
	}
	details[open] .chevron-wrap {
		transform: rotate(90deg);
	}
	.args-pre {
		margin: 8px 0 0;
		padding: 8px;
		background: var(--muted);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		font-size: 11px;
		line-height: 1.45;
		white-space: pre-wrap;
		word-break: break-word;
		overflow-x: auto;
		color: var(--foreground);
	}

	.tool-result-card {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.tool-result-ok {
		color: var(--success);
	}
	.tool-result-err {
		color: var(--destructive);
	}
	.tool-result-card .tool-name {
		color: inherit;
	}
	.tool-result-summary {
		color: var(--foreground);
		min-width: 0;
	}

	/* Approval request — prominent until decided. */
	.approval-card {
		border: 1px solid color-mix(in oklch, var(--warning) 45%, var(--border));
		background: color-mix(in oklch, var(--warning) 7%, var(--card));
	}
	.approval-body {
		display: flex;
		flex-direction: column;
		gap: 6px;
		margin-top: 6px;
	}
	.approval-actions {
		display: flex;
		gap: 8px;
		margin-top: 10px;
	}
	.approve-btn {
		background: var(--primary);
		color: var(--primary-foreground);
		border: none;
		border-radius: var(--radius);
		padding: 5px 14px;
		font-size: 12px;
		font-weight: 600;
		cursor: pointer;
	}
	.approve-btn:hover {
		opacity: 0.9;
	}
	.deny-btn {
		background: none;
		color: var(--destructive);
		border: 1px solid color-mix(in oklch, var(--destructive) 40%, var(--border));
		border-radius: var(--radius);
		padding: 4px 14px;
		font-size: 12px;
		font-weight: 600;
		cursor: pointer;
	}
	.deny-btn:hover {
		background: color-mix(in oklch, var(--destructive) 8%, transparent);
	}
	.approval-blocked {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-top: 10px;
		font-size: 12px;
		font-weight: 600;
		color: var(--destructive);
	}
	.approval-resolved {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-top: 10px;
		font-size: 11px;
		font-weight: 500;
		color: var(--muted-foreground);
	}

	/* Interactive suggestion card (apply/dismiss, 4e). */
	.suggestion-title {
		font-size: 12px;
		font-weight: 600;
		color: var(--foreground);
		margin: 6px 0 0;
	}
	.suggestion-body {
		font-size: 12px;
		color: var(--muted-foreground);
		line-height: 1.5;
		margin: 4px 0 0;
	}
	.suggestion-actions {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-top: 10px;
	}
	.apply-btn {
		background: var(--primary);
		color: var(--primary-foreground);
		border: none;
		border-radius: var(--radius);
		padding: 5px 14px;
		font-size: 12px;
		font-weight: 600;
		cursor: pointer;
	}
	.apply-btn:hover {
		opacity: 0.9;
	}
	.dismiss-btn {
		background: none;
		color: var(--muted-foreground);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 4px 14px;
		font-size: 12px;
		font-weight: 600;
		cursor: pointer;
	}
	.dismiss-btn:hover {
		color: var(--foreground);
		border-color: var(--muted-foreground);
	}
	.suggestion-resolved {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		margin-top: 8px;
		font-size: 11px;
		font-weight: 500;
		color: var(--muted-foreground);
	}

	.typing-indicator {
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 8px;
	}
	.dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--muted-foreground);
		animation: bounce 1.4s infinite ease-in-out;
	}
	.dot:nth-child(2) {
		animation-delay: 0.2s;
	}
	.dot:nth-child(3) {
		animation-delay: 0.4s;
	}
	@keyframes bounce {
		0%,
		80%,
		100% {
			transform: scale(0.6);
			opacity: 0.4;
		}
		40% {
			transform: scale(1);
			opacity: 1;
		}
	}
	.typing-label {
		font-size: 11px;
		color: var(--muted-foreground);
		margin-left: 6px;
	}
	.copilot-input-area {
		border-top: 1px solid var(--border);
		padding: 8px 12px;
		background: var(--card);
		position: relative;
	}
	.command-dropdown {
		position: absolute;
		bottom: 100%;
		left: 0;
		right: 0;
		background: var(--card);
		border: 1px solid var(--border);
		border-bottom: none;
		border-radius: var(--radius) var(--radius) 0 0;
		overflow: hidden;
		box-shadow: 0 -2px 8px rgba(0, 0, 0, 0.08);
	}
	.command-item {
		display: flex;
		align-items: center;
		gap: 12px;
		width: 100%;
		padding: 8px 12px;
		border: none;
		background: none;
		cursor: pointer;
		text-align: left;
		font-size: 12px;
	}
	.command-item:hover {
		background: var(--muted);
	}
	.cmd-name {
		font-family: ui-monospace, monospace;
		font-weight: 600;
		color: var(--primary);
		min-width: 80px;
	}
	.cmd-desc {
		color: var(--muted-foreground);
	}
	.input-row {
		display: flex;
		align-items: center;
		gap: 8px;
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 4px 8px;
	}

	.input-field {
		flex: 1;
		border: none;
		background: none;
		outline: none;
		font-size: 12px;
		color: var(--foreground);
		padding: 4px 0;
	}
	.input-field::placeholder {
		color: var(--muted-foreground);
	}
	.send-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		border-radius: var(--radius);
		border: none;
		background: var(--primary);
		color: var(--primary-foreground);
		cursor: pointer;
		flex-shrink: 0;
	}
	.send-btn:disabled {
		opacity: 0.4;
		cursor: default;
	}
	.send-btn:hover:not(:disabled) {
		opacity: 0.9;
	}
</style>
