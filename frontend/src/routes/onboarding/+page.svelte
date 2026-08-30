<script lang="ts">
	import { base } from "$app/paths";
	import { goto, invalidateAll } from "$app/navigation";
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
	import WizardShell, { STEP_META } from "$lib/components/onboarding/WizardShell.svelte";
	import DocsEmbedCard from "$lib/components/onboarding/DocsEmbedCard.svelte";
	import {
		deriveSteps,
		markExecutor,
		type OnboardingStatusInput,
		type WizardStepId,
	} from "$lib/states/onboarding-wizard.svelte";
	import ListChecks from "@lucide/svelte/icons/list-checks";
	import Check from "@lucide/svelte/icons/check";
	import Circle from "@lucide/svelte/icons/circle";
	import ArrowUpRight from "@lucide/svelte/icons/arrow-up-right";
	import Download from "@lucide/svelte/icons/download";
	import Eye from "@lucide/svelte/icons/eye";
	import EyeOff from "@lucide/svelte/icons/eye-off";
	import LoaderCircle from "@lucide/svelte/icons/loader-circle";
	import RefreshCcw from "@lucide/svelte/icons/refresh-ccw";
	import CircleCheckBig from "@lucide/svelte/icons/circle-check-big";
	import CircleAlert from "@lucide/svelte/icons/circle-alert";
	import SkipForward from "@lucide/svelte/icons/skip-forward";
	import Server from "@lucide/svelte/icons/server";
	import PackagePlus from "@lucide/svelte/icons/package-plus";

	/** One item as returned by GET /api/onboarding/status. */
	interface OnboardingItem {
		id: string;
		done: boolean | null;
		detail?: string;
	}

	let items: OnboardingItem[] = $state([]);
	let loading = $state(true);
	let error: string | null = $state(null);

	// ---------------------------------------------------------------------
	// Wizard shell state (2.8.0)
	// ---------------------------------------------------------------------

	/** Welcome fork: fresh setup vs restore-from-backup (null until chosen). */
	let fork = $state<"fresh" | "restore" | null>(null);
	/** Always land on the welcome step; the rail shows derived completion. */
	let current = $state<WizardStepId>("welcome");
	/** Optimistic "seed was performed" before the status re-poll lands. */
	let seeded = $state(false);

	/** Status payload shaped for the step model (items are the live fetch). */
	const statusInput = $derived<OnboardingStatusInput>({ items });

	/** Step completion derived from status + fork/seed options. */
	const baseSteps = $derived(deriveSteps(statusInput, { fork: fork ?? undefined, seeded }));

	/** The executor probe result, layered on once probed (never from status). */
	interface ExecutorProbeState {
		reachable: boolean;
		version?: string;
		status?: string;
		dataDir?: string;
		error?: string;
	}
	let executorProbe = $state<ExecutorProbeState | null>(null);
	let executorProbing = $state(false);

	const steps = $derived(
		executorProbe === null
			? baseSteps
			: markExecutor(baseSteps, executorProbe.reachable),
	);

	/** docs-index done flag for the DocsEmbedCard compact/installed look. */
	const docsIndexDone = $derived(items.find((i) => i.id === "docs-index")?.done === true);

	/** Steps summarized on the Done step (welcome/done themselves excluded). */
	const doneEntries = $derived(
		steps.filter((s) => s.id !== "welcome" && s.id !== "done"),
	);

	function handleFork(choice: "fresh" | "restore"): void {
		fork = choice;
		// Restore flows jump to the restore step; fresh flows skip it.
		current = choice === "restore" ? "restore" : "provider";
	}

	function handleGoto(step: WizardStepId): void {
		current = step;
	}

	// ---------------------------------------------------------------------
	// Executor step — live probe on entering the step (once per session)
	// ---------------------------------------------------------------------

	async function probeExecutor(): Promise<void> {
		if (executorProbing) return;
		executorProbing = true;
		try {
			const resp = await fetch(`${base}/api/executor/health`);
			const body = (await resp.json().catch(() => null)) as {
				reachable?: boolean;
				status?: string;
				version?: string;
				data_dir?: string;
				error?: string;
			} | null;
			if (body && body.reachable !== false) {
				executorProbe = {
					reachable: true,
					version: body.version,
					status: body.status,
					dataDir: body.data_dir,
				};
			} else {
				executorProbe = {
					reachable: false,
					error: body?.error ?? `Probe failed (${resp.status})`,
				};
			}
		} catch (err) {
			executorProbe = {
				reachable: false,
				error: err instanceof Error ? err.message : "Executor probe failed",
			};
		} finally {
			executorProbing = false;
		}
	}

	/** Re-probe: drop the stored result; the enter-step effect re-fires. */
	function reprobeExecutor(): void {
		if (executorProbing) return;
		executorProbe = null;
	}

	$effect(() => {
		if (current !== "executor" || executorProbe !== null || executorProbing) return;
		void probeExecutor();
	});

	// ---------------------------------------------------------------------
	// Seed step — one-click reference assignment install
	// ---------------------------------------------------------------------

	type SeedState = "idle" | "running" | "done" | "failed";
	let seedState: SeedState = $state("idle");
	let seedResult: {
		assignmentId?: string;
		alreadyEnabled?: boolean;
		missingFiles?: string[];
	} | null = $state(null);
	let seedError: string | null = $state(null);

	async function handleSeed(): Promise<void> {
		if (seedState === "running") return;
		seedState = "running";
		seedError = null;
		seedResult = null;
		try {
			const resp = await fetch(`${base}/api/onboarding/seed`, { method: "POST" });
			const body = (await resp.json().catch(() => null)) as {
				ok?: boolean;
				assignmentId?: string;
				alreadyEnabled?: boolean;
				missingFiles?: string[];
				error?: string;
			} | null;
			if (resp.ok && body?.ok === true) {
				seedState = "done";
				seedResult = body;
				seeded = true;
				await refreshStatus();
			} else if (resp.status === 422 && body) {
				seedState = "failed";
				seedResult = body;
			} else {
				seedState = "failed";
				seedError = body?.error ?? `Seed failed (${resp.status})`;
			}
		} catch (err) {
			seedState = "failed";
			seedError = err instanceof Error ? err.message : "Seed failed";
		}
	}

	// ---------------------------------------------------------------------
	// Done step — dismiss + wrap up
	// ---------------------------------------------------------------------

	let dismissing = $state(false);
	let dismissError: string | null = $state(null);

	async function handleFinish(): Promise<void> {
		if (dismissing) return;
		dismissing = true;
		dismissError = null;
		try {
			const resp = await fetch(`${base}/api/onboarding/dismiss`, { method: "POST" });
			if (!resp.ok) {
				const body = (await resp.json().catch(() => null)) as { error?: string } | null;
				throw new Error(body?.error ?? `Could not dismiss setup (${resp.status})`);
			}
			await invalidateAll();
			await goto(`${base}/submissions`);
		} catch (err) {
			dismissError =
				err instanceof Error ? err.message : "Could not save — setup will re-open next visit.";
			dismissing = false;
		}
	}

	// ---------------------------------------------------------------------
	// Restore a backup from another machine (B1)
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
			restoreSuccess = "Backup restored — your setup has been re-evaluated.";
			await refreshStatus();
		} catch (err) {
			// Keep the chosen file + show Confirm again so a retry is one click.
			restorePhase = "failed";
			restoreError = (err as Error).message;
		}
	}

	// ---------------------------------------------------------------------
	// In-place LLM provider setup (B2 — API key + recommended model)
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
			llmSuccess = "LLM provider configured — your setup has been re-evaluated.";
			await refreshStatus();
		} catch (err) {
			llmError = err instanceof Error ? err.message : "Failed to save LLM provider";
		} finally {
			llmSaving = false;
		}
	}

	// ---------------------------------------------------------------------
	// Status — single source of truth for step completion
	// ---------------------------------------------------------------------

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

