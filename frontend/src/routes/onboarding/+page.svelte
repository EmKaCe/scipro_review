<script lang="ts">
	import { base } from "$app/paths";
	import { headerConfig } from "$lib/stores/header.svelte.js";
	import { cn } from "$lib/utils.js";
	import { buttonVariants } from "$lib/components/ui/button/button-variants.js";
	import {
		fetchModels,
		fetchSettings,
		saveApiKey,
		saveSettings,
		type ModelInfo,
	} from "$lib/services/settings-api.js";
	import { recommendModel } from "$lib/components/settings/model-recommendations.js";
	import ListChecks from "@lucide/svelte/icons/list-checks";
	import CircleCheckBig from "@lucide/svelte/icons/circle-check-big";
	import Circle from "@lucide/svelte/icons/circle";
	import CircleAlert from "@lucide/svelte/icons/circle-alert";
	import ArrowUpRight from "@lucide/svelte/icons/arrow-up-right";
	import ArchiveRestore from "@lucide/svelte/icons/archive-restore";
	import Download from "@lucide/svelte/icons/download";
	import Eye from "@lucide/svelte/icons/eye";
	import EyeOff from "@lucide/svelte/icons/eye-off";
	import LoaderCircle from "@lucide/svelte/icons/loader-circle";
	import DocsEmbedCard from "$lib/components/onboarding/DocsEmbedCard.svelte";

	/** One item as returned by GET /api/onboarding/status. */
	interface OnboardingItem {
		id: string;
		done: boolean | null;
		detail?: string;
	}

	interface ItemMeta {
		title: string;
		description: string;
		/** Extra guidance shown when the item is not done. */
		help?: string;
		/** Action link; undefined → no CTA for this item. */
		link: (detail?: string) => string | undefined;
	}

	const ITEM_META: Record<string, ItemMeta> = {
		"create-assignment": {
			title: "Create or import an assignment",
			description: "Set up the registry entry for your first notebook assignment.",
			link: () => `${base}/settings/assignments`,
		},
		"wire-scoring": {
			title: "Wire criteria + scoring",
			description:
				"Attach rubric criteria and a scoring config to your assignment so grading has semantics.",
			link: (id) =>
				id ? `${base}/settings/assignments/${id}/criteria` : `${base}/settings/assignments`,
		},
		"llm-provider": {
			title: "Configure the LLM provider",
			description:
				"Set a KI Connect API key here or via the KI_CONNECT_API_KEY env var — either counts.",
			link: () => `${base}/settings`,
		},
		"docs-index": {
			title: "Fetch the offline docs index",
			description:
				"Build the offline docs-index for copilot search. Until it exists, search degrades to BM25-only with a load note.",
			help: "Choose how the semantic search leg is built: download prebuilt vectors, rebuild them against your endpoint, or skip (BM25-only). BM25 exact-API search works either way.",
			link: () => undefined,
		},
		"first-pipeline": {
			title: "Upload a submission & run the pipeline",
			description: "Run your first grading pass end to end on a real notebook.",
			link: () => `${base}/submissions`,
		},
	};

	let items: OnboardingItem[] = $state([]);
	let loading = $state(true);
	let error: string | null = $state(null);

	// ---------------------------------------------------------------------
	// B1 — Restore a backup from another machine
	// ---------------------------------------------------------------------
	let restoreFile: File | undefined = $state();
	let restoreInput: HTMLInputElement | undefined = $state();
	let restorePhase = $state<"idle" | "confirm" | "running" | "done" | "failed">("idle");
	let restoreError: string | null = $state(null);
	let restoreSuccess: string | null = $state(null);

	async function handleRestore(): Promise<void> {
		if (!restoreFile || restorePhase === "running") return;
		restorePhase = "running";
		restoreError = null;
		restoreSuccess = null;
		try {
			const body = new FormData();
			body.append("file", restoreFile);
			const resp = await fetch(`${base}/api/backup`, { method: "POST", body });
			if (!resp.ok) {
				let message = `Restore failed (${resp.status})`;
				try {
					const parsed = (await resp.json()) as { error?: string; message?: string };
					message = parsed.error ?? parsed.message ?? message;
				} catch {
					// non-JSON error body — keep the status message
				}
				throw new Error(message);
			}
			restorePhase = "done";
			restoreFile = undefined;
			// Reset the DOM input so re-selecting the same file re-fires change.
			if (restoreInput) restoreInput.value = "";
			restoreSuccess = "Backup restored — the checklist below has been re-evaluated.";
			await refreshStatus();
		} catch (err) {
			// Keep the chosen file + show Confirm again so a retry is one click.
			restorePhase = "failed";
			restoreError = (err as Error).message;
		}
	}

	// ---------------------------------------------------------------------
	// B2 — In-place LLM provider setup (API key + recommended model)
	// ---------------------------------------------------------------------
	let llmApiKey = $state("");
	let llmApiKeyVisible = $state(false);
	let llmSaving = $state(false);
	let llmError: string | null = $state(null);
	let llmSuccess: string | null = $state(null);
	let models: ModelInfo[] = $state([]);
	let modelsSource = $state<"live" | "static" | null>(null);
	let selectedModel = $state("");

	/** Load the current settings + model list once for the llm-provider picker. */
	$effect(() => {
		let cancelled = false;
		async function load() {
			try {
				const settings = await fetchSettings();
				if (!cancelled) selectedModel = settings.llm.model;
			} catch {
				// The picker still works with a default model; the save path
				// re-reads settings itself.
			}
			try {
				const result = await fetchModels();
				if (cancelled) return;
				models = result.models;
				modelsSource = result.source;
			} catch {
				if (cancelled) return;
				models = [];
				modelsSource = null;
			}
		}
		void load();
		return () => {
			cancelled = true;
		};
	});

	const liveModelIds = $derived(new Set(models.map((m) => m.id)));

	async function handleSaveLlm(): Promise<void> {
		if (llmSaving) return;
		llmSaving = true;
		llmError = null;
		llmSuccess = null;
		try {
			const key = llmApiKey.trim();
			if (key) {
				await saveApiKey(key);
				llmApiKey = "";
			}
			if (selectedModel) {
				// Model save uses the full PUT (PATCH only accepts { apiKey });
				// re-read current settings so the save never clobbers other edits.
				const settings = await fetchSettings();
				const next = { ...settings, llm: { ...settings.llm, model: selectedModel } };
				await saveSettings(next);
			}
			llmSuccess = "LLM provider configured — the checklist has been re-evaluated.";
			await refreshStatus();
		} catch (err) {
			llmError = err instanceof Error ? err.message : "Failed to save LLM provider";
		} finally {
			llmSaving = false;
		}
	}

	async function refreshStatus(): Promise<void> {
		try {
			const resp = await fetch(`${base}/api/onboarding/status`);
			if (!resp.ok) throw new Error(`Status request failed (${resp.status})`);
			const body = (await resp.json()) as { items: OnboardingItem[] };
			// Clear any earlier failure so one transient error can't stick the
			// page in the error state after a later successful refresh.
			error = null;
			items = body.items;
		} catch (err) {
			error = (err as Error).message;
		}
	}

	$effect(() => {
		headerConfig.showBack = true;
		headerConfig.breadcrumb = "Setup";
		headerConfig.showImport = false;
		headerConfig.onimportclick = undefined;
		return () => {
			headerConfig.showBack = false;
			headerConfig.breadcrumb = undefined;
			headerConfig.showImport = false;
			headerConfig.onimportclick = undefined;
		};
	});

	$effect(() => {
		let cancelled = false;
		async function load() {
			try {
				const resp = await fetch(`${base}/api/onboarding/status`);
				if (!resp.ok) throw new Error(`Status request failed (${resp.status})`);
				const body = (await resp.json()) as { items: OnboardingItem[] };
				if (!cancelled) items = body.items;
			} catch (err) {
				if (!cancelled) error = (err as Error).message;
			} finally {
				if (!cancelled) loading = false;
			}
		}
		void load();
		return () => {
			cancelled = true;
		};
	});
