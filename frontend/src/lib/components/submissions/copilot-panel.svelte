<script lang="ts">
	import { onMount } from "svelte";
	import { createCopilotStore, apiMode, type CopilotSuggestion } from "./copilot-store.svelte.js";
	import { fetchSettings, saveSettings, type CopilotMode } from "$lib/services/settings-api.js";
	import CopilotHeader from "./copilot/copilot-header.svelte";
	import CopilotChat from "./copilot/copilot-chat.svelte";
	import CopilotInput from "./copilot/copilot-input.svelte";
	import ThreadSidebar from "./copilot/thread-sidebar.svelte";

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
		 * Prompt delivered from an inline "Ask copilot" chip.
		 * $bindable: the panel consumes it (fills the input, focuses it)
		 * and resets it to "" — the round-trip propagates back to the
		 * page's queuedPrompt state, so re-clicking the same chip
		 * re-delivers. A plain prop could never be reset by the panel
		 * (Svelte 5 props are read-only). The consumption itself happens
		 * in copilot-input.svelte (it owns the input element); this panel
		 * owns the prop and forwards the binding.
		 */
		incomingPrompt?: string;
		/**
		 * Fired when the teacher applies a pending suggestion (clicked the
		 * actionLabel button). Receives the FULL suggestion payload, including
		 * `data` — the structured apply payload emitted by the tool.
		 *
		 * Convention: the repo communicates child→parent via callback
		 * props (`onXxx`) — rubric-category, upload-panel, autofix-card,
		 * right-panel-tabs (onTabChange/onSelectionsChange) — and has zero
		 * `createEventDispatcher` call sites. The panel sits inside a wrapper
		 * (right-panel-tabs) that the page wires, so the apply signal is a
		 * callback prop the wrapper forwards, matching that convention.
		 */
		onapply?: (suggestion: CopilotSuggestion) => void;
	}

	let {
		submissionId = "",
		assignmentId = "",
		incomingPrompt = $bindable(""),
		onapply,
	}: Props = $props();

	/** True in assignment scope: no per-submission context, assignment prompts. */
	let assignmentScope = $derived(!!assignmentId && !submissionId);

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

	/** True while the thread sidebar replaces the message list. */
	let showThreads = $state(false);

	function handleSend(text: string): void {
		const trimmed = text.trim();
		if (!trimmed || copilot.isStreaming) return;
		// After the turn completes, refresh the thread list (a brand-new
		// thread appears with its derived title; existing threads re-sort by
		// updatedAt and gain their latest preview).
		void copilot.sendMessage(trimmed).then(() => copilot.loadThreads());
	}

	/** Fill the input with a hint/command (no send). */
	function selectHint(hint: string): void {
		copilot.inputValue = hint;
	}

	function selectCommand(cmd: string): void {
		copilot.inputValue = cmd + " ";
	}

	// -----------------------------------------------------------------------
	// Auto-approve mode toggle (Issue 8)
	// -----------------------------------------------------------------------

	/**
	 * Copilot approval mode as configured on the server (data/settings.yaml,
	 * GET/PUT /api/settings). Local mirror — loaded once on mount, flipped
	 * by the header toggle. Only rendered in teacher mode (apiMode).
	 */
	let copilotMode = $state<CopilotMode>("ask");

	async function loadCopilotMode(): Promise<void> {
		try {
			const settings = await fetchSettings();
			const mode = settings.copilot?.mode;
			if (mode === "auto-approve-all" || mode === "ask") copilotMode = mode;
		} catch {
			// Settings endpoint unavailable (static build / tests) — keep "ask".
		}
	}

	/** Flip between ask and auto-approve-all, persisting via PUT /api/settings. */
	async function toggleAutoApprove(): Promise<void> {
		const nextMode: CopilotMode =
			copilotMode === "auto-approve-all" ? "ask" : "auto-approve-all";
		try {
			const settings = await fetchSettings();
			await saveSettings({ ...settings, copilot: { ...settings.copilot, mode: nextMode } });
			copilotMode = nextMode;
		} catch {
			// Save failed — keep showing the current mode.
		}
	}

	// -----------------------------------------------------------------------
	// Suggestion apply/dismiss + thread switching
	// -----------------------------------------------------------------------

	/** Apply the suggestion: removes it from pending and forwards it to the page. */
	function handleApply(suggestion: CopilotSuggestion): void {
		const applied = copilot.applySuggestion(suggestion.suggestionId);
		if (applied) onapply?.(applied);
	}

	/** Dismiss the suggestion: removes it from pending without applying. */
	function handleDismiss(suggestion: CopilotSuggestion): void {
		copilot.dismissSuggestion(suggestion.suggestionId);
	}

	/** Open a thread from the sidebar and close the sidebar. */
	function handleOpenThread(threadId: string): void {
		showThreads = false;
		void copilot.openThread(threadId);
	}

	/** Delete the ACTIVE thread (header two-step confirm already committed). */
	function handleDeleteActiveThread(): void {
		if (!copilot.activeThread) return;
		void copilot.deleteThread(copilot.activeThread.id);
	}

	// -----------------------------------------------------------------------
	// Mount: restore conversation + load approval mode
	// -----------------------------------------------------------------------

	onMount(() => {
		// Load the thread list and restore the conversation the teacher was
		// in (localStorage holds the active thread id per scope).
		void copilot.loadThreads();
		void copilot.restoreActiveThread();
		// Issue 8 — load the server-side copilot approval mode (teacher mode
		// only; the toggle button is hidden otherwise). Sequenced AFTER the
		// thread-list load settles: two parallel body reads of one response
		// (a test artifact, but also a real-server possibility) would leave
		// whichever read loses with "Body has already been read".
		if (apiMode.value) {
			void copilot
				.loadThreads()
				.catch(() => {})
				.then(() => loadCopilotMode());
		}
	});
</script>

<div class="copilot-container">
	<CopilotHeader
		activeThread={copilot.activeThread}
		{copilotMode}
		showModeToggle={apiMode.value}
		sidebarOpen={showThreads}
		isStreaming={copilot.isStreaming}
		loadingHistory={copilot.loadingHistory}
		onToggleMode={toggleAutoApprove}
		onNewConversation={() => copilot.newConversation()}
		onToggleSidebar={() => (showThreads = !showThreads)}
		onDeleteActiveThread={handleDeleteActiveThread}
	/>

	{#if showThreads}
		<ThreadSidebar
			threads={copilot.threads}
			activeThreadId={copilot.activeThread?.id}
			onOpen={handleOpenThread}
			onNew={() => copilot.newConversation()}
			onRename={(threadId, title) => void copilot.renameThread(threadId, title)}
			onDelete={(threadId) => void copilot.deleteThread(threadId)}
		/>
	{:else}
		<CopilotChat
			messages={copilot.messages}
			isStreaming={copilot.isStreaming}
			pendingApproval={copilot.pendingApproval}
			pendingSuggestions={copilot.pendingSuggestions}
			{assignmentScope}
			availableCommands={copilot.availableCommands}
			onApprove={() => void copilot.approve("approve")}
			onDeny={() => void copilot.approve("deny")}
			onApply={handleApply}
			onDismiss={handleDismiss}
			onSelectHint={selectHint}
			onSelectCommand={selectCommand}
		/>
	{/if}

	<CopilotInput
		bind:inputValue={copilot.inputValue}
		bind:incomingPrompt
		isStreaming={copilot.isStreaming}
		{assignmentScope}
		onSend={handleSend}
	/>
</div>

<style>
	.copilot-container {
		display: flex;
		flex-direction: column;
		height: 100%;
		overflow: hidden;
	}
</style>
