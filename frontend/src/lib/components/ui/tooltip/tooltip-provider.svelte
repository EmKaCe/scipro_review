<script lang="ts">
	import { Tooltip as TooltipPrimitive } from "bits-ui";
	import type { Snippet } from "svelte";

	/**
	 * Tooltip provider — must wrap every Tooltip (bits-ui 2 resolves the
	 * provider context in Tooltip.Root). Mounted once in the root layout;
	 * sets the shared open-delay and hover behavior.
	 */
	interface Props {
		/** Delay in ms before a tooltip opens (default 700). */
		delayDuration?: number;
		/** Time to re-enter another trigger without a fresh delay. */
		skipDelayDuration?: number;
		/** Keep tooltips open while hovering the content. */
		disableHoverableContent?: boolean;
		children?: Snippet;
	}

	let {
		delayDuration = 700,
		skipDelayDuration = 300,
		disableHoverableContent = false,
		children,
	}: Props = $props();
</script>

<TooltipPrimitive.Provider {delayDuration} {skipDelayDuration} {disableHoverableContent}>
	{@render children?.()}
</TooltipPrimitive.Provider>
