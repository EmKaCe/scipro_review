<script lang="ts">
	import { Tooltip as TooltipPrimitive } from "bits-ui";
	import type { HTMLButtonAttributes } from "svelte/elements";
	import type { Snippet } from "svelte";

	/**
	 * Tooltip trigger — wraps any button (or custom trigger via the `child`
	 * snippet). bits-ui injects the pointer/keyboard handlers, id,
	 * `aria-describedby` and `data-state` onto the wrapped element.
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
		/** Custom trigger element; receives the merged bits-ui trigger props. */
		child?: Snippet<[{ props: Record<string, unknown> }]>;
		/** Default trigger content when no `child` snippet is given. */
		children?: Snippet;
	}

	let { class: className, child, children, disabled = false, ...restProps }: Props = $props();

	function forward(props: Record<string, unknown>): Record<string, unknown> {
		return className ? { ...props, class: className } : props;
	}
</script>

{#snippet triggerChild({ props }: { props: Record<string, unknown> })}
	{#if child}
		{@render child({ props: forward(props) })}
	{:else}
		<!-- Caller attrs (onclick, aria-label, ...) win over bits-ui's merged
		     props; bits-ui's pointer/focus handlers survive because callers
		     don't pass them. Its own close-on-click is redundant (Escape and
		     outside-click still close the tooltip). -->
		<button {...props} {...restProps} type="button">
			{@render children?.()}
		</button>
	{/if}
{/snippet}

<TooltipPrimitive.Trigger {disabled} child={triggerChild} />
