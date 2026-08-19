<script lang="ts">
	import type { HTMLButtonAttributes } from "svelte/elements";
	import type { Snippet } from "svelte";

	import { cn } from "$lib/utils.js";

	import { tooltipRootContext } from "./tooltip-context.svelte.js";

	/**
	 * Tooltip trigger — wraps any button (or custom trigger via the `child`
	 * snippet) and wires the pointer/keyboard handlers, ids, `aria-describedby`
	 * and `data-state` onto the wrapped element.
	 *
	 * Two usage forms:
	 *
	 * 1. Plain trigger button (classes via `class`, extra attrs forwarded):
	 *    <TooltipTrigger class="h-8 w-8" aria-label="Undo">
	 *        <Undo2 size={14} />
	 *    </TooltipTrigger>
	 *
	 * 2. Custom element (e.g. the shared <Button> primitive):
	 *    <TooltipTrigger>
	 *        {#snippet child({ props })}
	 *            <Button {...props} variant="ghost" size="icon">…</Button>
	 *        {/snippet}
	 *    </TooltipTrigger>
	 */
	interface Props extends HTMLButtonAttributes {
		class?: string;
		/** Custom trigger element; receives the merged trigger props. */
		child?: Snippet<[{ props: Record<string, unknown> }]>;
		/** Default trigger content when no `child` snippet is given. */
		children?: Snippet;
	}

	let { class: className, child, children, disabled = false, ...restProps }: Props = $props();

	const root = tooltipRootContext[0]();

	// Compose the caller's handler with the tooltip's own handler so both run.
	function chain(a: ((e: Event) => void) | undefined, b: (e: Event) => void) {
		if (!a) return b;
		return (e: Event) => {
			a(e);
			b(e);
		};
	}

	function isEffectivelyDisabled() {
		return disabled || root.disabled;
	}

	function handlePointerEnter(e: PointerEvent) {
		if (isEffectivelyDisabled()) return;
		if (e.pointerType === "touch") return;
		root.scheduleOpen();
	}

	function handlePointerLeave() {
		if (isEffectivelyDisabled()) return;
		root.triggerLeave();
	}

	function handlePointerDown() {
		if (isEffectivelyDisabled()) return;
		// Track mouse-focus vs keyboard-focus: focus that follows a
		// pointer-down must not open the tooltip.
		root.setPointerDown();
	}

	function handlePointerUp() {
		root.clearPointerDown();
	}

	function handleFocus() {
		if (isEffectivelyDisabled()) {
			if (root.open) root.closeTooltip();
			return;
		}
		if (root.pointerDown) return;
		if (root.ignoreNonKeyboardFocus) return;
		root.openTooltip();
	}

	function handleBlur() {
		if (isEffectivelyDisabled()) return;
		root.closeTooltip();
	}

	function handleClick() {
		if (isEffectivelyDisabled()) return;
		root.toggleOnClick();
	}

	// Tooltip's own handlers — always installed, composed with any caller
	// handler of the same event so both run.
	const TOOLTIP_HANDLERS: Record<string, (e: Event) => void> = {
		onpointerenter: handlePointerEnter as (e: Event) => void,
		onpointerleave: handlePointerLeave as (e: Event) => void,
		onpointerdown: handlePointerDown as (e: Event) => void,
		onpointerup: handlePointerUp as (e: Event) => void,
		onfocus: handleFocus as (e: Event) => void,
		onblur: handleBlur as (e: Event) => void,
		onclick: handleClick as (e: Event) => void,
	};

	function mergeProps(props: Record<string, unknown>): Record<string, unknown> {
		const merged: Record<string, unknown> = {
			...props,
			id: root.triggerId,
			"aria-describedby": root.open ? root.contentId : undefined,
			"data-state": root.stateAttr,
		};
		// Caller attrs (onclick, aria-label, ...) win over defaults; the
		// tooltip's event handlers are always composed in so both run.
		for (const [key, value] of Object.entries(restProps)) {
			if (key in TOOLTIP_HANDLERS) {
				merged[key] = chain(value as (e: Event) => void | undefined, TOOLTIP_HANDLERS[key]);
			} else {
				merged[key] = value;
			}
		}
		for (const [key, handler] of Object.entries(TOOLTIP_HANDLERS)) {
			if (!(key in merged)) merged[key] = handler;
		}
		if (className) {
			merged.class = cn(merged.class as string | undefined, className);
		}
		return merged;
	}
</script>

{#snippet triggerChild({ props }: { props: Record<string, unknown> })}
	{#if child}
		{@render child({ props: mergeProps({ ...props, disabled }) })}
	{:else}
		<button {...mergeProps({ disabled })} type="button">
			{@render children?.()}
		</button>
	{/if}
{/snippet}

{@render triggerChild({ props: {} })}