<div class="mx-auto max-w-3xl px-4 py-8">
	<div class="space-y-6">
		<header>
			<h1
				class="flex items-center gap-2 text-xl font-semibold tracking-tight text-foreground"
			>
				<ListChecks class="h-5 w-5 text-primary" />
				Setup wizard
			</h1>
			<p class="mt-1 text-sm text-muted-foreground">
				A guided walkthrough to get SciPro Review ready for its first grading pass —
				most steps are completed right here.
			</p>
		</header>

		{#if loading}
			<p class="text-sm text-muted-foreground">Checking your setup…</p>
		{:else if error}
			<p class="text-sm text-destructive">Could not load setup status: {error}</p>
		{:else}
			<WizardShell {steps} {current} {fork} onfork={handleFork} ongoto={handleGoto}>
				{#if current === "restore"}
					<!-- Restore a backup from another machine (machine-migration path) -->
					<div>
						<p class="text-sm text-muted-foreground">
							If you've used SciPro Review before, restore your backup zip and most
							setup is already done.
						</p>
						<div class="mt-3 flex flex-wrap items-center gap-3">
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
							<p class="mt-2 text-xs text-destructive">
								Could not restore: {restoreError} (max 200 MB).
							</p>
						{/if}
						{#if restorePhase === "done" && restoreSuccess}
							<p class="mt-2 text-xs text-success">{restoreSuccess}</p>
						{/if}
					</div>
				{:else if current === "provider"}
					<!-- In-place LLM provider setup (API key + model) -->
					<div class="rounded-[var(--radius)] border border-border bg-muted/40 p-3">
						<div class="flex flex-col gap-2 sm:flex-row sm:items-center">
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
										type={llmApiKeyVisible ? "text" : "password"}
										class="input w-full"
										placeholder="sk-…"
										autocomplete="off"
										bind:value={llmApiKey}
									/>
									<button
										type="button"
										class="shrink-0 rounded-[var(--radius)] border border-border p-2 text-muted-foreground hover:bg-muted"
										aria-label={llmApiKeyVisible ? "Hide API key" : "Show API key"}
										onclick={() => (llmApiKeyVisible = !llmApiKeyVisible)}
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
								<select id="llm-model" class="input w-full" bind:value={selectedModel}>
									{#if models.length === 0}
										<option value="" disabled
											>Loading models…</option
										>
									{/if}
									{#each models as model (model.id)}
										{@const rec = recommendModel(model.id, liveModelIds)}
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
									buttonVariants({ variant: "default", size: "sm" }),
									"gap-1",
								)}
								disabled={llmSaving}
								onclick={handleSaveLlm}
							>
								{#if llmSaving}
									<LoaderCircle class="h-3.5 w-3.5 animate-spin" />
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
							<p class="mt-1 text-[11px] text-destructive">{llmError}</p>
						{/if}
						{#if llmSuccess}
							<p class="mt-1 text-[11px] text-success">{llmSuccess}</p>
						{/if}
					</div>
				{:else if current === "docs-index"}
					<!-- Three-choice docs index install (A download / B rebuild / C skip) -->
					<DocsEmbedCard
						context="onboarding"
						indexPresent={docsIndexDone}
						ondone={refreshStatus}
					/>
				{:else if current === "executor"}
					<!-- Live executor probe -->
					{#if executorProbing}
						<div class="flex items-center gap-2 text-sm text-muted-foreground">
							<LoaderCircle class="h-4 w-4 animate-spin" />
							Checking the executor…
						</div>
					{:else if executorProbe && executorProbe.reachable}
						<div
							class="flex items-start gap-3 rounded-[var(--radius)] border border-success/30 bg-success/10 p-4"
						>
							<CircleCheckBig class="mt-0.5 h-5 w-5 shrink-0 text-success" />
							<div class="min-w-0">
								<p class="flex items-center gap-2 text-sm font-semibold text-success">
									<Server class="h-4 w-4" />
									Executor reachable
								</p>
								<dl
									class="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground sm:grid-cols-3"
								>
									<div>
										<dt class="font-medium text-foreground">Version</dt>
										<dd>{executorProbe.version ?? "unknown"}</dd>
									</div>
									<div>
										<dt class="font-medium text-foreground">Status</dt>
										<dd>{executorProbe.status ?? "unknown"}</dd>
									</div>
									{#if executorProbe.dataDir}
										<div>
											<dt class="font-medium text-foreground">Data dir</dt>
											<dd class="truncate">{executorProbe.dataDir}</dd>
										</div>
									{/if}
								</dl>
							</div>
						</div>
					{:else if executorProbe}
						<div
							class="rounded-[var(--radius)] border border-destructive/30 bg-destructive/5 p-4"
						>
							<p class="flex items-center gap-2 text-sm font-semibold text-destructive">
								<CircleAlert class="h-4 w-4" />
								Executor unreachable
							</p>
							<p class="mt-1 text-xs text-muted-foreground">
								{executorProbe.error ?? "The executor did not respond."}
							</p>
							<div class="mt-3 flex flex-wrap items-center gap-2">
								<button
									type="button"
									class={cn(
										buttonVariants({ variant: "outline", size: "sm" }),
										"gap-1",
									)}
									onclick={reprobeExecutor}
								>
									<RefreshCcw class="h-3.5 w-3.5" />
									Re-probe
								</button>
								<button
									type="button"
									class={cn(buttonVariants({ variant: "ghost", size: "sm" }), "gap-1")}
									onclick={() => (current = "seed")}
								>
									<SkipForward class="h-3.5 w-3.5" />
									Skip — I'll check it later
								</button>
							</div>
						</div>
					{/if}
				{:else if current === "seed"}
					<!-- One-click reference assignment install -->
					{#if seedState === "running"}
						<div class="flex items-center gap-2 text-sm text-muted-foreground">
							<LoaderCircle class="h-4 w-4 animate-spin" />
							Seeding the reference assignment…
						</div>
					{:else if seedState === "done" && seedResult}
						<div
							class="flex items-start gap-3 rounded-[var(--radius)] border border-success/30 bg-success/10 p-4"
						>
							<CircleCheckBig class="mt-0.5 h-5 w-5 shrink-0 text-success" />
							<div class="min-w-0">
								<p class="text-sm font-semibold text-success">
									Reference assignment enabled
								</p>
								<p class="mt-0.5 text-xs text-muted-foreground">
									{seedResult.assignmentId ?? "soil_contamination"} is ready for your
									first grading pass.
								</p>
								{#if seedResult.alreadyEnabled}
									<p class="mt-1 text-[11px] text-muted-foreground">
										It was already enabled — nothing changed.
									</p>
								{/if}
							</div>
						</div>
					{:else if seedState === "failed"}
						<div
							class="rounded-[var(--radius)] border border-destructive/30 bg-destructive/5 p-4"
						>
							<p class="flex items-center gap-2 text-sm font-semibold text-destructive">
								<CircleAlert class="h-4 w-4" />
								{seedResult?.missingFiles?.length ? "Broken install" : "Seed failed"}
							</p>
							{#if seedResult?.missingFiles?.length}
								<p class="mt-1 text-xs text-muted-foreground">
									The reference assignment is missing files on disk:
								</p>
								<ul class="mt-1 list-inside list-disc text-xs text-destructive">
									{#each seedResult.missingFiles as file (file)}
										<li class="font-mono">{file}</li>
									{/each}
								</ul>
							{:else}
								<p class="mt-1 text-xs text-muted-foreground">
									{seedError ?? "The seed request failed."}
								</p>
							{/if}
							<div class="mt-3 flex flex-wrap items-center gap-2">
								<button
									type="button"
									class={cn(
										buttonVariants({ variant: "outline", size: "sm" }),
										"gap-1",
									)}
									onclick={handleSeed}
								>
									<RefreshCcw class="h-3.5 w-3.5" />
									Try again
								</button>
							</div>
						</div>
					{:else}
						<p class="text-sm text-muted-foreground">
							Install the bundled reference assignment
							(<span class="font-medium text-foreground">soil_contamination</span>) so
							your first pass has an assignment, criteria and scoring wired up. Already
							use your own assignment? Skip — your own setup counts the same way.
						</p>
						<div class="mt-3 flex flex-wrap items-center gap-2">
							<button
								type="button"
								class={cn(buttonVariants({ variant: "default", size: "sm" }), "gap-1")}
								onclick={handleSeed}
							>
								<PackagePlus class="h-3.5 w-3.5" />
								Install reference assignment
							</button>
							<button
								type="button"
								class={cn(buttonVariants({ variant: "ghost", size: "sm" }), "gap-1")}
								onclick={() => (current = "done")}
							>
								<SkipForward class="h-3.5 w-3.5" />
								Skip — I'll use my own assignment
							</button>
						</div>
					{/if}
				{:else if current === "done"}
					<!-- Summary + dismiss -->
					<div class="space-y-4">
						<ul
							class="divide-y divide-border overflow-hidden rounded-[var(--radius)] border border-border bg-muted/20"
						>
							{#each doneEntries as step (step.id)}
								<li class="flex items-center gap-3 px-4 py-2.5">
									<span class="flex h-5 w-5 shrink-0 items-center justify-center">
										{#if step.complete}
											<Check class="h-4 w-4 text-success" />
										{:else}
											<Circle class="h-4 w-4 text-muted-foreground" />
										{/if}
									</span>
									<span class="min-w-0 flex-1 text-sm font-medium text-foreground">
										{STEP_META[step.id].title}
									</span>
									<span
										class="rounded-full border px-2 py-px text-[10px] font-semibold tracking-wide uppercase
										{step.complete
											? 'border-success/30 bg-success/10 text-success'
											: 'border-border bg-muted text-muted-foreground'}"
									>
										{step.complete ? "Done" : "Skipped"}
									</span>
								</li>
							{/each}
						</ul>
						<div class="flex flex-wrap items-center gap-3">
							<button
								type="button"
								class={cn(buttonVariants({ variant: "default" }), "gap-1")}
								disabled={dismissing}
								onclick={handleFinish}
							>
								{#if dismissing}
									<LoaderCircle class="h-4 w-4 animate-spin" />
								{/if}
								Finish &amp; open submissions
							</button>
							<a
								href={`${base}/submissions`}
								class={cn(buttonVariants({ variant: "outline" }), "gap-1")}
							>
								Run your first grading pass — not blocking
								<ArrowUpRight class="h-3.5 w-3.5" />
							</a>
						</div>
						{#if dismissError}
							<p class="text-xs text-destructive">
								{dismissError} — setup will re-open next visit.
							</p>
						{/if}
					</div>
				{/if}
			</WizardShell>
		{/if}
	</div>
</div>