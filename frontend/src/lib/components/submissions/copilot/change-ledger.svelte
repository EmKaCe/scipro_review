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

	let { changes, onAccept, onReject, onAcceptAll, onRevertTurn, canRevertTurn }: Props =
		$props();

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
					<button class="revert-turn" title="Restore the grading state from before this turn" onclick={onRevertTurn}>
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
					<li class="ledger-item" class:item-accepted={change.status === "accepted"} class:item-rejected={change.status === "rejected"}>
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
								<button class="btn-accept" title="Accept this change" onclick={() => onAccept(change.id)}>
									<Check size={13} />
								</button>
								<button class="btn-reject" title="Reject and revert" onclick={() => onReject(change.id)}>
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
		border: 1px solid var(--color-border, #e2e8f0);
		border-radius: 8px;
		padding: 8px 10px;
		background: var(--color-surface, #f8fafc);
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
		color: var(--color-muted, #64748b);
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
		color: var(--color-primary, #2563eb);
	}
	.accept-all:hover {
		background: var(--color-primary-soft, #eff6ff);
	}
	.revert-turn {
		color: var(--color-danger, #dc2626);
	}
	.revert-turn:hover {
		background: var(--color-danger-soft, #fef2f2);
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
		background: var(--color-surface-raised, #ffffff);
		border: 1px solid var(--color-border, #e2e8f0);
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
		color: var(--color-muted, #64748b);
	}
	.item-body {
		flex: 1;
		min-width: 0;
	}
	.item-kind {
		font-size: 11px;
		font-weight: 600;
		color: var(--color-muted, #64748b);
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
		color: var(--color-muted, #64748b);
		text-decoration: line-through;
	}
	.arrow {
		color: var(--color-muted, #94a3b8);
	}
	.new-value {
		font-weight: 600;
		color: var(--color-text, #0f172a);
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
		border: 1px solid var(--color-border, #e2e8f0);
		background: var(--color-surface-raised, #ffffff);
		cursor: pointer;
		color: var(--color-muted, #64748b);
	}
	.btn-accept:hover {
		color: var(--color-success, #16a34a);
		border-color: var(--color-success, #16a34a);
	}
	.btn-reject:hover {
		color: var(--color-danger, #dc2626);
		border-color: var(--color-danger, #dc2626);
	}
	.status-badge {
		font-size: 11px;
		font-weight: 600;
		padding: 2px 6px;
		border-radius: 999px;
		flex: none;
	}
	.status-accepted {
		color: var(--color-success, #16a34a);
		background: var(--color-success-soft, #f0fdf4);
	}
	.status-rejected {
		color: var(--color-danger, #dc2626);
		background: var(--color-danger-soft, #fef2f2);
	}
</style>
