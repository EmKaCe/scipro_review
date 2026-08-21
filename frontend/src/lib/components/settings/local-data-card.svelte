<script lang="ts">
	import Database from "@lucide/svelte/icons/database";
	import Download from "@lucide/svelte/icons/download";
	import Upload from "@lucide/svelte/icons/upload";
	import Trash2 from "@lucide/svelte/icons/trash-2";
	import { addToast } from "$lib/stores/toast.svelte.js";
	import { Button } from "$lib/components/ui/button/index.js";
	import {
		clearAllReviews,
		exportAll,
		importAll,
		listReviews,
		listSemesters,
		type DbExport,
	} from "$lib/services/db.js";
	import { downloadFile } from "$lib/services/session-persistence.js";

	// Local-data management for the static/student build only. Reviews live in
	// IndexedDB on this device; this card backs them up, restores them, or
	// clears them. No server, no teacher-mode concept.

	let summary = $state<{ reviews: number; semesters: string[] } | null>(null);
	let busy = $state(false);
	let confirmingClear = $state(false);
	let fileInput = $state<HTMLInputElement | null>(null);

	async function refreshSummary() {
		try {
			const [reviews, semesters] = await Promise.all([listReviews(), listSemesters()]);
			summary = { reviews: reviews.length, semesters };
		} catch (e) {
			addToast("error", e instanceof Error ? e.message : "Could not read local reviews");
		}
	}

	$effect(() => {
		void refreshSummary();
	});

	async function handleExport() {
		if (busy) return;
		busy = true;
		try {
			const data = await exportAll();
			const stamp = new Date().toISOString().slice(0, 10);
			downloadFile(
				JSON.stringify(data, null, 2),
				`scipro-reviews-${stamp}.json`,
				"application/json",
			);
			addToast(
				"success",
				data.reviews.length === 0
					? "No reviews to back up yet"
					: `Backed up ${data.reviews.length} review(s)`,
			);
		} catch (e) {
			addToast("error", e instanceof Error ? e.message : "Export failed");
		} finally {
			busy = false;
		}
	}

	function pickImportFile() {
		if (busy) return;
		fileInput?.click();
	}

	async function handleImportFile(event: Event) {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];
		input.value = "";
		if (!file) return;
		busy = true;
		try {
			const parsed = JSON.parse(await file.text()) as Partial<DbExport>;
			if (!parsed || !Array.isArray(parsed.reviews)) {
				throw new Error("Not a SciPro backup file (missing reviews array)");
			}
			const result = await importAll(parsed as DbExport);
			await refreshSummary();
			addToast(
				"success",
				`Restored ${result.imported} review(s)` +
					(result.skipped ? `, ${result.skipped} skipped` : ""),
			);
		} catch (e) {
			addToast("error", e instanceof Error ? e.message : "Import failed");
		} finally {
			busy = false;
		}
	}

	async function handleClear() {
		if (busy) return;
		busy = true;
		try {
			await clearAllReviews();
			confirmingClear = false;
			await refreshSummary();
			addToast("success", "All local reviews cleared");
		} catch (e) {
			addToast("error", e instanceof Error ? e.message : "Clear failed");
		} finally {
			busy = false;
		}
	}
</script>

<div class="overflow-hidden rounded-[var(--radius)] border border-border bg-card shadow-sm">
	<div class="flex items-center gap-3 p-5 pb-3">
		<div
			class="flex h-10 w-10 items-center justify-center rounded-[var(--radius)] bg-primary/10"
		>
			<Database size={20} class="text-primary" />
		</div>
		<div>
			<h2 class="text-base font-semibold tracking-tight">Local data</h2>
			<p class="text-xs text-muted-foreground">Stored in this browser, on this device.</p>
		</div>
	</div>

	<div class="space-y-3 px-5 pb-5">
		<p class="text-sm text-muted-foreground">
			{summary ? `${summary.reviews} review(s)` : "…"}
			{#if summary && summary.semesters.length > 0}
				· {summary.semesters.join(", ")}
			{/if}
		</p>

		<div class="flex flex-wrap gap-2">
			<Button
				variant="outline"
				size="sm"
				onclick={handleExport}
				disabled={busy}
				title="Download all reviews as a JSON backup file"
			>
				<Download size={14} /> Back up
			</Button>
			<Button
				variant="outline"
				size="sm"
				onclick={pickImportFile}
				disabled={busy}
				title="Restore reviews from a backup file"
			>
				<Upload size={14} /> Restore
			</Button>
			{#if confirmingClear}
				<Button variant="destructive" size="sm" onclick={handleClear} disabled={busy}>
					<Trash2 size={14} /> Really clear?
				</Button>
				<Button
					variant="ghost"
					size="sm"
					onclick={() => (confirmingClear = false)}
					disabled={busy}
				>
					Cancel
				</Button>
			{:else}
				<Button
					variant="ghost"
					size="sm"
					onclick={() => (confirmingClear = true)}
					disabled={busy}
					title="Delete every locally stored review"
				>
					<Trash2 size={14} /> Clear all
				</Button>
			{/if}
		</div>
		<input
			bind:this={fileInput}
			type="file"
			accept="application/json,.json"
			class="hidden"
			onchange={handleImportFile}
			aria-label="Import local review backup"
		/>
	</div>
</div>
