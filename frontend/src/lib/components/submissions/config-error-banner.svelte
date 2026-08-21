<script lang="ts">
	import AlertTriangle from "@lucide/svelte/icons/alert-triangle";
	import X from "@lucide/svelte/icons/x";

	interface Props {
		/** Error detail text shown under the headline (e.g. the fetch error). */
		message: string;
		/** Called when the teacher dismisses the banner (clears the page's error state). */
		onDismiss?: () => void;
	}

	let { message, onDismiss }: Props = $props();
</script>

<div class="config-error-banner" role="alert">
	<AlertTriangle size={16} style="flex-shrink: 0" />
	<div class="config-error-body">
		<p class="config-error-title">
			Assignment configuration could not be loaded — check DATA_DIR/assignments.yaml.
		</p>
		{#if message}
			<p class="config-error-detail">{message}</p>
		{/if}
	</div>
	{#if onDismiss}
		<button
			type="button"
			class="config-error-dismiss"
			aria-label="Dismiss configuration error"
			onclick={() => onDismiss?.()}
		>
			<X size={14} />
		</button>
	{/if}
</div>

<style>
	.config-error-banner {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		padding: 10px 12px;
		border: 1px solid color-mix(in oklch, var(--destructive) 35%, transparent);
		border-radius: var(--radius-md);
		background: color-mix(in oklch, var(--destructive) 8%, transparent);
	}
	.config-error-body {
		flex: 1;
		min-width: 0;
	}
	.config-error-title {
		margin: 0;
		font-size: 13px;
		font-weight: 600;
		line-height: 1.4;
		color: var(--destructive);
	}
	.config-error-detail {
		margin: 2px 0 0;
		font-size: 12px;
		line-height: 1.4;
		color: var(--muted-foreground);
		overflow-wrap: anywhere;
	}
	.config-error-dismiss {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		width: 24px;
		height: 24px;
		border: none;
		border-radius: var(--radius);
		background: transparent;
		color: var(--destructive);
		cursor: pointer;
		transition: background 0.15s;
	}
	.config-error-dismiss:hover {
		background: color-mix(in oklch, var(--destructive) 12%, transparent);
	}
</style>
