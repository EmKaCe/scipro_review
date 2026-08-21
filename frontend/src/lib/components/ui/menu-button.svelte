<script lang="ts">
	/**
	 * Split-button with dropdown menu (export variants, download actions).
	 *
	 * Primary click runs `primaryOnClick`; the caret toggles a menu of
	 * secondary options. Closes on outside click / Escape. No portal —
	 * renders in place with `position: absolute` (parent must be relative).
	 *
	 * Styled with the shared shadcn `buttonVariants` so it matches every
	 * other button in the app.
	 */
	import { buttonVariants } from "$lib/components/ui/button/button-variants.js";
	import { cn } from "$lib/utils.js";
	import ChevronDown from "@lucide/svelte/icons/chevron-down";
	import type { Snippet } from "svelte";

	interface MenuItem {
		/** Stable id (used as button key). */
		id: string;
		/** Menu item label. */
		label: string;
		/** One-line description under the label (optional). */
		description?: string;
		onclick: () => void;
	}

	interface Props {
		/** Primary button label. */
		label: string;
		/** Primary action (default export kind). */
		primaryOnClick: () => void;
		/** Menu entries (caret opens the menu when non-empty). */
		items: MenuItem[];
		/** Optional leading icon for the primary button. */
		icon?: Snippet;
		/** Tooltip for the primary button (defaults to the label). */
		title?: string;
		/** "right" (default) or "left" menu alignment. */
		align?: "right" | "left";
		/** Shared button variant (default: outline). */
		variant?: "default" | "outline" | "secondary" | "ghost" | "destructive" | "success";
		/** Shared button size (default: sm). */
		size?: "default" | "sm" | "xs";
		/** Extra classes for the wrapper. */
		class?: string;
	}

	let {
		label,
		primaryOnClick,
		items,
		icon,
		title,
		align = "right",
		variant = "outline",
		size = "sm",
		class: className,
	}: Props = $props();

	let open = $state(false);
	let rootEl = $state<HTMLDivElement>();

	function handlePrimary() {
		open = false;
		primaryOnClick();
	}

	function handleItem(item: MenuItem) {
		open = false;
		item.onclick();
	}

	function onGlobalKeydown(e: KeyboardEvent) {
		if (e.key === "Escape" && open) {
			open = false;
		}
	}

	$effect(() => {
		if (!open) return;
		const onPointer = (e: PointerEvent) => {
			if (rootEl && !rootEl.contains(e.target as Node)) {
				open = false;
			}
		};
		document.addEventListener("pointerdown", onPointer);
		document.addEventListener("keydown", onGlobalKeydown);
		return () => {
			document.removeEventListener("pointerdown", onPointer);
			document.removeEventListener("keydown", onGlobalKeydown);
		};
	});
</script>

<div class={cn("relative inline-flex items-stretch", className)} bind:this={rootEl}>
	<button
		class={cn(
			buttonVariants({ variant, size }),
			"gap-1.5",
			items.length > 0 ? "rounded-r-none" : "",
		)}
		onclick={handlePrimary}
		title={title ?? label}
	>
		{#if icon}{@render icon()}{/if}
		<span>{label}</span>
	</button>
	{#if items.length > 0}
		<button
			class={cn(buttonVariants({ variant, size }), "-ml-px w-8 rounded-l-none px-0")}
			aria-label="More options"
			aria-expanded={open}
			onclick={() => (open = !open)}
		>
			<ChevronDown size={14} class={cn("transition-transform", open && "rotate-180")} />
		</button>
	{/if}
	{#if open}
		<div
			class={cn(
				"absolute z-50 min-w-56 rounded-md border bg-popover p-1 text-popover-foreground shadow-md",
				align === "left" ? "left-0" : "right-0",
			)}
			style="top: calc(100% + 4px)"
		>
			{#each items as item (item.id)}
				<button
					class="flex w-full flex-col items-start gap-0.5 rounded-sm px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
					onclick={() => handleItem(item)}
				>
					<span class="font-medium">{item.label}</span>
					{#if item.description}
						<span class="text-xs leading-tight text-muted-foreground"
							>{item.description}</span
						>
					{/if}
				</button>
			{/each}
		</div>
	{/if}
</div>
