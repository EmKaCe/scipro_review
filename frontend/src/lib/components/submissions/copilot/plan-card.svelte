<script lang="ts">
	import CircleCheck from "@lucide/svelte/icons/circle-check";
	import CircleX from "@lucide/svelte/icons/circle-x";
	import LoaderCircle from "@lucide/svelte/icons/loader-circle";
	import ListChecks from "@lucide/svelte/icons/list-checks";
	import type { CopilotPlanStep } from "../copilot-store.svelte.js";

	type Props = {
		steps: CopilotPlanStep[];
	};

	let { steps }: Props = $props();

	/** Status icon: pending → hollow, in_progress → spinner, done → check, error → x. */
	function statusIcon(status: CopilotPlanStep["status"]) {
		switch (status) {
			case "in_progress":
				return LoaderCircle;
			case "completed":
				return CircleCheck;
			case "error":
				return CircleX;
			default:
				return null;
		}
	}
</script>

{#if steps.length > 0}
	<div class="plan-card" role="region" aria-label="Agent plan">
		<div class="plan-header">
			<ListChecks size={14} />
			<span class="plan-title">Plan</span>
		</div>
		<ul class="plan-steps">
			{#each steps as step (step.id)}
				<li class="plan-step" class:step-done={step.status === "completed"} class:step-error={step.status === "error"}>
					{#if step.status === "in_progress"}
						<span class="step-icon spin"><LoaderCircle size={13} /></span>
					{:else if step.status === "completed"}
						<span class="step-icon"><CircleCheck size={13} /></span>
					{:else if step.status === "error"}
						<span class="step-icon"><CircleX size={13} /></span>
					{:else}
						<span class="step-dot" aria-hidden="true"></span>
					{/if}
					<span class="step-label">{step.label}</span>
				</li>
			{/each}
		</ul>
	</div>
{/if}

<style>
	.plan-card {
		border: 1px solid var(--color-border, #e2e8f0);
		border-radius: 8px;
		padding: 8px 10px;
		background: var(--color-surface, #f8fafc);
	}
	.plan-header {
		display: flex;
		align-items: center;
		gap: 6px;
		color: var(--color-muted, #64748b);
		font-size: 12px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		margin-bottom: 6px;
	}
	.plan-steps {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.plan-step {
		display: flex;
		align-items: center;
		gap: 7px;
		font-size: 13px;
		color: var(--color-text, #0f172a);
	}
	.step-dot {
		width: 13px;
		height: 13px;
		border-radius: 50%;
		border: 1.5px solid var(--color-border, #cbd5e1);
		flex: none;
	}
	.step-done {
		color: var(--color-muted, #64748b);
	}
	.step-error {
		color: var(--color-danger, #dc2626);
	}
	.spin {
		animation: spin 1s linear infinite;
		flex: none;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
</style>
