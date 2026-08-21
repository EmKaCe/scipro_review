<script lang="ts">
	import type { HTMLInputAttributes } from "svelte/elements";

	/** Props for the custom-styled checkbox input component. */
	interface Props extends Omit<HTMLInputAttributes, "onchange"> {
		/** Whether the checkbox is checked (bindable). */
		checked?: boolean;
		/** Callback when the checkbox state changes. */
		onchange?: (e: Event) => void;
		/** Additional CSS class names. */
		class?: string;
	}

	let { checked = $bindable(false), onchange, class: className = "", ...rest }: Props = $props();
</script>

<input type="checkbox" bind:checked {onchange} class="custom-checkbox {className}" {...rest} />

<style>
	.custom-checkbox {
		appearance: none;
		width: 1rem;
		height: 1rem;
		border: 1.5px solid var(--border);
		border-radius: 0.25rem;
		background: var(--card);
		cursor: pointer;
		position: relative;
		transition: all 0.15s;
	}

	.custom-checkbox:checked {
		background: var(--primary);
		border-color: var(--primary);
	}

	.custom-checkbox:checked::after {
		content: "";
		position: absolute;
		left: 50%;
		top: 45%;
		width: 5px;
		height: 9px;
		border: solid white;
		border-width: 0 2px 2px 0;
		transform: translate(-50%, -50%) rotate(45deg);
	}

	.custom-checkbox:focus-visible {
		outline: 2px solid var(--ring);
		outline-offset: 2px;
	}
</style>
