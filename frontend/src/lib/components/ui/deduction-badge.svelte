<script lang="ts">
	/** Props for the deduction badge showing a negative point value. */
	interface Props {
		/** Deduction amount in points. */
		value: number;
		/** Additional CSS class names. */
		class?: string;
	}

	let { value, class: className = "" }: Props = $props();
</script>

<span class="deduction-badge {className}">
	−{value.toFixed(1)} pts
</span>

<style>
	.deduction-badge {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		font-size: 0.75rem;
		font-weight: 500;
		color: var(--destructive);
		margin-left: 0.5rem;
	}
</style>
