<script lang="ts">
	import { base } from "$app/paths";
	import ListChecks from "@lucide/svelte/icons/list-checks";

	interface Props {
		/** Error detail from the API (shown small, e.g. the file path). */
		message: string;
	}

	let { message }: Props = $props();
</script>

<div class="first-run-callout" role="status">
	<ListChecks size={16} style="flex-shrink: 0" />
	<div class="first-run-body">
		<p class="first-run-title">No assignment configuration found on this machine yet</p>
		<p class="first-run-text">
			There is no <code>assignments.yaml</code> in the data directory — that is the normal
			state of a fresh installation before the first assignment exists. On a Docker install the
			tracked example assignment is seeded automatically from the repo on first boot.
		</p>
		<a class="first-run-link" href="{base}/onboarding">Open the setup checklist →</a>
		{#if message}
			<p class="first-run-detail">{message}</p>
		{/if}
	</div>
</div>

<style>
	.first-run-callout {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		padding: 12px 14px;
		border: 1px solid color-mix(in oklch, var(--accent) 35%, transparent);
		border-radius: var(--radius-md);
		background: color-mix(in oklch, var(--accent) 8%, transparent);
		color: var(--foreground);
	}
	.first-run-body {
		flex: 1;
		min-width: 0;
	}
	.first-run-title {
		margin: 0;
		font-size: 13px;
		font-weight: 600;
		line-height: 1.4;
	}
	.first-run-text {
		margin: 4px 0 0;
		font-size: 12.5px;
		line-height: 1.5;
		color: var(--muted-foreground);
	}
	.first-run-link {
		display: inline-block;
		margin-top: 8px;
		font-size: 13px;
		font-weight: 600;
		color: var(--accent);
		text-decoration: none;
	}
	.first-run-link:hover {
		text-decoration: underline;
	}
	.first-run-detail {
		margin: 8px 0 0;
		font-size: 12px;
		line-height: 1.4;
		color: var(--muted-foreground);
		overflow-wrap: anywhere;
	}
	code {
		font-size: 0.92em;
		font-family: var(--font-mono, monospace);
	}
</style>