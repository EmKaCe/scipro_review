<script lang="ts">
	import { Tooltip as TooltipPrimitive } from "bits-ui";
	import { cn } from "$lib/utils.js";

	interface Props {
		class?: string;
	}

	let { class: className }: Props = $props();
</script>

<TooltipPrimitive.Arrow class={cn("z-50 h-2 w-3 fill-primary", className)} />
