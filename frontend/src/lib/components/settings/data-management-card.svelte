<script lang="ts">
	import Database from "@lucide/svelte/icons/database";
	import Download from "@lucide/svelte/icons/download";
	import Trash2 from "@lucide/svelte/icons/trash-2";
	import { reviewStore } from "$lib/stores/review.svelte.js";
	import { addToast } from "$lib/stores/toast.svelte.js";
	import { formatFileSize } from "$lib/utils.js";

	let storageSize = $state<string>("—");
	let reviewCount = $derived(reviewStore.saved_reviews.length);

	$effect(() => {
		// Estimate storage size from review count
		if (reviewCount > 0) {
			storageSize = `~${formatFileSize(reviewCount * 2048)}`;
		} else {
			storageSize = "0 B";
		}
	});

	async function clearStorage() {
		try {
			await reviewStore.clearAllData();
			addToast("success", "All data cleared");
		} catch (error) {
			addToast("error", "Failed to clear data");
			console.error("[Settings] Clear failed:", error);
		}
	}

	async function exportData() {
		try {
			await reviewStore.exportAllReviews();
			addToast("success", "Data exported");
		} catch (error) {
			addToast("error", "Failed to export data");
			console.error("[Settings] Export failed:", error);
		}
	}
</script>

<div class="overflow-hidden rounded-[var(--radius)] border border-border bg-card shadow-sm">
	<div class="p-5 pb-3">
		<h2 class="text-base font-semibold tracking-tight">Data Management</h2>
		<p class="mt-1 text-sm text-muted-foreground">Manage your local data and storage.</p>
	</div>
	<div class="space-y-4 px-5 pb-5">
		<div
			class="flex items-center justify-between rounded-[var(--radius)] border border-border bg-background p-3"
		>
			<div class="flex items-center gap-3">
				<Database size={18} class="text-muted-foreground" />
				<div>
					<p class="text-sm font-medium text-foreground">IndexedDB Storage</p>
					<p class="text-xs text-muted-foreground">
						{storageSize} · {reviewCount} review{reviewCount !== 1 ? "s" : ""}
					</p>
				</div>
			</div>
			<button
				onclick={clearStorage}
				class="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius)] px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10"
			>
				<Trash2 size={12} />
				Clear cache
			</button>
		</div>

		<div class="flex flex-col gap-2 sm:flex-row">
			<button
				onclick={exportData}
				class="flex flex-1 items-center justify-center gap-2 rounded-[var(--radius)] border border-border text-sm font-medium text-foreground transition-colors hover:bg-black/5 dark:hover:bg-white/10"
				style="height: 2.25rem;"
			>
				<Download size={14} />
				Export All Data
			</button>
		</div>
	</div>
</div>
