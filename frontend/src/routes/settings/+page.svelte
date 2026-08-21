<script lang="ts">
	import { base } from "$app/paths";
	import { headerConfig } from "$lib/stores/header.svelte.js";
	import { cn } from "$lib/utils.js";
	import { buttonVariants } from "$lib/components/ui/button/button-variants.js";
	import AppearanceCard from "$lib/components/settings/appearance-card.svelte";
	import LocalDataCard from "$lib/components/settings/local-data-card.svelte";
	import DataManagementCard from "$lib/components/settings/data-management-card.svelte";
	import ExecutionAiCard from "$lib/components/settings/execution-ai-card.svelte";
	import GradingConfigCard from "$lib/components/settings/grading-config-card.svelte";
	import ConfigurationMapCard from "$lib/components/settings/configuration-map-card.svelte";
	import AboutCard from "$lib/components/settings/about-card.svelte";
	import DangerZoneCard from "$lib/components/settings/danger-zone-card.svelte";
	import ListChecks from "@lucide/svelte/icons/list-checks";
	import ArrowUpRight from "@lucide/svelte/icons/arrow-up-right";

	// Configure header for this page
	$effect(() => {
		headerConfig.showBack = true;
		headerConfig.breadcrumb = "Settings";
		headerConfig.showImport = false;
		headerConfig.onimportclick = undefined;
		return () => {
			headerConfig.showBack = false;
			headerConfig.breadcrumb = undefined;
			headerConfig.showImport = false;
			headerConfig.onimportclick = undefined;
		};
	});
</script>

<svelte:head>
	<title>Settings — SciPro Review</title>
</svelte:head>

<div class="mx-auto max-w-2xl px-4 py-8">
	<div class="space-y-6">
		<AppearanceCard />
		{#if base === ""}
			<ExecutionAiCard />
			<GradingConfigCard />
			<ConfigurationMapCard />
			<a
				href={`${base}/onboarding`}
				class="group flex items-center justify-between gap-4 rounded-[var(--radius)] border border-border bg-card p-5 shadow-sm transition-colors hover:border-primary/40"
			>
				<span class="flex items-start gap-3">
					<ListChecks class="mt-0.5 h-5 w-5 shrink-0 text-primary" />
					<span>
						<span class="block text-sm font-medium text-foreground"
							>First-run setup checklist</span
						>
						<span class="mt-0.5 block text-xs text-muted-foreground">
							Guided checklist for getting SciPro Review ready — assignments, scoring,
							LLM, docs index.
						</span>
					</span>
				</span>
				<span
					class={cn(buttonVariants({ variant: "outline", size: "sm" }), "shrink-0 gap-1")}
				>
					Setup
					<ArrowUpRight class="h-3.5 w-3.5" />
				</span>
			</a>
			<DataManagementCard />
			<DangerZoneCard />
		{:else}
			<!-- Student/static build: teacher-only cards are intentionally hidden;
					     local-data management is the student-facing equivalent. -->
			<LocalDataCard />
		{/if}
		<AboutCard />
	</div>
</div>
