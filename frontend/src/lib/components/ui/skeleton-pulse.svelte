<script lang="ts">
	/** Props for the animated skeleton pulse placeholder component. */
	interface Props {
		/** Additional CSS class names. */
		class?: string;
		/** Inline styles (for special background colors like code blocks). */
		style?: string;
	}

	let { class: className = "", style = "" }: Props = $props();
</script>

<div class="skeleton-pulse {className}" {style}></div>

<style>
	.skeleton-pulse {
		animation: skeleton-pulse 2s ease-in-out infinite;
		background: var(--skeleton);
		border-radius: calc(var(--radius) / 2);
	}

	@keyframes skeleton-pulse {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.4;
		}
	}
</style>
