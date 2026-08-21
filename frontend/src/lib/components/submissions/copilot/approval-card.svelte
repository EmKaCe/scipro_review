<script lang="ts">
	import ShieldAlert from "@lucide/svelte/icons/shield-alert";
	import Lock from "@lucide/svelte/icons/lock";
	import CircleCheck from "@lucide/svelte/icons/circle-check";
	import ToolArgs from "./tool-args.svelte";

	type Props = {
		/** Tool name the approval is for. */
		toolName: string;
		/** Redacted tool arguments in display form (may be ""). */
		args: string;
		/** Run id of the suspended run. */
		runId: string;
		/** Tool call id awaiting a decision. */
		toolCallId: string;
		/** True when the request was blocked by policy (no buttons). */
		blocked?: boolean;
		/** True while this is the live pending request (Approve/Deny shown). */
		pending?: boolean;
		/** Approve the tool call (resumes the run). */
		onApprove: () => void;
		/** Deny the tool call (resumes the run with a denial). */
		onDeny: () => void;
	};

	let {
		toolName,
		args,
		runId,
		toolCallId,
		blocked = false,
		pending = false,
		onApprove,
		onDeny,
	}: Props = $props();
</script>

<div class="copilot-card approval-card" aria-live="assertive">
	<div class="card-header">
		<ShieldAlert size={14} />
		<span class="card-label">Approval required</span>
	</div>
	<div class="approval-body">
		<code class="tool-name">{toolName}</code>
		{#if args}
			<ToolArgs {args} />
		{/if}
		{#if runId}
			<span class="run-id" title={`Tool call: ${toolCallId}`}>Run {runId}</span>
		{/if}
	</div>
	{#if blocked}
		<div class="approval-blocked">
			<Lock size={12} />
			<span>Blocked by policy</span>
		</div>
	{:else if pending}
		<div class="approval-actions">
			<button
				type="button"
				class="approve-btn"
				onclick={onApprove}
				aria-label={`Approve ${toolName} call`}
				title={`Approve ${toolName} call`}
			>
				Approve
			</button>
			<button
				type="button"
				class="deny-btn"
				onclick={onDeny}
				aria-label={`Deny ${toolName} call`}
				title={`Deny ${toolName} call`}
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
	.run-id {
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		font-size: 10px;
		color: var(--muted-foreground);
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
</style>
