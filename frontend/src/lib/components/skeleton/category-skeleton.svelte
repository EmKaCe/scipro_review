<script lang="ts">
	import SkeletonPulse from "$lib/components/ui/skeleton-pulse.svelte";
</script>

<div class="overflow-hidden rounded-[var(--radius)] border border-border bg-card">
	<div class="flex items-center justify-between border-b border-border p-4">
		<div class="space-y-2">
			<SkeletonPulse class="h-6 w-48" />
			<SkeletonPulse class="h-4 w-24" />
		</div>
		<SkeletonPulse class="h-8 w-8 rounded-[var(--radius)]" />
	</div>
	<div class="space-y-3 p-4">
		<SkeletonPulse class="h-4 w-full" />
		<SkeletonPulse class="h-4 w-3/4" />
		<SkeletonPulse class="h-4 w-5/6" />
		<SkeletonPulse class="h-4 w-2/3" />
		<SkeletonPulse class="h-4 w-full" />
		<SkeletonPulse class="h-4 w-1/2" />
	</div>
</div>
