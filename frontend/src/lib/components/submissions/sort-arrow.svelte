<script lang="ts">
	import ArrowUpDown from "@lucide/svelte/icons/arrow-up-down";
	import ArrowUp from "@lucide/svelte/icons/arrow-up";
	import ArrowDown from "@lucide/svelte/icons/arrow-down";

	interface Props {
		currentKey: string;
		targetKey: string;
		ascending: boolean;
		size?: number;
		class?: string;
	}

	let { currentKey, targetKey, ascending, size = 10, class: className = "" }: Props = $props();
</script>

{#if currentKey === targetKey}
	{#if ascending}
		<ArrowUp {size} class={className} />
	{:else}
		<ArrowDown {size} class={className} />
	{/if}
{:else}
	<ArrowUpDown {size} class={className} />
{/if}
