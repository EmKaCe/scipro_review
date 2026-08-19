<script lang="ts">
	import type { Snippet } from "svelte";

	import { cn } from "$lib/utils.js";

	import { tooltipRootContext } from "./tooltip-context.svelte.js";

	/**
	 * Tooltip content — styled like the previous shadcn tooltip (dark primary
	 * surface, small text). Positioned with pure CSS relative to the tooltip
	 * wrapper (no popper, no portal): `absolute bottom-full` for the default
	 * `side="top"`. `role="tooltip"` and `id` are set so the trigger's
	 * `aria-describedby` resolves to this element.
	 *
	 * KNOWN TRADE-OFF (P14-B, from the code-quality review): without a portal
	 * the tooltip is clipped by `overflow: hidden` ancestors. Verified clips:
	 * plagiarism-modal (.modal-card overflow hidden) and reviews-table
	 * (overflow-hidden card + overflow-x-auto table) — their tooltips are
	 * invisible. Accepted for the de-bloat; revisit if those spots matter.
	 */
	interface Props {
		class?: string;
		side?: "top" | "right" | "bottom" | "left";
		sideOffset?: number;
		align?: "start" | "center" | "end";
		/** Test handle (forwarded to the tooltip element). */
		"data-testid"?: string;
		children?: Snippet;
	}

	let {
		class: className,
		side = "top",
		sideOffset = 4,
		align = "center",
		"data-testid": testId,
		children,
		...restProps
	}: Props = $props();

	const root = tooltipRootContext[0]();

	// CSS-only positioning: the wrapper is `relative`; the content anchors to
	// it. `side`/`align`/`sideOffset` are kept for API parity — only the
	// default top/center placement is implemented (the app only uses that).
	const placementClass = $derived(
		side === "bottom"
			? "top-full left-1/2 -translate-x-1/2 mt-1.5"
			: "bottom-full left-1/2 -translate-x-1/2 mb-1.5",
	);
</script>

{#if root.open}
	<div
		{...restProps}
		id={root.contentId}
		data-testid={testId}
		role="tooltip"
		data-state={root.stateAttr}
		class={cn(
			"absolute z-50 max-w-xs rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground shadow-md select-none",
			placementClass,
			className,
		)}
	>
		{@render children?.()}
	</div>
{/if}
