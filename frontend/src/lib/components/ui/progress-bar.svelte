<script lang="ts">
	/** Props for the horizontal progress bar component. */
	interface Props {
		/** Current progress value. */
		value: number;
		/** Maximum value representing 100% (default: 100). */
		max?: number;
		/** Additional CSS class names. */
		class?: string;
		/** Bar height variant — "sm" for thin, "md" for thicker. */
		size?: "sm" | "md";
	}

	let { value, max = 100, class: className = "", size = "sm" }: Props = $props();

	let percentage = $derived(Math.min(Math.max((value / max) * 100, 0), 100));
</script>

<div
	class="w-24 overflow-hidden rounded-full bg-muted {size === 'sm' ? 'h-1.5' : 'h-2'} {className}"
	role="progressbar"
	aria-valuenow={percentage}
	aria-valuemin={0}
	aria-valuemax={100}
>
	<div
		class="h-full rounded-full bg-primary transition-all duration-500"
		style:width="{percentage}%"
	></div>
</div>
