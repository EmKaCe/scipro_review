<script lang="ts">
	/** Props for the grade badge displaying German and US grade equivalents. */
	interface Props {
		/** German university grade (e.g. "1.3"). */
		grade: string;
		/** US letter grade equivalent (e.g. "A"). */
		usGrade: string;
		/** Additional CSS class names. */
		class?: string;
	}

	let { grade, usGrade, class: className = "" }: Props = $props();
</script>

<div class="flex items-center gap-2 {className}">
	<span class="whitespace-nowrap text-foreground">{grade}</span>
	<span
		class="inline-flex items-center rounded-full border border-border bg-background px-2 py-0.5 text-xs font-medium text-muted-foreground"
	>
		{usGrade}
	</span>
</div>
