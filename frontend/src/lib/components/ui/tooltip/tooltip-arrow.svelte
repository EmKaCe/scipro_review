<script lang="ts">
	import { cn } from "$lib/utils.js";

	/**
	 * Tooltip arrow — small CSS triangle pointing at the trigger.
	 * Kept for API parity with the previous shadcn tooltip surface. NOTE:
	 * the content has NO ::after arrow; this component is a styling-only
	 * span, currently unused by app consumers (harmless parity surface).
	 */
	interface Props {
		class?: string;
	}

	let { class: className }: Props = $props();
</script>

<span aria-hidden="true" class={cn("z-50 h-2 w-3 fill-primary", className)}></span>