</script>

<svelte:head>
	<title>Setup — SciPro Review</title>
</svelte:head>

<div class="mx-auto max-w-2xl px-4 py-8">
	<div class="space-y-6">
		<!-- B1 — Restore a backup from another machine (machine-migration path) -->
		<div class="overflow-hidden rounded-[var(--radius)] border border-border bg-card shadow-sm">
			<div class="p-5 pb-3">
				<h2
					class="flex items-center gap-2 text-base font-semibold tracking-tight text-foreground"
				>
					<ArchiveRestore class="h-5 w-5 text-primary" />
					Restore a backup from another machine
				</h2>
				<p class="mt-1 text-sm text-muted-foreground">
					If you've used SciPro Review before, restore your backup zip and most setup is
					already done.
				</p>
			</div>
			<div class="flex flex-wrap items-center gap-3 px-5 pb-5">
				<input
					bind:this={restoreInput}
					type="file"
					accept=".zip,application/zip"
					aria-label="Backup zip file"
					class="block max-w-full text-sm text-foreground file:mr-3 file:rounded-[var(--radius)] file:border-0 file:bg-muted file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-foreground hover:file:bg-muted/80"
					onchange={(e) => {
						const input = e.currentTarget as HTMLInputElement;
						restoreFile = input.files?.[0] ?? undefined;
						restorePhase = restoreFile ? "confirm" : "idle";
						restoreError = null;
						restoreSuccess = null;
					}}
				/>
				{#if restorePhase === "confirm" || (restorePhase === "failed" && restoreFile)}
					<button
						type="button"
						class={cn(
							buttonVariants({ variant: "destructive", size: "sm" }),
							"gap-1.5",
						)}
						onclick={handleRestore}
					>
						Confirm restore
					</button>
				{:else if restorePhase === "running"}
					<span class="inline-flex items-center gap-2 text-sm text-muted-foreground">
						<LoaderCircle class="h-3.5 w-3.5 animate-spin" />
						Restoring…
					</span>
				{/if}
				<a
					href={`${base}/api/backup`}
					class={cn(buttonVariants({ variant: "outline", size: "sm" }), "gap-1.5")}
					title="Download a zip of this machine's data directory"
				>
					<Download class="h-3.5 w-3.5" />
					Download current backup
				</a>
			</div>
			{#if restorePhase === "failed" && restoreError}
				<p class="px-5 pb-4 text-xs text-destructive">
					Could not restore: {restoreError} (max 200 MB).
				</p>
			{/if}
			{#if restorePhase === "done" && restoreSuccess}
				<p class="px-5 pb-4 text-xs text-success">{restoreSuccess}</p>
			{/if}
		</div>

		<header>
			<h1
				class="flex items-center gap-2 text-xl font-semibold tracking-tight text-foreground"
			>
				<ListChecks class="h-5 w-5 text-primary" />
				First-run setup checklist
			</h1>
			<p class="mt-1 text-sm text-muted-foreground">
				A guided checklist to get SciPro Review ready for its first grading pass. Read-only
				— each item is completed on its linked page (the LLM provider can be set here
				directly).
			</p>
		</header>

		{#if loading}
			<p class="text-sm text-muted-foreground">Checking your setup…</p>
		{:else if error}
			<p class="text-sm text-destructive">Could not load setup status: {error}</p>
		{:else}
			<ul
				class="divide-y divide-border overflow-hidden rounded-[var(--radius)] border border-border bg-card shadow-sm"
			>
				{#each items as item (item.id)}
					{@const meta = ITEM_META[item.id]}
					{@const href = meta ? meta.link(item.detail) : undefined}
					{#if meta}
						<li class="flex items-start gap-3 px-4 py-3">
							<span class="mt-0.5 shrink-0" aria-hidden="true">
								{#if item.done === true}
									<CircleCheckBig class="h-5 w-5 text-success" />
								{:else if item.done === false}
									<Circle class="h-5 w-5 text-muted-foreground" />
								{:else}
									<CircleAlert class="h-5 w-5 text-warning" />
								{/if}
							</span>
							<div class="min-w-0 flex-1">
								<div class="flex flex-wrap items-center gap-2">
									<p class="text-sm font-medium text-foreground">{meta.title}</p>
									<span
										class="rounded-full border px-2 py-px text-[10px] font-semibold tracking-wide uppercase
										{item.done === true
											? 'border-success/30 bg-success/10 text-success'
											: item.done === false
												? 'border-border bg-muted text-muted-foreground'
												: 'border-warning/30 bg-warning/10 text-warning'}"
									>
										{item.done === true
											? "Done"
											: item.done === false
												? "To do"
												: "Unknown"}
									</span>
								</div>
								<p class="mt-0.5 text-xs text-muted-foreground">
									{meta.description}
								</p>
								{#if item.done === false && meta.help}
									<p class="mt-1 text-[11px] text-muted-foreground">
										{meta.help}
									</p>
								{/if}
								{#if item.id === "llm-provider" && item.done === false}
									<div
										class="mt-2 rounded-[var(--radius)] border border-border bg-muted/40 p-3"
									>
										<div
											class="flex flex-col gap-2 sm:flex-row sm:items-center"
										>
											<div class="min-w-0 flex-1">
												<label
													class="mb-1 block text-[11px] font-medium text-muted-foreground"
													for="llm-api-key"
												>
													KI Connect API key
												</label>
												<div class="flex items-center gap-1.5">
													<input
														id="llm-api-key"
														type={llmApiKeyVisible
															? "text"
															: "password"}
														class="input w-full"
														placeholder="sk-…"
														autocomplete="off"
														bind:value={llmApiKey}
													/>
													<button
														type="button"
														class="shrink-0 rounded-[var(--radius)] border border-border p-2 text-muted-foreground hover:bg-muted"
														aria-label={llmApiKeyVisible
															? "Hide API key"
															: "Show API key"}
														onclick={() =>
															(llmApiKeyVisible = !llmApiKeyVisible)}
													>
														{#if llmApiKeyVisible}
															<EyeOff class="h-3.5 w-3.5" />
														{:else}
															<Eye class="h-3.5 w-3.5" />
														{/if}
													</button>
												</div>
											</div>
											<div class="min-w-0 flex-1">
												<label
													class="mb-1 block text-[11px] font-medium text-muted-foreground"
													for="llm-model"
												>
													Model
												</label>
												<select
													id="llm-model"
													class="input w-full"
													bind:value={selectedModel}
												>
													{#if models.length === 0}
														<option value="" disabled
															>Loading models…</option
														>
													{/if}
													{#each models as model (model.id)}
														{@const rec = recommendModel(
															model.id,
															liveModelIds,
														)}
														<option value={model.id}>
															{model.id}{rec.badge === "recommended"
																? " — Recommended"
																: rec.badge === "fast"
																	? " — Fast, good for validation"
																	: ""}
														</option>
													{/each}
												</select>
											</div>
										</div>
										<div class="mt-2 flex flex-wrap items-center gap-2">
											<button
												type="button"
												class={cn(
													buttonVariants({
														variant: "default",
														size: "sm",
													}),
													"gap-1",
												)}
												disabled={llmSaving}
												onclick={handleSaveLlm}
											>
												{#if llmSaving}
													<LoaderCircle
														class="h-3.5 w-3.5 animate-spin"
													/>
												{/if}
												Save key &amp; model
											</button>
											{#if modelsSource === "static"}
												<span class="text-[11px] text-muted-foreground">
													Model list unavailable from the API — you can
													also set KI_CONNECT_API_KEY in your .env.
												</span>
											{/if}
										</div>
										{#if llmError}
											<p class="mt-1 text-[11px] text-destructive">
												{llmError}
											</p>
										{/if}
										{#if llmSuccess}
											<p class="mt-1 text-[11px] text-success">
												{llmSuccess}
											</p>
										{/if}
									</div>
								{/if}
							</div>
							{#if item.id === "docs-index"}
								<div class="mt-2">
									<DocsEmbedCard
										context="onboarding"
										indexPresent={item.done === true}
										ondone={refreshStatus}
									/>
								</div>
							{/if}
							{#if href}
								<a
									{href}
									class={cn(
										buttonVariants({ variant: "outline", size: "sm" }),
										"shrink-0 gap-1",
									)}
								>
									Setup
									<ArrowUpRight class="h-3.5 w-3.5" />
								</a>
							{/if}
						</li>
					{/if}
				{/each}
			</ul>
		{/if}
	</div>
</div>
