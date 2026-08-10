<script lang="ts">
	import type { GradeDimension } from "$lib/types/grading.js";
	import { getGradeBarColor } from "$lib/utils.js";

	/** Props for a single grading dimension range slider. */
	interface Props {
		/** The grading dimension definition. */
		dimension: GradeDimension;
		/** Current score value for this dimension. */
		value: number;
		/** Whether the slider is in read-only mode (disables interaction). */
		disabled?: boolean;
		/** Callback when the slider value changes, receiving dimension key and new value. */
		onChange: (key: string, value: number) => void;
	}

	let { dimension, value, disabled = false, onChange }: Props = $props();

	let contribution = $derived(value * dimension.weight);
	let maxContribution = $derived(dimension.max_points * dimension.weight);
	let scorePct = $derived(Math.round((value / dimension.max_points) * 100));
	let barColor = $derived(getGradeBarColor(scorePct));

	function handleInput(e: Event) {
		const target = e.target as HTMLInputElement;
		onChange(dimension.key, parseFloat(target.value));
	}
</script>

<div>
	<div class="mb-1.5 flex items-center justify-between">
		<div class="flex min-w-0 items-center gap-1.5">
			<span class="truncate text-xs font-medium text-foreground">{dimension.title}</span>
		</div>
		<div class="flex shrink-0 items-center gap-2">
			<span class="text-xs tabular-nums">
				<span class="font-medium text-foreground">{value.toFixed(1)}</span><span
					class="text-muted-foreground">/{dimension.max_points.toFixed(0)}</span
				>
			</span>
			<span class="text-xs text-muted-foreground">→</span>
			<span class="text-xs font-medium tabular-nums" style:color={barColor}
				>{contribution.toFixed(0)}<span class="font-normal text-muted-foreground"
					>/{maxContribution}</span
				></span
			>
		</div>
	</div>
	<input
		type="range"
		min="0"
		max={dimension.max_points}
		step="0.5"
		{value}
		{disabled}
		oninput={handleInput}
		class="grade-slider w-full {disabled ? 'opacity-70' : ''}"
		aria-label={dimension.title}
	/>
</div>

<style>
	.grade-slider {
		-webkit-appearance: none;
		appearance: none;
		height: 6px;
		border-radius: 999px;
		background: var(--border);
		outline: none;
	}

	.grade-slider::-webkit-slider-thumb {
		-webkit-appearance: none;
		appearance: none;
		width: 18px;
		height: 18px;
		border-radius: 50%;
		background: var(--primary);
		cursor: pointer;
		border: 2px solid var(--border);
		box-shadow: 0 1px 3px oklch(0 0 0 / 0.2);
		transition:
			transform 0.15s ease,
			box-shadow 0.15s ease;
	}

	.grade-slider::-webkit-slider-thumb:hover {
		transform: scale(1.15);
		box-shadow: 0 2px 6px oklch(0 0 0 / 0.3);
	}

	.grade-slider::-webkit-slider-thumb:active {
		transform: scale(1.05);
		box-shadow: 0 1px 2px oklch(0 0 0 / 0.2);
	}

	.grade-slider:focus-visible::-webkit-slider-thumb {
		box-shadow:
			0 0 0 3px var(--background),
			0 0 0 5px var(--ring);
	}

	.grade-slider:focus-visible::-moz-range-thumb {
		box-shadow:
			0 0 0 3px var(--background),
			0 0 0 5px var(--ring);
	}
</style>
