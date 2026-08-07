<script lang="ts">
	import { headerConfig } from "$lib/stores/header.svelte.js";
	import AppearanceCard from "$lib/components/settings/appearance-card.svelte";
	import DataManagementCard from "$lib/components/settings/data-management-card.svelte";
	import ExecutionAiCard from "$lib/components/settings/execution-ai-card.svelte";
	import AboutCard from "$lib/components/settings/about-card.svelte";
	import DangerZoneCard from "$lib/components/settings/danger-zone-card.svelte";

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
		<ExecutionAiCard />
		<DataManagementCard />
		<AboutCard />
		<DangerZoneCard />
	</div>
</div>
