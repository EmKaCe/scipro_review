<script lang="ts">
	import Sparkles from "@lucide/svelte/icons/sparkles";
	import Send from "@lucide/svelte/icons/send";

	type SlashCommand = {
		command: string;
		description: string;
	};

	/**
	 * Slash-command registry (Task 5.2). Shown in the dropdown when the
	 * input starts with "/", filtered by the typed prefix. Tab completes
	 * the first match; click selects; Escape closes without selecting.
	 */
	const COMMANDS: SlashCommand[] = [
		{
			command: "/suggest",
			description: "Suggest grades and rubric selections for this submission",
		},
		{ command: "/grade", description: "Show the current grading status" },
		{ command: "/draft", description: "Draft feedback for the student" },
		{ command: "/summary", description: "Summarize this submission" },
		{ command: "/audit", description: "Audit the notebook for common issues" },
		{ command: "/plagiarism", description: "Check for plagiarism against other submissions" },
		{ command: "/explain", description: "Explain a concept from the assignment" },
		{ command: "/compare", description: "Compare this submission to the reference key" },
		{ command: "/fix", description: "Suggest fixes for broken cells" },
		{ command: "/help", description: "Show available commands and tools" },
	];

	type Props = {
		/** Draft text — bindable so the parent (store) owns the value. */
		inputValue?: string;
		/**
		 * Prompt delivered from an inline "Ask copilot" chip. $bindable:
		 * consumed here (fills the input, focuses it) and reset to "" — the
		 * round-trip propagates back to the page so re-clicking the same
		 * chip re-delivers.
		 */
		incomingPrompt?: string;
		/** Disables input + send while the agent stream is open. */
		isStreaming: boolean;
		/** True in assignment scope (different placeholder). */
		assignmentScope: boolean;
		/** Send the current draft (the input clears itself after sending). */
		onSend: (text: string) => void;
	};

	let {
		inputValue = $bindable(""),
		incomingPrompt = $bindable(""),
		isStreaming,
		assignmentScope,
		onSend,
	}: Props = $props();

	/** The chat input — focused when an inline chip delivers a prompt. */
	let inputEl = $state<HTMLInputElement | undefined>();

	/** True while the slash-command dropdown is open (Escape/Tab/select close it). */
	let showCommands = $state(false);
	/**
	 * Raw slash-command query (the input text while it starts with "/").
	 * State (not derived over the bindable) so the dropdown survives the
	 * Svelte 5.56.x bindable+derived staleness quirk.
	 */
	let commandQuery = $state("");

	/** Commands matching the typed prefix (rendered in the dropdown). */
	let matches = $derived(
		commandQuery ? COMMANDS.filter((c) => c.command.startsWith(commandQuery)) : [],
	);

	/**
	 * Single sync point for the dropdown: recomputed whenever the draft
	 * text changes — from typing AND from external writes (hint chips,
	 * incomingPrompt). Writes only `commandQuery`/`showCommands` (never
	 * reads them back in a way that re-triggers), so no effect loop.
	 */
	$effect(() => {
		const value = inputValue;
		const query = value.startsWith("/") ? value : "";
		commandQuery = query;
		showCommands = query !== "" && COMMANDS.some((c) => c.command.startsWith(query));
	});

	/**
	 * The page sets `incomingPrompt` when the teacher clicks an inline
	 * "Ask copilot" chip — and switches to this tab first, so the panel is
	 * mounted by the time this effect runs. Fill the input and focus it;
	 * the teacher reviews the prompt and presses Send. Resetting to "" is
	 * the $bindable round-trip: it propagates back to the page's
	 * queuedPrompt, so the same chip re-delivers on a later click.
	 */
	$effect(() => {
		if (!incomingPrompt) return;
		inputValue = incomingPrompt;
		incomingPrompt = "";
		inputEl?.focus();
	});

	function send(): void {
		const text = inputValue.trim();
		if (!text || isStreaming) return;
		onSend(text);
		inputValue = "";
	}

	function handleKeydown(e: KeyboardEvent): void {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			send();
		} else if (e.key === "Tab" && showCommands && matches.length > 0) {
			// Tab completes the first matching command and closes the dropdown.
			e.preventDefault();
			selectCommand(matches[0].command);
		} else if (e.key === "Escape" && showCommands) {
			// Escape closes the dropdown without selecting.
			e.preventDefault();
			showCommands = false;
		}
	}

	function selectCommand(command: string): void {
		inputValue = command + " ";
		showCommands = false;
	}
</script>

<div class="copilot-input-area">
	{#if showCommands}
		<div class="command-dropdown">
			{#each matches as cmd (cmd.command)}
				<button
					type="button"
					class="command-item"
					onclick={() => selectCommand(cmd.command)}
				>
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
			aria-label="Chat message"
			value={inputValue}
			oninput={(e) => (inputValue = (e.target as HTMLInputElement).value)}
			onkeydown={handleKeydown}
			disabled={isStreaming}
			bind:this={inputEl}
		/>
		<button
			class="send-btn"
			onclick={send}
			disabled={!inputValue.trim() || isStreaming}
			aria-label="Send message"
			title="Send message"
		>
			<Send size={14} />
		</button>
	</div>
</div>

<style>
	.copilot-input-area {
		border-top: 1px solid var(--border);
		padding: 8px 12px;
		background: var(--card);
		position: relative;
	}
	.command-dropdown {
		position: absolute;
		/* The input sits at the bottom of the panel — the dropdown opens
		 * upward so it is never clipped by the panel's overflow. */
		bottom: 100%;
		left: 0;
		right: 0;
		background: var(--card);
		border: 1px solid var(--border);
		border-bottom: none;
		border-radius: var(--radius) var(--radius) 0 0;
		overflow: hidden;
		box-shadow: 0 -2px 8px rgba(0, 0, 0, 0.08);
		max-height: 220px;
		overflow-y: auto;
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
	.input-field:focus-visible {
		outline: 2px solid var(--ring);
		outline-offset: 2px;
		border-radius: 4px;
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
