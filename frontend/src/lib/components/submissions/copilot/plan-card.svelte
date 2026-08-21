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
</script>

{#if steps.length > 0}
	<div class="plan-card" role="region" aria-label="Agent plan">
		<div class="plan-header">
			<ListChecks size={14} />
			<span class="plan-title">Plan</span>
		</div>
		<ul class="plan-steps">
			{#each steps as step (step.id)}
				<li
					class="plan-step"
					class:step-done={step.status === "completed"}
					class:step-error={step.status === "error"}
				>
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
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 8px 10px;
		background: var(--muted);
	}
	.plan-header {
		display: flex;
		align-items: center;
		gap: 6px;
		color: var(--muted-foreground);
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
		color: var(--foreground);
	}
	.step-dot {
		width: 13px;
		height: 13px;
		border-radius: 50%;
		border: 1.5px solid var(--border);
		flex: none;
	}
	.step-done {
		color: var(--muted-foreground);
	}
	.step-error {
		color: var(--destructive);
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
