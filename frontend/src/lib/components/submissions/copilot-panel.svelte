<script lang="ts">
	import { createCopilotStore } from "./copilot-store.svelte.js";
	import Sparkles from "@lucide/svelte/icons/sparkles";
	import Send from "@lucide/svelte/icons/send";

	let copilot = $derived(createCopilotStore());

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
				<div class="msg {msg.role === 'teacher' ? 'msg-teacher' : 'msg-assistant'}">
					<div class="msg-content">{msg.content}</div>
					<span class="msg-time">
						{msg.timestamp.toLocaleTimeString([], {
							hour: "2-digit",
							minute: "2-digit",
						})}
					</span>
				</div>
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
	.msg-time {
		font-size: 10px;
		color: var(--muted-foreground);
		display: block;
		margin-top: 4px;
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
