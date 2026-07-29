/**
 * @file Copilot store — manages copilot chat state, messages, and stub interactions.
 *
 * Phase 2: All stub — messages are hardcoded examples, commands show toast responses.
 * Phase 4: Connected to Mastra agent for real AI interactions.
 */

export interface CopilotMessage {
	id: string;
	role: "teacher" | "assistant";
	content: string;
	timestamp: Date;
	type: "text" | "command" | "suggestion" | "draft";
}

export interface PendingSuggestion {
	id: string;
	title: string;
	description: string;
	type: "grade" | "draft" | "fix";
}

/**
 * Creates a reactive copilot state object.
 * In Phase 2 this returns stub data. Phase 4 replaces the implementations.
 */
export function createCopilotStore() {
	let messages = $state<CopilotMessage[]>([]);
	let isStreaming = $state(false);
	let pendingSuggestions = $state<PendingSuggestion[]>([]);
	let inputValue = $state("");

	const availableCommands = [
		{ command: "/draft", description: "Generate feedback notes" },
		{ command: "/suggest", description: "Suggest grade dimensions" },
		{ command: "/explain", description: "Explain a cell or error" },
		{ command: "/autofix", description: "Fix an error in a cell" },
		{ command: "/compare", description: "Compare student approach to key" },
	];

	function sendMessage(content: string) {
		const userMsg: CopilotMessage = {
			id: crypto.randomUUID(),
			role: "teacher",
			content,
			// eslint-disable-next-line svelte/prefer-svelte-reactivity
			timestamp: new Date(),
			type: content.startsWith("/") ? "command" : "text",
		};
		messages = [...messages, userMsg];

		// Stub response — Phase 4 replaces with real Mastra agent call
		isStreaming = true;
		setTimeout(() => {
			const response: CopilotMessage = {
				id: crypto.randomUUID(),
				role: "assistant",
				content:
					"AI Copilot is not yet active. This is a Phase 2 stub — the full agentic experience will be available in Phase 4 with Mastra integration.",
				// eslint-disable-next-line svelte/prefer-svelte-reactivity
				timestamp: new Date(),
				type: "text",
			};
			messages = [...messages, response];
			isStreaming = false;
		}, 800);
	}

	function clearMessages() {
		messages = [];
		pendingSuggestions = [];
	}

	return {
		get messages() {
			return messages;
		},
		get isStreaming() {
			return isStreaming;
		},
		get pendingSuggestions() {
			return pendingSuggestions;
		},
		get inputValue() {
			return inputValue;
		},
		set inputValue(v: string) {
			inputValue = v;
		},
		availableCommands,
		sendMessage,
		clearMessages,
	};
}
