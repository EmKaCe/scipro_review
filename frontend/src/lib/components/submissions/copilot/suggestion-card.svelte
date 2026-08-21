<script lang="ts">
	import Lightbulb from "@lucide/svelte/icons/lightbulb";
	import CircleCheck from "@lucide/svelte/icons/circle-check";
	import type { CopilotSuggestion, SuggestionKind } from "../copilot-store.svelte.js";

	type Props = {
		/** The suggestion payload attached to the transcript message. */
		suggestion: CopilotSuggestion;
		/** True while the suggestion is still actionable (not applied/dismissed). */
		pending?: boolean;
		/** Apply the suggestion (removes it from pending, forwards to the page). */
		onApply: (suggestion: CopilotSuggestion) => void;
		/** Dismiss the suggestion without applying. */
		onDismiss: (suggestion: CopilotSuggestion) => void;
	};

	let { suggestion, pending = false, onApply, onDismiss }: Props = $props();

	/** Human label per suggestion kind. */
	const KIND_LABELS: Record<SuggestionKind, string> = {
		grade: "Grade",
		draft: "Feedback",
		fix: "Fix",
		export: "Export",
	};
</script>

<div class="copilot-card suggestion-card">
	<div class="card-header">
		<Lightbulb size={12} />
		<span class="card-label">Suggestion</span>
		{#if suggestion.kind}
			<span class="kind-chip">{KIND_LABELS[suggestion.kind] ?? "Suggestion"}</span>
		{/if}
	</div>
	<p class="suggestion-title">{suggestion.title}</p>
	{#if suggestion.body}
		<p class="suggestion-body">{suggestion.body}</p>
	{/if}
	{#if pending}
		<div class="suggestion-actions">
			<button
				type="button"
				class="apply-btn"
				onclick={() => onApply(suggestion)}
				aria-label={`Apply suggestion: ${suggestion.title}`}
				title={suggestion.actionLabel || "Apply"}
			>
				{suggestion.actionLabel || "Apply"}
			</button>
			<button
				type="button"
				class="dismiss-btn"
				onclick={() => onDismiss(suggestion)}
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

<style>
	/* Shared agent-card chrome (mirrored from the pre-refactor panel). */
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

	/* Interactive suggestion card (apply/dismiss, 4e). */
	.kind-chip {
		font-size: 10px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.03em;
		color: var(--primary);
		background: color-mix(in oklch, var(--primary) 10%, transparent);
		border-radius: 999px;
		padding: 1px 8px;
	}
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
</style>
