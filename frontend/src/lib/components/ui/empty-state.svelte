<script lang="ts">
	import type { Snippet } from "svelte";

	/** Props for the empty state placeholder component. */
	interface Props {
		/** Heading text. */
		title: string;
		/** Description text below the title. */
		description: string;
		/** Additional CSS class names. */
		class?: string;
		/** Snippet rendering a custom icon. */
		icon?: Snippet;
		/** Snippet rendering a call-to-action button or link. */
		action?: Snippet;
	}

	let { title, description, class: className = "", icon, action }: Props = $props();
</script>

<div
	class="flex flex-col items-center justify-center rounded-[var(--radius)] border border-dashed border-border py-12 text-center {className}"
>
	{#if icon}
		<div class="mb-3 text-muted-foreground">
			{@render icon()}
		</div>
	{/if}
	<p class="mb-1 font-medium text-foreground">{title}</p>
	<p class="text-sm text-muted-foreground">{description}</p>
	{#if action}
		<div class="mt-6">
			{@render action()}
		</div>
	{/if}
</div>
