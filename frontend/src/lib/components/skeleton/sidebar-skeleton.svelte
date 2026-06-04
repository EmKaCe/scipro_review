<script lang="ts">
	import SkeletonPulse from "$lib/components/ui/skeleton-pulse.svelte";
</script>

<div class="space-y-4 rounded-[var(--radius)] border border-border bg-card p-5">
	<SkeletonPulse class="h-5 w-24" />
	<div class="space-y-3">
		<SkeletonPulse class="h-3 w-full" />
		<SkeletonPulse class="h-3 w-full" />
		<SkeletonPulse class="h-3 w-full" />
	</div>
	<SkeletonPulse class="mt-4 h-20 w-full rounded-[var(--radius)]" />
</div>
