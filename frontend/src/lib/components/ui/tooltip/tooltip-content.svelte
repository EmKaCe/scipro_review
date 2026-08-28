<script lang="ts">
	import type { Snippet } from "svelte";

	import { cn } from "$lib/utils.js";

	import { tooltipRootContext } from "./tooltip-context.svelte.js";

	/**
	 * Tooltip content — styled like the previous shadcn tooltip (dark primary
	 * surface, small text). `role="tooltip"` and `id` are set so the trigger's
	 * `aria-describedby` resolves to this element.
	 *
	 * Positioning (P14-B follow-up): the content is rendered with
	 * `position: fixed` at coordinates measured from the trigger's viewport
	 * rect, so it escapes `overflow: hidden` ancestors (plagiarism modal,
	 * reviews-table) that clipped the previous CSS-only `absolute` placement.
	 * Repositioned on scroll/resize while open. No portal/mount machinery —
	 * the element stays in the component tree, which keeps snippets/events
	 * working and stays SSR/jsdom-safe (all DOM access is inside $effect).
	 */
	interface Props {
		class?: string;
		side?: "top" | "right" | "bottom" | "left";
		sideOffset?: number;
		/** Test handle (forwarded to the tooltip element). */
		"data-testid"?: string;
		children?: Snippet;
	}

	let {
		class: className,
		side = "top",
		sideOffset = 4,
		"data-testid": testId,
		children,
		...restProps
	}: Props = $props();

	const root = tooltipRootContext[0]();

	// Measured viewport position of the tooltip (null until first measure).
	let pos = $state<{ top: number; left: number } | null>(null);
	/** The rendered tooltip element — used to clamp against the viewport. */
	let contentEl: HTMLDivElement | undefined = $state();

	function measure(): void {
		const trigger = document.getElementById(root.triggerId);
		if (!trigger) return;
		const rect = trigger.getBoundingClientRect();
		const offset = sideOffset ?? 4;
		let top: number;
		let left: number;
		if (side === "bottom") {
			top = rect.bottom + offset;
			left = rect.left + rect.width / 2;
		} else if (side === "left") {
			top = rect.top + rect.height / 2;
			left = rect.left - offset;
		} else if (side === "right") {
			top = rect.top + rect.height / 2;
			left = rect.right + offset;
		} else {
			// top (default)
			top = rect.top - offset;
			left = rect.left + rect.width / 2;
		}
		pos = { top, left };
	}

	// Keep the tooltip inside the viewport: the transform centers it on the
	// trigger, so a wide tooltip near an edge would overflow. Clamp the
	// anchor once the content width is known (8px breathing room).
	$effect(() => {
		if (!root.open || !pos || !contentEl) return;
		const width = contentEl.offsetWidth;
		const half = width / 2;
		const minLeft = 8 + half;
		const maxLeft = window.innerWidth - 8 - half;
		if (pos.left < minLeft || pos.left > maxLeft) {
			pos = { ...pos, left: Math.min(Math.max(pos.left, minLeft), maxLeft) };
		}
	});

	// Measure on open and keep the tooltip glued to the trigger while open.
	$effect(() => {
		if (!root.open) return;
		measure();
		const onViewportChange = () => measure();
		window.addEventListener("scroll", onViewportChange, true);
		window.addEventListener("resize", onViewportChange);
		return () => {
			window.removeEventListener("scroll", onViewportChange, true);
			window.removeEventListener("resize", onViewportChange);
		};
	});
</script>

{#if root.open && pos}
	<div
		{...restProps}
		bind:this={contentEl}
		id={root.contentId}
		data-testid={testId}
		role="tooltip"
		data-state={root.stateAttr}
		style:position="fixed"
		style:top={`${pos.top}px`}
		style:left={`${pos.left}px`}
		style:transform={side === "bottom"
			? "translate(-50%, 0)"
			: side === "left"
				? "translate(-100%, -50%)"
				: side === "right"
					? "translate(0, -50%)"
					: "translate(-50%, -100%)"}
		class={cn(
			"z-50 max-w-xs rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground shadow-md select-none",
			className,
		)}
	>
		{@render children?.()}
	</div>
{/if}
