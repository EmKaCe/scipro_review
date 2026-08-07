<script lang="ts">
	/**
	 * Test harness for the Tooltip primitive — exposes the controlled open
	 * state so tests can drive it without pointer events.
	 */
	import {
		Tooltip,
		TooltipProvider,
		TooltipTrigger,
		TooltipContent,
	} from "$lib/components/ui/tooltip/index.js";

	interface Props {
		label?: string;
		content?: string;
		disabled?: boolean;
	}

	let { label = "Delete item", content = "Delete this item", disabled = false }: Props = $props();

	let open = $state(false);
</script>

<TooltipProvider delayDuration={0}>
	<Tooltip bind:open {disabled}>
		<TooltipTrigger aria-label={label}>x</TooltipTrigger>
		<TooltipContent data-testid="tooltip-content">{content}</TooltipContent>
	</Tooltip>
</TooltipProvider>
