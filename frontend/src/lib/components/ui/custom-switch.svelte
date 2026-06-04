<script lang="ts">
	/** Props for the custom toggle switch component. */
	interface Props {
		/** Whether the switch is on (bindable). */
		checked?: boolean;
		/** Callback when the switch is toggled. */
		onToggle?: () => void;
		/** Accessible label text displayed next to the switch. */
		label?: string;
		/** Additional CSS class names. */
		class?: string;
	}

	let { checked = $bindable(false), onToggle, label, class: className = "" }: Props = $props();

	function handleClick() {
		checked = !checked;
		onToggle?.();
	}
</script>

<div class="flex items-center gap-2 {className}">
	<button
		class="custom-switch"
		role="switch"
		aria-checked={checked}
		aria-label={label || "Toggle"}
		data-state={checked ? "checked" : "unchecked"}
		onclick={handleClick}
		type="button"
	>
		<span class="switch-thumb"></span>
	</button>
	{#if label}
		<span class="text-sm text-muted-foreground select-none">{label}</span>
	{/if}
</div>

<style>
	.custom-switch {
		position: relative;
		width: 2.75rem;
		height: 1.5rem;
		border-radius: 9999px;
		background: var(--border);
		border: none;
		cursor: pointer;
		transition: background-color 0.2s;
		padding: 0;
		flex-shrink: 0;
	}

	.custom-switch[data-state="checked"] {
		background-color: var(--primary);
	}

	.switch-thumb {
		position: absolute;
		left: 0.125rem;
		top: 0.125rem;
		width: 1.25rem;
		height: 1.25rem;
		border-radius: 9999px;
		background: white;
		box-shadow: 0 1px 2px oklch(0 0 0 / 0.1);
		transition: transform 0.2s ease-out;
		transform: translateX(0);
	}

	.custom-switch[data-state="checked"] .switch-thumb {
		transform: translateX(1.25rem);
	}

	.custom-switch:focus-visible {
		outline: 2px solid var(--ring);
		outline-offset: 2px;
	}
</style>
