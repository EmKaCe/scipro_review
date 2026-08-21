<script lang="ts">
	import AlertTriangle from "@lucide/svelte/icons/alert-triangle";
	import Trash2 from "@lucide/svelte/icons/trash-2";
	import ConfirmationDialog from "$lib/components/confirmation-dialog.svelte";
	import { reviewStore } from "$lib/stores/review.svelte.js";
	import { addToast } from "$lib/stores/toast.svelte.js";

	let showDeleteDialog = $state(false);

	async function handleDelete() {
		try {
			await reviewStore.clearAllData();
			addToast("success", "All data deleted");
		} catch (error) {
			addToast("error", "Failed to delete data");
			console.error("[Settings] Delete all failed:", error);
		}
		showDeleteDialog = false;
	}
</script>

<div
	class="danger-zone overflow-hidden rounded-[var(--radius)] border border-destructive bg-card shadow-sm"
	role="group"
	aria-label="Danger zone"
>
	<div class="p-5 pb-3">
		<div class="flex items-center gap-2">
			<AlertTriangle size={16} class="text-destructive" />
			<h2 class="text-base font-semibold tracking-tight text-destructive">Danger Zone</h2>
		</div>
	</div>
	<div class="space-y-4 px-5 pb-5">
		<p class="text-sm leading-relaxed text-muted-foreground">
			This action cannot be undone. All reviews, sessions, and preferences will be permanently
			deleted from your browser.
		</p>
		<button
			onclick={() => (showDeleteDialog = true)}
			class="flex w-full items-center justify-center gap-2 rounded-[var(--radius)] bg-destructive text-sm font-medium text-white transition-colors hover:opacity-90"
			style="height: 2.25rem;"
		>
			<Trash2 size={14} />
			Delete All Data
		</button>
	</div>
</div>

<ConfirmationDialog
	open={showDeleteDialog}
	title="Delete All Data"
	message="This will permanently delete <strong>ALL</strong> saved reviews, sessions, and preferences. This cannot be undone."
	confirmLabel="Delete All"
	variant="danger"
	requireTyping="DELETE"
	onconfirm={handleDelete}
	oncancel={() => (showDeleteDialog = false)}
/>
