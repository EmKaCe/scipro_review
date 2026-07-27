<script lang="ts">
	import type { SubPoint } from "$lib/types/criteria.js";
	import CustomCheckbox from "$lib/components/ui/custom-checkbox.svelte";

	/** Props for a single rubric checklist item with optional comment and deduction. */
	interface Props {
		/** The rubric sub-point data. */
		item: SubPoint;
		/** Unique key identifying this item within its category (the sub-point text). */
		itemKey: string;
		/** Whether the item's checkbox is currently checked. */
		checked: boolean;
		/** Whether the item is in read-only mode (disables all interactions). */
		disabled?: boolean;
		/** Callback when the checkbox is toggled. */
		onToggle: (key: string, checked: boolean) => void;
		/** Callback when the comment text is updated (optional — only if item has comment). */
		onUpdateComment?: (key: string, value: string) => void;
		/** Callback when the deduction value is updated (optional — only if item has deduction). */
		onUpdateDeduction?: (key: string, value: number) => void;
		/** Current comment text value. */
		commentValue?: string;
		/** Current deduction point value. */
		deductionValue?: number;
	}

	let {
		item,
		itemKey,
		checked,
		disabled = false,
		onToggle,
		onUpdateComment,
		onUpdateDeduction,
		commentValue = "",
		deductionValue = 0,
	}: Props = $props();

	function handleCheckboxChange(e: Event) {
		const target = e.target as HTMLInputElement;
		onToggle(itemKey, target.checked);
	}
</script>

<div class="space-y-2">
	<label
		class="group flex items-start gap-2.5 {disabled
			? 'cursor-default opacity-70'
			: 'cursor-pointer'}"
	>
		<CustomCheckbox
			{checked}
			onchange={handleCheckboxChange}
			{disabled}
			class="mt-0.5 shrink-0"
		/>
		<span
			class="text-sm leading-relaxed text-foreground {disabled
				? ''
				: 'transition-colors group-hover:text-primary'}"
		>
			{item.text}
		</span>
	</label>

	{#if checked && item.comment}
		<div class="ml-6">
			<textarea
				placeholder="Add a comment..."
				aria-label="Comment for {item.text}"
				bind:value={commentValue}
				{disabled}
				oninput={(e) => onUpdateComment?.(itemKey, (e.target as HTMLTextAreaElement).value)}
				class="min-h-[3rem] w-full resize-y rounded-[var(--radius)] border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:ring-2 focus:ring-ring focus:outline-none {disabled
					? 'opacity-70'
					: ''}"></textarea>
		</div>
	{/if}

	{#if checked && item.point_deduction}
		<div class="ml-6 flex items-center gap-2">
			<span class="text-xs text-muted-foreground">Deduction:</span>
			<input
				type="number"
				min="0"
				step="0.5"
				value={deductionValue}
				{disabled}
				aria-label="Deduction for {item.text}"
				oninput={(e) =>
					onUpdateDeduction?.(
						itemKey,
						parseFloat((e.target as HTMLInputElement).value) || 0,
					)}
				class="h-8 w-20 rounded-[var(--radius)] border border-border bg-background px-2 text-sm text-foreground focus:ring-2 focus:ring-ring focus:outline-none {disabled
					? 'opacity-70'
					: ''}"
			/>
		</div>
	{/if}
</div>
