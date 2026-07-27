<script lang="ts">
	import type { GradeDimension, GradingInputs, GradeResult } from "$lib/types/index.js";
	import {
		getGradeBarColor,
		germanGradeFromPercentage,
		isNearGradeBoundary,
	} from "$lib/utils.js";
	import GradeSlider from "$lib/components/grade-slider.svelte";
	import AlertTriangle from "@lucide/svelte/icons/alert-triangle";

	/** Props for the grading sidebar with dimension sliders and grade summary. */
	interface Props {
		/** Grading dimension definitions from config. */
		dimensions: readonly GradeDimension[];
		/** Current grading input values. */
		grading: GradingInputs;
		/** Computed grade result (null if not yet calculated). */
		gradeResult: GradeResult | null;
		/** Total deduction points. */
		totalDeductions: number;
		/** Whether the grading is in read-only mode (disables sliders). */
		disabled?: boolean;
		/** Callback when a dimension's score value changes. */
		onUpdateDimension: (key: string, value: number) => void;
	}

	let {
		dimensions,
		grading,
		gradeResult,
		totalDeductions,
		disabled = false,
		onUpdateDimension,
	}: Props = $props();

	let percentage = $derived(gradeResult?.percentage ?? 0);
	let gradeInfo = $derived(germanGradeFromPercentage(percentage));
	let boundaryInfo = $derived(isNearGradeBoundary(percentage));

	const shortLabels = $derived.by(() => {
		const map: Record<string, string> = {};
		for (const dim of dimensions) {
			// Derive short label from title: take first word, or first 8 chars
			const short = dim.title.split(/\s+/)[0] ?? dim.title;
			map[dim.key] = short.length > 10 ? dim.title.slice(0, 8) + "…" : short;
		}
		return map;
	});
</script>

<div class="space-y-5 rounded-[var(--radius)] border border-border bg-card p-3 sm:p-5">
	<h3 class="text-sm font-semibold tracking-tight">Grading</h3>

	<div class="space-y-4">
		{#each dimensions as dim (dim.key)}
			{@const dimValue = grading[dim.key as keyof GradingInputs] ?? 0}
			<GradeSlider dimension={dim} value={dimValue} {disabled} onChange={onUpdateDimension} />
		{/each}
	</div>

	<!-- Result Card -->
	<div class="space-y-3 border-t border-border pt-4">
		<div class="flex items-baseline justify-between">
			<span class="text-2xl font-bold tracking-tight tabular-nums"
				>{gradeResult
					? `${gradeResult.total_weighted.toFixed(1)} / ${gradeResult.total_weighted_max}`
					: "—"}</span
			>
			<div class="flex items-center gap-2">
				<span class="text-lg font-semibold">{gradeInfo.grade}</span>
				<span
					class="inline-flex items-center rounded-full border border-border bg-background px-2 py-0.5 text-xs font-medium text-muted-foreground"
				>
					{gradeInfo.us}
				</span>
			</div>
		</div>

		{#if boundaryInfo.near}
			<p class="flex items-center gap-1 text-xs text-warning">
				<AlertTriangle size={12} />
				Close to grade boundary <span>{boundaryInfo.target}</span>
			</p>
		{/if}

		<!-- Per-dimension breakdown -->
		<div class="space-y-1.5 pt-1">
			{#each dimensions as dim (dim.key)}
				{@const dimValue = grading[dim.key as keyof GradingInputs] ?? 0}
				{@const contribution = dimValue * dim.weight}
				{@const maxC = dim.max_points * dim.weight}
				{@const pct = maxC > 0 ? (contribution / maxC) * 100 : 0}
				{@const scorePct = Math.round((dimValue / dim.max_points) * 100)}
				{@const barColor = getGradeBarColor(scorePct)}
				<div class="flex flex-col gap-0.5">
					<div class="flex items-center justify-between text-xs">
						<span class="truncate text-muted-foreground"
							>{shortLabels[dim.key] || dim.title}</span
						>
						<div class="ml-2 flex shrink-0 items-center gap-1.5 tabular-nums">
							<span class="text-muted-foreground"
								>{dimValue.toFixed(1)}/{dim.max_points.toFixed(0)}</span
							>
							<span class="text-muted-foreground">→</span>
							<span class="font-medium" style:color={barColor}
								>{contribution.toFixed(0)}/{maxC}</span
							>
						</div>
					</div>
					<div class="h-1.5 w-full overflow-hidden rounded-full bg-border">
						<div
							class="h-full rounded-full transition-all"
							style:width="{pct}%"
							style:background={barColor}
						></div>
					</div>
				</div>
			{/each}
		</div>

		{#if totalDeductions > 0}
			<div
				class="flex items-center justify-between border-t border-border pt-2 text-xs text-muted-foreground"
			>
				<span>Total deductions</span>
				<span class="font-medium text-foreground">-{totalDeductions.toFixed(1)}</span>
			</div>
		{/if}
	</div>
</div>
