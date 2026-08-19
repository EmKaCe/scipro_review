<script lang="ts">
	import ChevronDown from "@lucide/svelte/icons/chevron-down";

	interface AssignmentOption {
		id: string;
		label: string;
		disabled?: boolean;
	}

	interface Props {
		/** Assignment options to render — the component holds NO hardcoded defaults. */
		assignments: AssignmentOption[];
		/** Currently selected assignment ID. */
		selected?: string;
		/** Callback when assignment changes. */
		onChange?: (assignmentId: string) => void;
	}

	let { assignments, selected = "", onChange }: Props = $props();

	function handleChange(e: Event) {
		const target = e.currentTarget as HTMLSelectElement;
		onChange?.(target.value);
	}
</script>

<div class="assign-select-wrapper">
	<label for="assignment-select" class="sr-only">Assignment</label>
	<select id="assignment-select" class="assign-select" value={selected} onchange={handleChange}>
		{#if assignments.length === 0}
			<option value="" disabled hidden>No assignments configured</option>
		{:else}
			{#each assignments as asgn (asgn.id)}
				<option value={asgn.id} disabled={asgn.disabled}>{asgn.label}</option>
			{/each}
		{/if}
	</select>
	<span class="select-chevron"><ChevronDown size={14} /></span>
</div>

<style>
	.assign-select-wrapper {
		position: relative;
		flex: 0 0 360px;
	}
	.assign-select {
		width: 100%;
		height: 34px;
		padding: 0 32px 0 12px;
		border: 1px solid var(--input);
		border-radius: var(--radius-md);
		background: var(--bg);
		color: var(--fg);
		font-size: 13px;
		font-weight: 500;
		appearance: none;
		cursor: pointer;
		transition: border-color 0.15s;
	}
	.assign-select:focus {
		outline: none;
		border-color: var(--accent);
		box-shadow: 0 0 0 2px var(--accent-soft);
	}
	.assign-select option {
		padding: 6px 10px;
	}
	.assign-select option:disabled {
		color: var(--muted-foreground);
	}
	.select-chevron {
		position: absolute;
		right: 10px;
		top: 50%;
		transform: translateY(-50%);
		color: var(--muted-foreground);
		pointer-events: none;
	}

	/* ── Mobile: override fixed 360px width for narrow viewports ── */
	@media (max-width: 767px) {
		.assign-select-wrapper {
			flex: none;
			width: 100%;
		}
	}
</style>
