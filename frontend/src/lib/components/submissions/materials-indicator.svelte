<script lang="ts">
	import CircleCheck from "@lucide/svelte/icons/circle-check";
	import X from "@lucide/svelte/icons/x";

	interface MaterialStatus {
		label: string;
		present: boolean;
	}

	interface Props {
		/** Material statuses. Phase 2: always present. */
		materials?: MaterialStatus[];
	}

	let {
		materials = [
			{ label: "PDF", present: true },
			{ label: "Key", present: true },
			{ label: "Data", present: true },
		],
	}: Props = $props();
</script>

<div class="materials-indicator">
	<span class="materials-label">Materials:</span>
	{#each materials as mat (mat.label)}
		<span class="mat-item" class:mat-present={mat.present} class:mat-missing={!mat.present}>
			{#if mat.present}
				<CircleCheck size={11} class="mat-check" />
			{:else}
				<X size={11} class="mat-cross" />
			{/if}
			{mat.label}
		</span>
	{/each}
</div>

<style>
	.materials-indicator {
		display: flex;
		align-items: center;
		gap: 10px;
		font-size: 11px;
		color: var(--muted-foreground);
		white-space: nowrap;
	}
	.materials-label {
		color: var(--muted-foreground);
	}
	.mat-item {
		display: inline-flex;
		align-items: center;
		gap: 3px;
	}
</style>
