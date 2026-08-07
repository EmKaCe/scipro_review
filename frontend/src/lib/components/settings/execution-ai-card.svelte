<script lang="ts">
	import Loader from "@lucide/svelte/icons/loader";
	import Save from "@lucide/svelte/icons/save";
	import { addToast } from "$lib/stores/toast.svelte.js";
	import { fetchSettings, saveSettings } from "$lib/services/settings-api.js";
	import type { AppSettings } from "$lib/services/settings-api.js";

	let loading = $state(true);
	let saving = $state(false);
	let form = $state<AppSettings | null>(null);
	let loadError = $state<string | null>(null);

	$effect(() => {
		void (async () => {
			try {
				form = await fetchSettings();
				loadError = null;
			} catch (e) {
				loadError = e instanceof Error ? e.message : "Failed to load settings";
			} finally {
				loading = false;
			}
		})();
	});

	async function handleSave() {
		if (!form || saving) return;
		saving = true;
		try {
			form = await saveSettings(form);
			addToast("success", "Settings saved", 3000);
		} catch (e) {
			addToast("error", e instanceof Error ? e.message : "Failed to save settings", 4000);
		} finally {
			saving = false;
		}
	}
</script>

<div class="overflow-hidden rounded-[var(--radius)] border border-border bg-card shadow-sm">
	<div class="p-5 pb-3">
		<h2 class="text-base font-semibold tracking-tight">Execution &amp; AI</h2>
		<p class="mt-1 text-sm text-muted-foreground">
			Executor timeouts and the LLM provider used for analysis. Saved to data/settings.yaml on
			the server.
		</p>
	</div>

	{#if loading}
		<div class="flex items-center gap-2 px-5 pb-5 text-sm text-muted-foreground">
			<Loader size={14} class="animate-spin" /> Loading settings…
		</div>
	{:else if loadError || !form}
		<div class="px-5 pb-5">
			<p class="text-sm text-error">{loadError ?? "Settings unavailable"}</p>
		</div>
	{:else}
		<div class="space-y-4 px-5 pb-5">
			<!-- Executor timeouts -->
			<div>
				<h3
					class="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase"
				>
					Executor timeouts
				</h3>
				<div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
					<label class="block">
						<span class="mb-1 block text-xs text-muted-foreground">Request (ms)</span>
						<input
							type="number"
							min="1000"
							step="1000"
							class="h-9 w-full rounded-[var(--radius)] border border-border bg-background px-2 text-sm text-foreground"
							bind:value={form.executor.requestTimeoutMs}
						/>
					</label>
					<label class="block">
						<span class="mb-1 block text-xs text-muted-foreground"
							>Per notebook (ms)</span
						>
						<input
							type="number"
							min="1000"
							step="1000"
							class="h-9 w-full rounded-[var(--radius)] border border-border bg-background px-2 text-sm text-foreground"
							bind:value={form.executor.notebookTimeoutMs}
						/>
					</label>
					<label class="block">
						<span class="mb-1 block text-xs text-muted-foreground">Per cell (s)</span>
						<input
							type="number"
							min="1"
							step="1"
							class="h-9 w-full rounded-[var(--radius)] border border-border bg-background px-2 text-sm text-foreground"
							bind:value={form.executor.cellTimeoutS}
						/>
					</label>
				</div>
				<p class="mt-2 text-xs text-muted-foreground">
					Batches execute one notebook at a time; each notebook gets the per-notebook
					budget. Raise these on slower machines.
				</p>
			</div>

			<!-- LLM provider -->
			<div>
				<h3
					class="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase"
				>
					LLM provider
				</h3>
				<div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
					<label class="block sm:col-span-2">
						<span class="mb-1 block text-xs text-muted-foreground">Base URL</span>
						<input
							type="url"
							class="h-9 w-full rounded-[var(--radius)] border border-border bg-background px-2 text-sm text-foreground"
							bind:value={form.llm.baseUrl}
						/>
					</label>
					<label class="block">
						<span class="mb-1 block text-xs text-muted-foreground">Timeout (ms)</span>
						<input
							type="number"
							min="1000"
							step="1000"
							class="h-9 w-full rounded-[var(--radius)] border border-border bg-background px-2 text-sm text-foreground"
							bind:value={form.llm.timeoutMs}
						/>
					</label>
					<label class="block sm:col-span-3">
						<span class="mb-1 block text-xs text-muted-foreground">Model</span>
						<input
							type="text"
							class="h-9 w-full rounded-[var(--radius)] border border-border bg-background px-2 text-sm text-foreground"
							bind:value={form.llm.model}
						/>
					</label>
				</div>
				<p class="mt-2 text-xs text-muted-foreground">
					The API key stays in the server environment — it is never read or written
					through these settings.
				</p>
			</div>

			<div class="flex justify-end">
				<button
					onclick={handleSave}
					disabled={saving}
					class="flex h-9 items-center gap-2 rounded-[var(--radius)] bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity disabled:opacity-50"
				>
					{#if saving}
						<Loader size={14} class="animate-spin" />
						Saving…
					{:else}
						<Save size={14} />
						Save settings
					{/if}
				</button>
			</div>
		</div>
	{/if}
</div>
