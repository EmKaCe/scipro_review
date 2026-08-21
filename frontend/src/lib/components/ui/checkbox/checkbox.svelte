<script lang="ts">
	import type { HTMLButtonAttributes } from "svelte/elements";
	import Check from "@lucide/svelte/icons/check";
	import Minus from "@lucide/svelte/icons/minus";
	import { cn } from "$lib/utils.js";

	/**
	 * Shadcn-style controlled checkbox (button[role=checkbox]).
	 *
	 * Renders the same structure the shadcn checkbox produces (data-state,
	 * rounded-sm border, Check icon, focus ring) but keeps the checked
	 * state fully parent-controlled.
	 */
	interface Props extends HTMLButtonAttributes {
		class?: string;
		checked?: boolean;
		indeterminate?: boolean;
	}

	let { class: className, checked = false, indeterminate = false, ...rest }: Props = $props();
</script>

<button
	type="button"
	role="checkbox"
	aria-checked={indeterminate ? "mixed" : checked ? "true" : "false"}
	data-state={indeterminate ? "indeterminate" : checked ? "checked" : "unchecked"}
	class={cn(
		"peer flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border border-input shadow disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary data-[state=indeterminate]:text-primary-foreground",
		className,
	)}
	{...rest}
>
	{#if indeterminate}
		<Minus class="h-3 w-3" />
	{:else if checked}
		<Check class="h-3 w-3" />
	{/if}
</button>
