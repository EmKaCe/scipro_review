<script lang="ts">
	import Calendar from "@lucide/svelte/icons/calendar";

	/** Props for the evaluation metadata header showing student info and grades. */
	interface Props {
		/** Student identifier. */
		studentId: string;
		/** Assignment name. */
		assignment: string;
		/** ISO date string of the evaluation. */
		date: string;
		/** Final score as a percentage (0–100). */
		percentage: number;
		/** German university grade (e.g. "1.3"). */
		germanGrade: string;
		/** US letter grade equivalent (e.g. "A"). */
		usGrade: string;
		/** Whether to show the grading breakdown section. */
		showGrading: boolean;
		/** Additional CSS class names. */
		class?: string;
	}

	let {
		studentId,
		assignment,
		date,
		percentage,
		germanGrade,
		usGrade,
		showGrading,
		class: className = "",
	}: Props = $props();
</script>

<div
	class="evaluation-metadata rounded-[var(--radius)] border border-border bg-card p-6 shadow-sm {className}"
>
	<div class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
		<div class="space-y-1">
			<div class="flex items-baseline gap-2">
				<span class="text-xs font-medium tracking-wider text-muted-foreground uppercase"
					>Student</span
				>
			</div>
			<p class="text-2xl font-bold tracking-tight">{studentId}</p>
			<p class="text-sm text-muted-foreground">{assignment}</p>
			<div class="mt-3 flex items-center gap-3 text-xs text-muted-foreground">
				<span class="flex items-center gap-1">
					<Calendar size={12} />
					{date}
				</span>
			</div>
		</div>

		{#if showGrading}
			<div
				class="flex shrink-0 items-center gap-4 rounded-[var(--radius)] border border-border bg-background p-4"
			>
				<div class="text-right">
					<div class="text-3xl font-bold tracking-tight text-primary">
						{percentage.toFixed(1)}%
					</div>
					<div class="mt-0.5 text-xs text-muted-foreground">of 100 pts</div>
				</div>
				<div class="h-10 w-px bg-border"></div>
				<div class="text-right">
					<div class="text-2xl font-bold tracking-tight">{germanGrade}</div>
					<div
						class="mt-0.5 inline-flex items-center rounded-full border border-border bg-background px-2 py-0.5 text-xs font-medium text-muted-foreground"
					>
						{usGrade}
					</div>
				</div>
			</div>
		{/if}
	</div>
</div>
