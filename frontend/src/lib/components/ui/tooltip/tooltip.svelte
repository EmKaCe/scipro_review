<script lang="ts">
	import { Tooltip as TooltipPrimitive } from "bits-ui";
	import type { Snippet } from "svelte";

	/**
	 * Tooltip root — shadcn-svelte style wrapper around bits-ui's Tooltip.
	 *
	 * Keyboard users reach the tooltip on focus (bits-ui wires onFocus on the
	 * trigger), so icon-only buttons get their explanation without a mouse.
	 *
	 * Self-provides the bits-ui Provider so the primitive also works in
	 * isolated component tests (the app layout mounts an extra provider,
	 * which is harmless — bits-ui supports nesting).
	 */
	interface Props {
		/** Controlled open state (bind:open). Uncontrolled by default. */
		open?: boolean;
		/** Fired when the tooltip opens or closes. */
		onOpenChange?: (open: boolean) => void;
		/** Delay in ms before the tooltip opens (default 700). */
		delayDuration?: number;
		/** Close the tooltip as soon as the pointer leaves the trigger. */
		disableHoverableContent?: boolean;
		/** Keep the tooltip open after clicking the trigger. */
		disableCloseOnTriggerClick?: boolean;
		/** Fully disable the tooltip. */
		disabled?: boolean;
		/** Only open on keyboard focus (not mouse focus). */
		ignoreNonKeyboardFocus?: boolean;
		children?: Snippet;
	}

	let {
		open = $bindable(false),
		onOpenChange,
		delayDuration = 700,
		disableHoverableContent = true,
		disableCloseOnTriggerClick,
		disabled,
		ignoreNonKeyboardFocus,
		children,
	}: Props = $props();
</script>

<TooltipPrimitive.Provider>
	<TooltipPrimitive.Root
		bind:open
		{onOpenChange}
		{delayDuration}
		{disableHoverableContent}
		{disableCloseOnTriggerClick}
		{disabled}
		{ignoreNonKeyboardFocus}
	>
		{@render children?.()}
	</TooltipPrimitive.Root>
</TooltipPrimitive.Provider>
