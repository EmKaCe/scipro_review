<script lang="ts">
	import type { Snippet } from "svelte";
	import CheckCircle from "@lucide/svelte/icons/check-circle";

	/** Props for the export format selection card (radio-style). */
	interface Props {
		/** Whether this format card is currently selected. */
		selected: boolean;
		/** Snippet rendering the format icon. */
		icon: Snippet;
		/** Format display title. */
		title: string;
		/** Format description text. */
		description: string;
		/** Badge label (e.g. file extension). */
		badge: string;
		/** Badge visual variant — "accent" uses primary color. */
		badgeVariant?: "default" | "accent";
		/** Callback when the card is clicked to select this format. */
		onclick: () => void;
	}

	let {
		selected,
		icon,
		title,
		description,
		badge,
		badgeVariant = "default",
		onclick,
	}: Props = $props();
</script>

<div
	role="radio"
	aria-checked={selected}
	tabindex="0"
	class="h-full cursor-pointer rounded-[var(--radius)] border p-4 transition-colors {selected
		? 'border-primary bg-primary/5'
		: 'border-border hover:border-primary/50'}"
	{onclick}
	onkeydown={(e) => {
		if (e.key === "Enter" || e.key === " ") {
			e.preventDefault();
			onclick();
		}
	}}
>
	<div class="mb-2 flex items-start justify-between">
		<div
			class="flex h-8 w-8 items-center justify-center rounded-[var(--radius)] {selected
				? 'bg-primary/10'
				: 'border border-border bg-background'}"
		>
			{@render icon()}
		</div>
		<div
			class="transition-all duration-200 {selected
				? 'scale-100 opacity-100'
				: 'scale-50 opacity-0'}"
		>
			<CheckCircle size={16} class="text-primary" />
		</div>
	</div>
	<p class="text-sm font-medium text-foreground">{title}</p>
	<p class="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</p>
	<div class="mt-2">
		{#if badgeVariant === "accent"}
			<span
				class="inline-flex items-center rounded-full bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary"
			>
				{badge}
			</span>
		{:else}
			<span
				class="inline-flex items-center rounded-full border border-border px-1.5 py-0.5 text-xs font-medium text-muted-foreground"
			>
				{badge}
			</span>
		{/if}
	</div>
</div>
