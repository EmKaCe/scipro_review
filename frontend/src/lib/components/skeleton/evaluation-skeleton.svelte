<script lang="ts">
	import SkeletonPulse from "$lib/components/ui/skeleton-pulse.svelte";
</script>

<div class="space-y-8">
	<!-- Metadata skeleton -->
	<div class="space-y-4 rounded-[var(--radius)] border border-border bg-card p-6">
		<SkeletonPulse class="h-8 w-32" />
		<SkeletonPulse class="h-4 w-48" />
		<div class="mt-4 flex items-center gap-4">
			<SkeletonPulse class="h-4 w-24" />
			<SkeletonPulse class="h-4 w-24" />
		</div>
		<!-- Grade card skeleton -->
		<div class="mt-4 flex items-center gap-4 rounded-[var(--radius)] border border-border p-4">
			<SkeletonPulse class="h-12 w-16" />
			<div class="space-y-2">
				<SkeletonPulse class="h-4 w-24" />
				<SkeletonPulse class="h-3 w-16" />
			</div>
		</div>
	</div>

	<!-- Report skeleton -->
	<div class="space-y-6">
		<!-- Section 1 -->
		<div class="space-y-4">
			<SkeletonPulse class="h-6 w-48" />
			<SkeletonPulse class="h-4 w-full" />
			<SkeletonPulse class="h-4 w-5/6" />
			<SkeletonPulse class="h-4 w-4/5" />
			<SkeletonPulse class="h-4 w-full" />
			<SkeletonPulse class="h-4 w-2/3" />
		</div>
		<!-- Section 2 -->
		<div class="space-y-4">
			<SkeletonPulse class="h-6 w-56" />
			<SkeletonPulse class="h-4 w-full" />
			<SkeletonPulse class="h-4 w-3/4" />
			<SkeletonPulse class="h-4 w-5/6" />
			<SkeletonPulse class="h-4 w-full" />
		</div>
		<!-- Section 3 -->
		<div class="space-y-4">
			<SkeletonPulse class="h-6 w-40" />
			<SkeletonPulse class="h-4 w-full" />
			<SkeletonPulse class="h-4 w-4/5" />
			<SkeletonPulse class="h-4 w-full" />
			<SkeletonPulse class="h-4 w-1/2" />
		</div>
	</div>

	<!-- Action bar skeleton -->
	<div class="flex items-center gap-2 border-t border-border pt-4">
		<SkeletonPulse class="h-9 w-32" />
		<SkeletonPulse class="h-9 w-28" />
		<SkeletonPulse class="h-9 w-28" />
	</div>
</div>
