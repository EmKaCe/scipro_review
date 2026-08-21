<script lang="ts">
	import Check from "@lucide/svelte/icons/check";
	import CheckCheck from "@lucide/svelte/icons/check-check";
	import FileText from "@lucide/svelte/icons/file-text";
	import RotateCcw from "@lucide/svelte/icons/rotate-ccw";
	import SlidersHorizontal from "@lucide/svelte/icons/sliders-horizontal";
	import SquareCheck from "@lucide/svelte/icons/square-check";
	import type { CopilotChange } from "../copilot-store.svelte.js";

	type Props = {
		changes: CopilotChange[];
		onAccept: (changeId: string) => void;
		onReject: (changeId: string) => void;
		onAcceptAll: () => void;
		/** Revert the whole turn to its pre-write snapshot (P3). */
		onRevertTurn: () => void;
		/** True when a checkpoint exists for the current turn (button visible). */
		canRevertTurn: boolean;
	};

	let { changes, onAccept, onReject, onAcceptAll, onRevertTurn, canRevertTurn }: Props = $props();

	/** Human-readable label for a change kind. */
	function kindLabel(kind: CopilotChange["kind"]): string {
		switch (kind) {
			case "rubric":
				return "Rubric";
			case "dimension":
				return "Score";
			case "notes":
				return "Notes";
		}
	}

	/** Render a value for display (null → "—"). */
	function displayValue(value: unknown): string {
		if (value === null || value === undefined) return "—";
		if (typeof value === "string") return value.length > 60 ? `${value.slice(0, 60)}…` : value;
		return String(value);
	}

	/** Icon per change kind. */
	function kindIcon(kind: CopilotChange["kind"]) {
		switch (kind) {
			case "rubric":
				return SquareCheck;
			case "dimension":
				return SlidersHorizontal;
			case "notes":
				return FileText;
		}
	}
</script>

{#if changes.length > 0 || canRevertTurn}
	<div class="ledger" role="region" aria-label="Proposed changes">
		<div class="ledger-header">
			<span class="ledger-title">Proposed changes</span>
			<div class="ledger-actions">
				{#if canRevertTurn}
					<button
						class="revert-turn"
						title="Restore the grading state from before this turn"
						onclick={onRevertTurn}
					>
						<RotateCcw size={13} />
						Revert turn
					</button>
				{/if}
				{#if changes.length > 0 && changes.some((c) => c.status === "pending")}
					<button class="accept-all" onclick={onAcceptAll}>
						<CheckCheck size={13} />
						Accept all
					</button>
				{/if}
			</div>
		</div>
		{#if changes.length > 0}
			<ul class="ledger-list">
				{#each changes as change (change.id)}
					{@const Icon = kindIcon(change.kind)}
					<li
						class="ledger-item"
						class:item-accepted={change.status === "accepted"}
						class:item-rejected={change.status === "rejected"}
					>
						<span class="item-icon"><Icon size={13} /></span>
						<div class="item-body">
							<div class="item-kind">{kindLabel(change.kind)} · {change.field}</div>
							<div class="item-diff">
								<span class="old-value">{displayValue(change.oldValue)}</span>
								<span class="arrow">→</span>
								<span class="new-value">{displayValue(change.newValue)}</span>
							</div>
						</div>
						{#if change.status === "pending"}
							<div class="item-actions">
								<button
									class="btn-accept"
									title="Accept this change"
									onclick={() => onAccept(change.id)}
								>
									<Check size={13} />
								</button>
								<button
									class="btn-reject"
									title="Reject and revert"
									onclick={() => onReject(change.id)}
								>
									<RotateCcw size={13} />
								</button>
							</div>
						{:else if change.status === "accepted"}
							<span class="status-badge status-accepted">Accepted</span>
						{:else}
							<span class="status-badge status-rejected">Rejected</span>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</div>
{/if}

<style>
	.ledger {
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 8px 10px;
		background: var(--muted);
	}
	.ledger-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 6px;
	}
	.ledger-title {
		font-size: 12px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--muted-foreground);
	}
	.ledger-actions {
		display: inline-flex;
		align-items: center;
		gap: 8px;
	}
	.accept-all,
	.revert-turn {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-size: 12px;
		font-weight: 500;
		background: none;
		border: none;
		cursor: pointer;
		padding: 2px 4px;
		border-radius: 4px;
	}
	.accept-all {
		color: var(--primary);
	}
	.accept-all:hover {
		background: var(--primary-soft);
	}
	.revert-turn {
		color: var(--destructive);
	}
	.revert-turn:hover {
		background: var(--destructive-soft);
	}
	.ledger-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.ledger-item {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 5px 6px;
		border-radius: 6px;
		background: var(--card);
		border: 1px solid var(--border);
	}
	.item-accepted {
		opacity: 0.65;
	}
	.item-rejected {
		opacity: 0.65;
		text-decoration: line-through;
	}
	.item-icon {
		flex: none;
		color: var(--muted-foreground);
	}
	.item-body {
		flex: 1;
		min-width: 0;
	}
	.item-kind {
		font-size: 11px;
		font-weight: 600;
		color: var(--muted-foreground);
		text-transform: uppercase;
		letter-spacing: 0.03em;
	}
	.item-diff {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 13px;
		margin-top: 1px;
	}
	.old-value {
		color: var(--muted-foreground);
		text-decoration: line-through;
	}
	.arrow {
		color: var(--muted-foreground);
	}
	.new-value {
		font-weight: 600;
		color: var(--foreground);
	}
	.item-actions {
		display: flex;
		gap: 4px;
		flex: none;
	}
	.btn-accept,
	.btn-reject {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 24px;
		height: 24px;
		border-radius: 5px;
		border: 1px solid var(--border);
		background: var(--card);
		cursor: pointer;
		color: var(--muted-foreground);
	}
	.btn-accept:hover {
		color: var(--success);
		border-color: var(--success);
	}
	.btn-reject:hover {
		color: var(--destructive);
		border-color: var(--destructive);
	}
	.status-badge {
		font-size: 11px;
		font-weight: 600;
		padding: 2px 6px;
		border-radius: 999px;
		flex: none;
	}
	.status-accepted {
		color: var(--success);
		background: var(--success-soft);
	}
	.status-rejected {
		color: var(--destructive);
		background: var(--destructive-soft);
	}
</style>
