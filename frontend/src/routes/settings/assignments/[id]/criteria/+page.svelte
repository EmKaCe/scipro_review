<script lang="ts">
	/**
	 * @file /settings/assignments/[id]/criteria — visual criteria editor page.
	 *
	 * Loads the assignment's own criteria file (never general.yaml) and renders
	 * the CriteriaEditor for category / main-point / sub-point CRUD.
	 */

	import X from "@lucide/svelte/icons/x";
	import { onMount } from "svelte";

	import { base } from "$app/paths";
	import { page } from "$app/state";

	import CriteriaEditorTabs from "$lib/components/assignments/criteria-editor-tabs.svelte";
	import { Button } from "$lib/components/ui/button/index.js";
	import { buttonVariants } from "$lib/components/ui/button/button-variants.js";
	import { cn } from "$lib/utils.js";
	import { getCriteria } from "$lib/services/submissions-api.js";
	import { headerConfig } from "$lib/stores/header.svelte.js";
	import type { CriteriaFile } from "$lib/types/criteria.js";

	// -----------------------------------------------------------------------
	// Header
	// -----------------------------------------------------------------------
	$effect(() => {
		headerConfig.headerState = "dashboard";
		headerConfig.showBack = true;
		headerConfig.breadcrumb = "Assignments / Criteria";
		headerConfig.showImport = false;
		headerConfig.showSave = false;
		headerConfig.showExport = false;
		return () => {
			headerConfig.headerState = "dashboard";
		};
	});

	const assignmentId = $derived(page.params.id ?? "");

	// -----------------------------------------------------------------------
	// State
	// -----------------------------------------------------------------------
	let isLoading = $state(true);
	let loadError = $state<string | null>(null);
	let initialCriteria = $state<CriteriaFile | null>(null);

	async function load() {
		isLoading = true;
		loadError = null;
		try {
			const { content } = await getCriteria(assignmentId);
			initialCriteria = content;
		} catch (e) {
			loadError = e instanceof Error ? e.message : "Failed to load criteria";
		} finally {
			isLoading = false;
		}
	}

	onMount(load);
</script>

<div class="page-layout">
	<div class="page-header">
		<div>
			<h1 class="page-title">Criteria — {assignmentId}</h1>
			<p class="page-subtitle">
				Edit the rubric for this assignment. General categories apply automatically; only
				this assignment's own criteria are editable here.
			</p>
		</div>
		<a
			class={cn(buttonVariants({ variant: "outline", size: "sm" }), "gap-1")}
			href={`${base}/settings/assignments`}
		>
			<X size={14} />
			Back to assignments
		</a>
	</div>

	{#if isLoading}
		<div class="empty-card">Loading criteria…</div>
	{:else if loadError}
		<div class="empty-card error-card">
			<p>{loadError}</p>
			<Button variant="outline" size="sm" onclick={load}>Retry</Button>
		</div>
	{:else}
		<CriteriaEditorTabs {assignmentId} initial={initialCriteria} />
	{/if}
</div>

<style>
	.page-layout {
		display: flex;
		flex-direction: column;
		gap: 18px;
		padding: 24px;
		max-width: 980px;
		margin: 0 auto;
	}
	.page-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 16px;
	}
	.page-title {
		margin: 0;
		font-size: 20px;
		font-weight: 650;
		color: var(--fg);
	}
	.page-subtitle {
		margin: 4px 0 0;
		font-size: 13px;
		color: var(--muted-foreground);
	}
	.empty-card {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 10px;
		padding: 28px;
		border: 1px dashed var(--border);
		border-radius: var(--radius-md);
		color: var(--muted-foreground);
		font-size: 13px;
	}
	.error-card {
		border-color: color-mix(in oklch, var(--destructive) 35%, transparent);
		color: var(--destructive);
	}
</style>
