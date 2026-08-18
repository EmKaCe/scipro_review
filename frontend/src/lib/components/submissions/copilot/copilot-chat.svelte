<script lang="ts">
	import Markdown from "../Markdown.svelte";
	import ApprovalCard from "./approval-card.svelte";
	import SuggestionCard from "./suggestion-card.svelte";
	import PlanCard from "./plan-card.svelte";
	import ChangeLedger from "./change-ledger.svelte";
	import Sparkles from "@lucide/svelte/icons/sparkles";
	import Wrench from "@lucide/svelte/icons/wrench";
	import CircleCheck from "@lucide/svelte/icons/circle-check";
	import CircleX from "@lucide/svelte/icons/circle-x";
	import ChevronRight from "@lucide/svelte/icons/chevron-right";
	import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
	import type {
		CopilotMessage,
		CopilotSuggestion,
		CopilotPlanStep,
		CopilotChange,
		PendingApproval,
		PendingSuggestion,
	} from "../copilot-store.svelte.js";

	type Props = {
		/** Transcript messages to render. */
		messages: CopilotMessage[];
		/** True while the agent stream is open (typing indicator). */
		isStreaming: boolean;
		/** The live tool-approval request, if any (drives card interactivity). */
		pendingApproval: PendingApproval | null;
		/** Suggestions still actionable (drives apply/dismiss visibility). */
		pendingSuggestions: PendingSuggestion[];
		/** Harness plan checklist (W2a). */
		planSteps: CopilotPlanStep[];
		/** Change ledger entries (W2d). */
		changes: CopilotChange[];
		/** True in assignment scope: no per-submission context, assignment prompts. */
		assignmentScope: boolean;
		/** Slash commands offered as empty-state hint chips (store's list). */
		availableCommands: readonly { command: string; description: string }[];
		/** Approve the pending tool call. */
		onApprove: () => void;
		/** Deny the pending tool call. */
		onDeny: () => void;
		/** Apply a suggestion (forwards the payload to the page). */
		onApply: (suggestion: CopilotSuggestion) => void;
		/** Dismiss a suggestion without applying. */
		onDismiss: (suggestion: CopilotSuggestion) => void;
		/** Accept one change-ledger entry. */
		onAcceptChange: (changeId: string) => void;
		/** Reject one change-ledger entry (reverts via the save API). */
		onRejectChange: (changeId: string) => void;
		/** Accept every pending change-ledger entry. */
		onAcceptAllChanges: () => void;
		/** Fill the input with an assignment-scope prompt hint (no send). */
		onSelectHint: (hint: string) => void;
		/** Fill the input with a slash command + trailing space (no send). */
		onSelectCommand: (command: string) => void;
	};

	let {
		messages,
		isStreaming,
		pendingApproval,
		pendingSuggestions,
		planSteps,
		changes,
		assignmentScope,
		availableCommands,
		onApprove,
		onDeny,
		onApply,
		onDismiss,
		onAcceptChange,
		onRejectChange,
		onAcceptAllChanges,
		onSelectHint,
		onSelectCommand,
	}: Props = $props();

	/** Assignment-scope prompt hints (replaces the per-submission slash commands). */
	const assignmentHints = [
		"How is the class doing?",
		"Summarize pipeline status",
		"Which submissions need attention?",
	];

	/** The chat scroll container — snapped to the bottom on new content. */
	let messagesEl = $state<HTMLDivElement | undefined>();

	/**
	 * Watch the transcript length and streaming flag; while there is any
	 * content, keep the newest message in view (stream deltas replace the
	 * array on every chunk, so this also tracks mid-stream growth).
	 */
	$effect(() => {
		if (!messagesEl) return;
		const hasContent = messages.length > 0 || isStreaming;
		if (hasContent) messagesEl.scrollTop = messagesEl.scrollHeight;
	});

	/** Render tool args safely — the store guarantees strings, but older
	 * SSE/history payloads carried objects ("[object object]"). */
	function displayArgs(args: unknown): string {
		return typeof args === "string" ? args : JSON.stringify(args);
	}

	/** True when this approval message is the live pending request. */
	function isPendingApproval(msg: CopilotMessage): boolean {
		const pending = pendingApproval;
		return (
			pending !== null && pending.runId === msg.runId && pending.toolCallId === msg.toolCallId
		);
	}

	/** True while the suggestion is still actionable (not applied/dismissed). */
	function isPendingSuggestion(suggestion: CopilotSuggestion | undefined): boolean {
		return (
			suggestion !== undefined &&
			pendingSuggestions.some((s) => s.id === suggestion.suggestionId)
		);
	}

	/** Absolute time, matching the pre-refactor bubble format. */
	function msgTime(timestamp: number): string {
		return new Date(timestamp).toLocaleTimeString([], {
			hour: "2-digit",
			minute: "2-digit",
		});
	}
</script>

<div
	class="copilot-messages"
	bind:this={messagesEl}
	role="log"
	aria-live="polite"
	aria-label="Chat messages"
>
	{#if messages.length === 0}
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
						<button class="hint-chip" onclick={() => onSelectHint(hint)}>{hint}</button>
					{/each}
				{:else}
					{#each availableCommands as cmd (cmd.command)}
						<button class="hint-chip" onclick={() => onSelectCommand(cmd.command)}>
							{cmd.command}
						</button>
					{/each}
				{/if}
			</div>
		</div>
	{:else}
		<PlanCard steps={planSteps} />
		{#each messages as msg (msg.id)}
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
							<pre class="args-pre">{displayArgs(msg.args)}</pre>
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
				<ApprovalCard
					toolName={msg.tool ?? "unknown"}
					args={msg.args ?? ""}
					runId={msg.runId ?? ""}
					toolCallId={msg.toolCallId ?? ""}
					blocked={msg.approvalDecision === "blocked"}
					pending={isPendingApproval(msg)}
					{onApprove}
					{onDeny}
				/>
			{:else if msg.suggestion}
				<SuggestionCard
					suggestion={msg.suggestion}
					pending={isPendingSuggestion(msg.suggestion)}
					{onApply}
					{onDismiss}
				/>
			{:else if msg.kind === "error"}
				<div class="msg msg-assistant msg-error" role="article">
					<div class="msg-error-line">
						<TriangleAlert size={12} />
						<div class="msg-content">{msg.content}</div>
					</div>
					<span class="msg-time">{msgTime(msg.timestamp)}</span>
				</div>
			{:else}
				<div
					class="msg {msg.role === 'teacher' ? 'msg-teacher' : 'msg-assistant'}"
					role="article"
				>
					<div class="msg-content">
						{#if msg.role === "assistant"}
							<!-- Assistant content is markdown (Issue 6); teacher
							     and error bubbles stay plain text. -->
							<Markdown text={msg.content} />
						{:else}
							{msg.content}
						{/if}
					</div>
					<span class="msg-time">{msgTime(msg.timestamp)}</span>
				</div>
			{/if}
		{/each}
		<ChangeLedger
			{changes}
			onAccept={onAcceptChange}
			onReject={onRejectChange}
			onAcceptAll={onAcceptAllChanges}
		/>
	{/if}

	{#if isStreaming}
		<div class="typing-indicator">
			<span class="dot"></span>
			<span class="dot"></span>
			<span class="dot"></span>
			<span class="typing-label">AI is thinking...</span>
		</div>
	{/if}
</div>

<style>
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

	/* Agent stream cards (tool-call / tool-result). */
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
</style>
