<script lang="ts">
	/**
	 * Split-button with dropdown menu (export variants, download actions).
	 *
	 * Primary click runs `primaryOnClick`; the caret toggles a menu of
	 * secondary options. Closes on outside click / Escape. No portal —
	 * renders in place with `position: absolute` (parent must be relative).
	 */
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
		/** "right" (default) or "left" menu alignment. */
		align?: "right" | "left";
		/** Extra class for the primary button styling variant. */
		variantClass?: string;
		/** Extra class for the group wrapper (border, responsive visibility…). */
		groupClass?: string;
	}

	let {
		label,
		primaryOnClick,
		items,
		icon,
		align = "right",
		variantClass = "",
		groupClass = "",
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

<div class="menu-button {groupClass}" bind:this={rootEl}>
	<button class="menu-button-primary {variantClass}" onclick={handlePrimary} title={label}>
		{#if icon}{@render icon()}{/if}
		<span>{label}</span>
	</button>
	{#if items.length > 0}
		<button
			class="menu-button-caret"
			aria-label="More export options"
			aria-expanded={open}
			onclick={() => (open = !open)}
		>
			<ChevronDown
				size={14}
				class="menu-caret-icon"
				style={open ? "transform: rotate(180deg)" : ""}
			/>
		</button>
	{/if}
	{#if open}
		<div
			class="menu-button-popover {align === 'left' ? 'menu-align-left' : 'menu-align-right'}"
		>
			{#each items as item (item.id)}
				<button class="menu-button-item" onclick={() => handleItem(item)}>
					<span class="menu-item-label">{item.label}</span>
					{#if item.description}
						<span class="menu-item-desc">{item.description}</span>
					{/if}
				</button>
			{/each}
		</div>
	{/if}
</div>

<style>
	.menu-button {
		position: relative;
		display: inline-flex;
		align-items: stretch;
	}
	.menu-button-primary {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		border-radius: 0;
	}
	.menu-button-caret {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 26px;
		border-left: 1px solid color-mix(in oklch, var(--border) 55%, transparent);
		border-radius: 0;
		transition: background 0.15s;
	}
	.menu-button-caret:hover {
		background: color-mix(in oklch, var(--fg) 6%, transparent);
	}
	.menu-caret-icon {
		transition: transform 0.15s;
		color: var(--muted-foreground);
	}
	.menu-button-popover {
		position: absolute;
		top: calc(100% + 4px);
		z-index: 50;
		min-width: 230px;
		padding: 4px;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--card);
		box-shadow: 0 8px 24px rgb(0 0 0 / 0.14);
	}
	.menu-align-right {
		right: 0;
	}
	.menu-align-left {
		left: 0;
	}
	.menu-button-item {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 1px;
		width: 100%;
		padding: 7px 9px;
		border-radius: calc(var(--radius) - 2px);
		text-align: left;
		transition: background 0.15s;
	}
	.menu-button-item:hover {
		background: color-mix(in oklch, var(--fg) 6%, transparent);
	}
	.menu-item-label {
		font-size: 13px;
		font-weight: 500;
		color: var(--fg);
	}
	.menu-item-desc {
		font-size: 11px;
		color: var(--muted-foreground);
		line-height: 1.35;
	}
</style>
