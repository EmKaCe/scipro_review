<script lang="ts">
	import { createCopilotStore, type CopilotMessage } from "./copilot-store.svelte.js";
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

	interface Props {
		/**
		 * Submission the copilot operates on. Optional — the per-submission
		 * page wires it in a later task; the panel compiles standalone.
		 */
		submissionId?: string;
	}

	let { submissionId = "" }: Props = $props();

	/**
	 * One store per component instance — created once at mount. The previous
	 * `$derived(createCopilotStore())` built a fresh store on every reactive
	 * recomputation, discarding messages mid-stream. The submissionId capture
	 * is intentionally one-time (the store binds to the submission for its
	 * whole lifetime), so the state_referenced_locally hint is suppressed.
	 */
	// svelte-ignore state_referenced_locally
	const copilot = createCopilotStore(submissionId ? { submissionId } : undefined);

	function handleSend() {
		const text = copilot.inputValue.trim();
		if (!text || copilot.isStreaming) return;
		copilot.sendMessage(text);
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

	/** True when this approval message is the live pending request. */
	function isPendingApproval(msg: CopilotMessage): boolean {
		const pending = copilot.pendingApproval;
		return (
			pending !== null && pending.runId === msg.runId && pending.toolCallId === msg.toolCallId
		);
	}
</script>

<div class="copilot-container">
	<div class="copilot-header">
		<Sparkles size={14} class="copilot-icon" />
		<span>AI Copilot</span>
	</div>

	<div class="copilot-messages">
		{#if copilot.messages.length === 0}
			<div class="empty-state">
				<Sparkles size={24} class="empty-icon" />
				<p class="empty-title">AI Copilot</p>
				<p class="empty-desc">
					Ask questions about this submission, or type / for commands.
				</p>
				<div class="command-hints">
					{#each copilot.availableCommands as cmd (cmd.command)}
						<button class="hint-chip" onclick={() => selectCommand(cmd.command)}>
							{cmd.command}
						</button>
					{/each}
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
				{:else if msg.kind === "suggestion"}
					<div class="copilot-card suggestion-card">
						<div class="card-header">
							<Lightbulb size={12} />
							<span class="card-label">Suggestion</span>
						</div>
						<p class="suggestion-title">{msg.suggestion?.title ?? msg.content}</p>
						{#if msg.suggestion?.body}
							<p class="suggestion-body">{msg.suggestion.body}</p>
						{/if}
						{#if msg.suggestion?.actionLabel}
							<span class="suggestion-action">{msg.suggestion.actionLabel}</span>
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
				placeholder="Ask the copilot or type / for commands..."
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

	/* Read-only suggestion (apply wiring arrives later). */
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
	.suggestion-action {
		display: inline-block;
		margin-top: 8px;
		padding: 2px 8px;
		border-radius: 999px;
		font-size: 11px;
		font-weight: 600;
		color: var(--muted-foreground);
		background: var(--muted);
		border: 1px solid var(--border);
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
