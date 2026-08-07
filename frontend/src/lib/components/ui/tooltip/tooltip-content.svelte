<script lang="ts">
	import { Tooltip as TooltipPrimitive } from "bits-ui";
	import { cn } from "$lib/utils.js";
	import type { Snippet } from "svelte";

	/**
	 * Tooltip content — styled like the shadcn-svelte tooltip (dark primary
	 * surface, small text). Rendered via a floating-ui popper; bits-ui wires
	 * the trigger's `aria-describedby` to this element. `role="tooltip"` is
	 * set explicitly (bits-ui 2.x leaves it off) so assistive tech announces
	 * the text on trigger focus.
	 */
	interface Props {
		class?: string;
		side?: "top" | "right" | "bottom" | "left";
		sideOffset?: number;
		align?: "start" | "center" | "end";
		/** Test handle (forwarded to the popper element). */
		"data-testid"?: string;
		children?: Snippet;
	}

	let {
		class: className,
		side = "top",
		sideOffset = 4,
		align = "center",
		children,
		...restProps
	}: Props = $props();
</script>

<TooltipPrimitive.Content
	{side}
	{sideOffset}
	{align}
	role="tooltip"
	{...restProps}
	class={cn(
		"z-50 max-w-xs overflow-hidden rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground shadow-md select-none",
		className,
	)}
>
	{@render children?.()}
</TooltipPrimitive.Content>
