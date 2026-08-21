<script lang="ts">
	import type { HTMLButtonAttributes } from "svelte/elements";
	import type { Snippet } from "svelte";

	import { cn } from "$lib/utils.js";
	import { buttonVariants, type ButtonVariants } from "./button-variants.js";

	interface Props extends HTMLButtonAttributes {
		class?: string;
		children?: Snippet;
		variant?: ButtonVariants["variant"];
		size?: ButtonVariants["size"];
	}

	let { class: className, children, variant, size, ...restProps }: Props = $props();
</script>

<button class={cn(buttonVariants({ variant, size }), className)} {...restProps}>
	{@render children?.()}
</button>
