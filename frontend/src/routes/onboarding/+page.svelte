<script lang="ts">
	import { base } from "$app/paths";
	import { headerConfig } from "$lib/stores/header.svelte.js";
	import { cn } from "$lib/utils.js";
	import { buttonVariants } from "$lib/components/ui/button/button-variants.js";
	import ListChecks from "@lucide/svelte/icons/list-checks";
	import CircleCheckBig from "@lucide/svelte/icons/circle-check-big";
	import Circle from "@lucide/svelte/icons/circle";
	import CircleAlert from "@lucide/svelte/icons/circle-alert";
	import ArrowUpRight from "@lucide/svelte/icons/arrow-up-right";

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
			help: "Downloads the prebuilt public index (~680 MB) — no API key needed. You can also keep going; search will just fall back to BM25.",
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
	/** docs-index download state: "idle" | "running" | "done" | "failed". */
	let docsDownload = $state<"idle" | "running" | "done" | "failed">("idle");
	let docsDownloadError: string | null = $state(null);

	async function refreshStatus(): Promise<void> {
		try {
			const resp = await fetch(`${base}/api/onboarding/status`);
			if (!resp.ok) throw new Error(`Status request failed (${resp.status})`);
			const body = (await resp.json()) as { items: OnboardingItem[] };
			items = body.items;
		} catch (err) {
			error = (err as Error).message;
		}
	}

	async function startDocsDownload(): Promise<void> {
		if (docsDownload === "running") return;
		docsDownload = "running";
		docsDownloadError = null;
		try {
			const resp = await fetch(`${base}/api/onboarding/docs-index`, { method: "POST" });
			const body = (await resp.json()) as { ok?: boolean; error?: string };
			if (!resp.ok || body.ok === false) {
				throw new Error(body.error ?? `Download failed (${resp.status})`);
			}
			docsDownload = "done";
			await refreshStatus();
		} catch (err) {
			docsDownload = "failed";
			docsDownloadError = (err as Error).message;
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
		<header>
			<h1
				class="flex items-center gap-2 text-xl font-semibold tracking-tight text-foreground"
			>
				<ListChecks class="h-5 w-5 text-primary" />
				First-run setup checklist
			</h1>
			<p class="mt-1 text-sm text-muted-foreground">
				A guided checklist to get SciPro Review ready for its first grading pass. Read-only
				— each item is completed on its linked page.
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
							</div>
							{#if item.id === "docs-index" && item.done !== true}
								<div class="mt-2">
									<button
										type="button"
										class={cn(
											buttonVariants({ variant: "outline", size: "sm" }),
											"gap-1",
										)}
										disabled={docsDownload === "running"}
										onclick={startDocsDownload}
									>
										{#if docsDownload === "running"}
											<span
												class="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent"
											></span>
											Downloading…
										{:else if docsDownload === "done"}
											<CircleCheckBig class="h-3.5 w-3.5" />
											Downloaded
										{:else}
											Download vectors now
										{/if}
									</button>
									{#if docsDownload === "failed" && docsDownloadError}
										<p class="mt-1 text-[11px] text-destructive">
											{docsDownloadError}
										</p>
									{/if}
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
