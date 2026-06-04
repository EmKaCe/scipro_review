<script lang="ts">
	import type { Snippet } from "svelte";

	/** Props for the sticky review footer with optional snippet content. */
	interface Props {
		/** Snippet rendered inside the footer content area. */
		children?: Snippet;
		/** Additional CSS class names. */
		class?: string;
	}

	let { children, class: className = "" }: Props = $props();
</script>

<footer
	class="fixed right-0 bottom-0 left-0 z-30 border-t border-border bg-background/80 backdrop-blur-md {className}"
>
	<div class="px-6 py-2 md:px-10 lg:px-16 xl:px-24">
		{@render children?.()}
	</div>
</footer>
