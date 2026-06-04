<script lang="ts">
	import type { MainPoint } from "$lib/types/criteria.js";
	import RubricItem from "$lib/components/rubric-item.svelte";

	/** Props for a sentiment section (positive/neutral/negative) within a rubric category. */
	interface Props {
		/** Checklist point groups to render. */
		points: readonly MainPoint[];
		/** Sentiment of this section, controlling border color and label. */
		sentiment: "positive" | "neutral" | "negative";
		/** Whether the section is in read-only mode (disables all interactions). */
		disabled?: boolean;
		/** Callback when a checkbox is toggled. Key is the sub-point text. */
		onToggleCheckbox: (key: string, checked: boolean) => void;
		/** Callback when a comment text is updated. */
		onUpdateComment: (key: string, value: string) => void;
		/** Callback when a deduction value is updated. */
		onUpdateDeduction: (key: string, value: number) => void;
		/** Current comment values keyed by sub-point text. */
		comments: Record<string, string>;
		/** Current deduction values keyed by sub-point text. */
		deductions: Record<string, number>;
		/** Set of checked sub-point texts. */
		checkedItems: Set<string>;
	}

	let {
		points,
		sentiment,
		disabled = false,
		onToggleCheckbox,
		onUpdateComment,
		onUpdateDeduction,
		comments,
		deductions,
		checkedItems,
	}: Props = $props();

	const borderColor = $derived(
		sentiment === "positive"
			? "var(--success)"
			: sentiment === "negative"
				? "var(--destructive)"
				: "var(--border)",
	);

	const label = $derived(
		sentiment === "positive" ? "Positive" : sentiment === "negative" ? "Negative" : "Neutral",
	);
</script>

<div class="space-y-3">
	<h4
		class="border-l-2 pl-3 text-xs font-semibold tracking-wider text-muted-foreground uppercase"
		style:border-color={borderColor}
	>
		{label}
	</h4>
	<div class="space-y-4 pl-3" style:border-left="2px solid {borderColor}">
		{#each points as point (point.main_point)}
			<div class="space-y-2">
				{#if point.main_point}
					<p class="text-sm font-medium text-foreground">{point.main_point}</p>
				{/if}
				<div class="space-y-2">
					{#each point.sub_points as item (item.text)}
						{@const itemKey = item.text}
						<RubricItem
							{item}
							{itemKey}
							checked={checkedItems.has(itemKey)}
							{disabled}
							onToggle={onToggleCheckbox}
							{onUpdateComment}
							{onUpdateDeduction}
							commentValue={comments[itemKey] ?? ""}
							deductionValue={deductions[itemKey] ?? 0}
						/>
					{/each}
				</div>
			</div>
		{/each}
	</div>
</div>
