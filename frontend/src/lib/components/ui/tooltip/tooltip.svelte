<script lang="ts">
	import type { Snippet } from "svelte";

	import { cn } from "$lib/utils.js";

	import { getTooltipProvider, tooltipRootContext } from "./tooltip-context.svelte.js";

	/**
	 * Tooltip root — dependency-free replacement for the previous
	 * component-library tooltip, with the same component API.
	 *
	 * Owns the open state and renders a `relative inline-flex` wrapper so the
	 * content can be positioned with pure CSS (no popper / floating-ui, no
	 * portal). Keyboard users reach the tooltip on focus of the trigger;
	 * Escape and outside pointer-down close it.
	 */
	interface Props {
		/** Extra classes for the positioning wrapper (e.g. `ml-auto`). */
		class?: string;
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
		class: className,
		open = $bindable(false),
		onOpenChange,
		delayDuration,
		disableHoverableContent = true,
		disableCloseOnTriggerClick,
		disabled = false,
		ignoreNonKeyboardFocus = false,
		children,
	}: Props = $props();

	const uid = $props.id();
	const triggerId = `${uid}-trigger`;
	const contentId = `${uid}-content`;

	const provider = getTooltipProvider();
	const resolvedDelay = $derived(delayDuration ?? provider?.delayDuration ?? 700);
	const resolvedHoverable = $derived(
		disableHoverableContent ?? provider?.disableHoverableContent ?? true,
	);

	let openTimer: ReturnType<typeof setTimeout> | undefined;
	let wasDelayed = $state(false);
	let pointerDown = $state(false);
	let wrapperEl = $state<HTMLDivElement>();

	const stateAttr = $derived(open ? (wasDelayed ? "delayed-open" : "instant-open") : "closed");

	function clearOpenTimer() {
		if (openTimer !== undefined) {
			clearTimeout(openTimer);
			openTimer = undefined;
		}
	}

	function openTooltip() {
		if (disabled) return;
		clearOpenTimer();
		wasDelayed = false;
		open = true;
	}

	function scheduleOpen() {
		if (disabled) return;
		clearOpenTimer();
		if (resolvedDelay === 0) {
			wasDelayed = false;
			open = true;
			return;
		}
		openTimer = setTimeout(() => {
			openTimer = undefined;
			wasDelayed = true;
			open = true;
		}, resolvedDelay);
	}

	function closeTooltip() {
		clearOpenTimer();
		open = false;
	}

	function triggerLeave() {
		if (resolvedHoverable) closeTooltip();
		else clearOpenTimer();
	}

	function toggleOnClick() {
		if (open && !disableCloseOnTriggerClick) closeTooltip();
	}

	// Escape closes; outside pointer-down closes (replaces the popper's
	// onInteractOutside). Listeners only exist while open — SSR/jsdom-safe.
	$effect(() => {
		if (!open) return;
		const onKeydown = (e: KeyboardEvent) => {
			if (e.key === "Escape") closeTooltip();
		};
		const onPointerDown = (e: PointerEvent) => {
			const target = e.target as Node | null;
			if (wrapperEl && target && !wrapperEl.contains(target)) closeTooltip();
		};
		document.addEventListener("keydown", onKeydown);
		document.addEventListener("pointerdown", onPointerDown);
		return () => {
			document.removeEventListener("keydown", onKeydown);
			document.removeEventListener("pointerdown", onPointerDown);
		};
	});

	$effect(() => {
		onOpenChange?.(open);
	});

	tooltipRootContext[1]({
		get open() {
			return open;
		},
		get stateAttr() {
			return stateAttr;
		},
		triggerId,
		contentId,
		get pointerDown() {
			return pointerDown;
		},
		get ignoreNonKeyboardFocus() {
			return ignoreNonKeyboardFocus;
		},
		get disabled() {
			return disabled;
		},
		openTooltip,
		scheduleOpen,
		closeTooltip,
		triggerLeave,
		toggleOnClick,
		setPointerDown: () => {
			pointerDown = true;
		},
		clearPointerDown: () => {
			pointerDown = false;
		},
	});
</script>

<div class={cn("relative inline-flex", className)} bind:this={wrapperEl}>
	{@render children?.()}
</div>
