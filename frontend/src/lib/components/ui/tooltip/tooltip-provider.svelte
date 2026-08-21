<script lang="ts">
	import type { Snippet } from "svelte";

	import { setTooltipProvider, type TooltipProviderContext } from "./tooltip-context.svelte.js";

	/**
	 * Tooltip provider — must wrap every Tooltip. Mounted once in the root
	 * layout; provides the shared open-delay and hover behavior. Now a
	 * no-op wrapper that exposes global defaults to nested tooltips.
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

	// Provider settings exposed as getters: children read them reactively
	// via `$derived` (getter bodies are closures, so updates propagate).
	const providerSettings: TooltipProviderContext = {
		get delayDuration() {
			return delayDuration;
		},
		get skipDelayDuration() {
			return skipDelayDuration;
		},
		get disableHoverableContent() {
			return disableHoverableContent;
		},
	};

	setTooltipProvider(providerSettings);
</script>

{@render children?.()}
