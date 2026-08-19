<script lang="ts">
	import Eye from "@lucide/svelte/icons/eye";
	import EyeOff from "@lucide/svelte/icons/eye-off";
	import Loader from "@lucide/svelte/icons/loader";
	import Save from "@lucide/svelte/icons/save";
	import { addToast } from "$lib/stores/toast.svelte.js";
	import {
		fetchModels,
		fetchSettings,
		saveApiKey,
		saveSettings,
	} from "$lib/services/settings-api.js";
	import type {
		AppSettings,
		ModelInfo,
	} from "$lib/services/settings-api.js";

	let loading = $state(true);
	let saving = $state(false);
	let form = $state<AppSettings | null>(null);
	let loadError = $state<string | null>(null);

	// Snapshot of the LLM endpoint/model at load, so a save that actually
	// changes them can surface a reload note (new endpoint/model applies on
	// the next LLM request, not to the already-held singleton).
	let baselineLlm = $state<{ baseUrl: string; model: string } | null>(null);
	let llmReloadNote = $state<string | null>(null);

	// Model dropdown state
	let models = $state<ModelInfo[]>([]);
	let modelsSource = $state<"live" | "static" | null>(null);
	let modelsFailed = $state(false);
	// True when the saved model is offered by the loaded list; otherwise a
	// synthetic option keeps the select from silently changing the value.
	let currentModelInList = $derived.by(() => {
		if (form === null) return false;
		const current = form.llm.model;
		return models.some((m) => m.id === current);
	});

	// API key state — the actual key is never fetched; GET only reports
	// whether one is configured, so the input always starts empty.
	let apiKeyInput = $state("");
	let apiKeyHasKey = $state(false);
	let apiKeyEditing = $state(false);
	let apiKeyVisible = $state(false);
	let savingApiKey = $state(false);

	$effect(() => {
		void (async () => {
			try {
				const settings = await fetchSettings();
				form = settings;
				baselineLlm = { baseUrl: settings.llm.baseUrl, model: settings.llm.model };
				apiKeyHasKey = settings.hasApiKey;
				apiKeyEditing = !settings.hasApiKey;
				loadError = null;
			} catch (e) {
				loadError = e instanceof Error ? e.message : "Failed to load settings";
			} finally {
				loading = false;
			}
		})();
	});

	$effect(() => {
		void (async () => {
			try {
				const result = await fetchModels();
				models = result.models;
				modelsSource = result.source === "live" ? "live" : "static";
				modelsFailed = false;
			} catch {
				models = [];
				modelsSource = null;
				modelsFailed = true;
			}
		})();
	});

	async function handleSave() {
		if (!form || saving) return;
		saving = true;
		try {
			form = await saveSettings(form);
			const endpointChanged =
				baselineLlm !== null &&
				(form.llm.baseUrl !== baselineLlm.baseUrl || form.llm.model !== baselineLlm.model);
			llmReloadNote = endpointChanged
				? "The new LLM endpoint/model takes effect on the next LLM request. If a grading run or copilot session already holds the old model, restart the app so the held client is rebuilt — the API key change applies immediately."
				: null;
			baselineLlm = { baseUrl: form.llm.baseUrl, model: form.llm.model };
			addToast("success", "Settings saved", 3000);
		} catch (e) {
			addToast("error", e instanceof Error ? e.message : "Failed to save settings", 4000);
		} finally {
			saving = false;
		}
	}

	/** 262_144 → "262K", 1_047_576 → "1M". */
	function formatContextTokens(tokens: number): string {
		if (tokens >= 1_000_000) {
			return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
		}
		return `${Math.round(tokens / 1000)}K`;
	}

	/** "qwen3-30b-a3b-instruct-2507 · 262K ctx · open-weight". */
	function formatModelOption(model: ModelInfo): string {
		const parts = [model.id, `${formatContextTokens(model.contextTokens)} ctx`];
		if (model.isOpenWeight) parts.push("open-weight");
		return parts.join(" · ");
	}

	function startApiKeyEdit() {
		apiKeyInput = "";
		apiKeyEditing = true;
		apiKeyVisible = false;
	}

	async function handleSaveApiKey() {
		if (savingApiKey) return;
		savingApiKey = true;
		try {
			await saveApiKey(apiKeyInput.trim());
			apiKeyInput = "";
			apiKeyHasKey = true;
			apiKeyEditing = false;
			apiKeyVisible = false;
			addToast("success", "API key saved", 3000);
		} catch (e) {
			addToast("error", e instanceof Error ? e.message : "Failed to save API key", 4000);
		} finally {
			savingApiKey = false;
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
						<div class="flex items-center gap-2">
							{#if modelsFailed || models.length === 0}
								<input
									type="text"
									class="h-9 w-full rounded-[var(--radius)] border border-border bg-background px-2 text-sm text-foreground"
									bind:value={form.llm.model}
								/>
							{:else}
								<select
									class="h-9 w-full rounded-[var(--radius)] border border-border bg-background px-2 text-sm text-foreground"
									bind:value={form.llm.model}
								>
									{#if !currentModelInList && form.llm.model.trim() !== ""}
										<option value={form.llm.model}>{form.llm.model}</option>
									{/if}
									{#each models as model (model.id)}
										<option value={model.id}>{formatModelOption(model)}</option>
									{/each}
								</select>
							{/if}
							{#if modelsSource === "live"}
								<span
									class="inline-flex shrink-0 items-center rounded-full border border-success/20 bg-success/10 px-2 py-0.5 text-xs font-medium whitespace-nowrap text-success"
								>
									Live
								</span>
							{:else if modelsSource === "static"}
								<span
									class="inline-flex shrink-0 items-center rounded-full border border-warning/20 bg-warning/10 px-2 py-0.5 text-xs font-medium whitespace-nowrap text-warning"
								>
									Static fallback
								</span>
							{/if}
						</div>
						{#if modelsFailed}
							<p class="mt-1 text-xs text-error">Could not fetch models</p>
						{/if}
					</label>
				</div>
				<p class="mt-2 text-xs text-muted-foreground">
					The model list is detected from KI Connect when reachable; otherwise a static
					fallback list is shown.
				</p>
			</div>

			<!-- KI Connect API key -->
			<div>
				<h3
					class="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase"
				>
					KI Connect API key
				</h3>
				{#if apiKeyHasKey && !apiKeyEditing}
					<div class="flex items-center gap-2">
						<input
							type="password"
							value="••••••••"
							disabled
							class="h-9 w-full max-w-xs rounded-[var(--radius)] border border-border bg-muted px-2 text-sm text-muted-foreground"
						/>
						<button
							type="button"
							onclick={startApiKeyEdit}
							class="flex h-9 shrink-0 items-center gap-2 rounded-[var(--radius)] border border-border px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted"
						>
							Change key
						</button>
					</div>
				{:else}
					<div class="flex items-center gap-2">
						<div class="relative w-full max-w-xs">
							<input
								type={apiKeyVisible ? "text" : "password"}
								class="h-9 w-full rounded-[var(--radius)] border border-border bg-background px-2 pr-9 text-sm text-foreground"
								placeholder="sk-..."
								aria-label="KI Connect API key"
								bind:value={apiKeyInput}
							/>
							<button
								type="button"
								aria-label={apiKeyVisible ? "Hide API key" : "Show API key"}
								onclick={() => (apiKeyVisible = !apiKeyVisible)}
								class="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-muted-foreground hover:text-foreground"
							>
								{#if apiKeyVisible}
									<EyeOff size={16} />
								{:else}
									<Eye size={16} />
								{/if}
							</button>
						</div>
						<button
							type="button"
							onclick={handleSaveApiKey}
							disabled={savingApiKey || apiKeyInput.trim() === ""}
							class="flex h-9 shrink-0 items-center gap-2 rounded-[var(--radius)] bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity disabled:opacity-50"
						>
							{#if savingApiKey}
								<Loader size={14} class="animate-spin" />
								Saving…
							{:else}
								Save key
							{/if}
						</button>
					</div>
				{/if}
				<p class="mt-2 text-xs text-muted-foreground">
					Stored in the server process only — the key is never sent back to the browser.
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

			{#if llmReloadNote}
				<div
					class="flex items-start gap-2 rounded-[var(--radius)] border border-warning/30 bg-warning/10 p-3 text-xs text-warning"
				>
					<span>⚠</span>
					<p>{llmReloadNote}</p>
				</div>
			{/if}
		</div>
	{/if}
</div>
