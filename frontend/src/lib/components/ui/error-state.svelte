<script lang="ts">
	import AlertTriangle from "@lucide/svelte/icons/alert-triangle";
	import RefreshCw from "@lucide/svelte/icons/refresh-cw";
	import Home from "@lucide/svelte/icons/home";
	import type { Snippet } from "svelte";

	/** Props for the error state component with retry and home navigation. */
	interface Props {
		/** Error heading text. */
		title: string;
		/** Error description text. */
		description: string;
		/** Additional CSS class names. */
		class?: string;
		/** Callback to retry the failed action. */
		onRetry?: () => void;
		/** Callback to navigate to the home page. */
		onHome?: () => void;
		/** Snippet for custom action buttons (overrides default retry/home buttons). */
		action?: Snippet;
	}

	let { title, description, class: className = "", onRetry, onHome, action }: Props = $props();
</script>

<div class="max-w-md text-center {className}">
	<div
		class="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-destructive/10"
	>
		<AlertTriangle class="text-destructive" size={28} />
	</div>
	<h3 class="mb-2 text-lg font-semibold tracking-tight">{title}</h3>
	<p class="mb-6 text-sm leading-relaxed text-muted-foreground">{description}</p>
	{#if action}
		{@render action()}
	{:else if onRetry || onHome}
		<div class="flex items-center justify-center gap-2">
			{#if onRetry}
				<button
					class="inline-flex h-9 items-center gap-2 rounded-[var(--radius)] bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
					onclick={onRetry}
				>
					<RefreshCw size={14} />
					Try Again
				</button>
			{/if}
			{#if onHome}
				<button
					class="inline-flex h-9 items-center gap-2 rounded-[var(--radius)] border border-border px-4 text-sm font-medium text-foreground transition-colors hover:bg-black/5 dark:hover:bg-white/10"
					onclick={onHome}
				>
					<Home size={14} />
					Go Home
				</button>
			{/if}
		</div>
	{/if}
</div>
