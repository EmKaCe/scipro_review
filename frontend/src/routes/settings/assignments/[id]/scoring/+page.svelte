<script lang="ts">
	/**
	 * @file /settings/assignments/[id]/scoring — visual scoring config editor page.
	 *
	 * Loads the assignment's scoring config (data/scoring/<id>.yaml) and
	 * renders the ScoringEditorTabs for anchors / evidence patterns /
	 * disallowed libraries / dimension guidance CRUD.
	 */

	import X from "@lucide/svelte/icons/x";
	import RefreshCw from "@lucide/svelte/icons/refresh-cw";
	import { onMount } from "svelte";

	import { base } from "$app/paths";
	import { page } from "$app/state";

	import ScoringEditorTabs from "$lib/components/assignments/scoring-editor-tabs.svelte";
	import { Button } from "$lib/components/ui/button/index.js";
	import { buttonVariants } from "$lib/components/ui/button/button-variants.js";
	import { cn } from "$lib/utils.js";
	import { getScoringConfig } from "$lib/services/submissions-api.js";
	import { headerConfig } from "$lib/stores/header.svelte.js";
	import type { ScoringConfigDocument } from "$lib/components/assignments/scoring-editor-model.js";

	// -----------------------------------------------------------------------
	// Header
	// -----------------------------------------------------------------------
	$effect(() => {
		headerConfig.headerState = "dashboard";
		headerConfig.showBack = true;
		headerConfig.breadcrumb = "Assignments / Scoring";
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
	let initialScoring = $state<ScoringConfigDocument | null>(null);

	async function load() {
		isLoading = true;
		loadError = null;
		try {
			const { content } = await getScoringConfig(assignmentId);
			initialScoring = content;
		} catch (e) {
			loadError = e instanceof Error ? e.message : "Failed to load scoring config";
		} finally {
			isLoading = false;
		}
	}

	onMount(load);
</script>

<div class="page-layout">
	<div class="page-header">
		<div>
			<h1 class="page-title">Scoring — {assignmentId}</h1>
			<p class="page-subtitle">
				Configure this assignment's scoring semantics: calibration anchors, evidence
				regexes, disallowed libraries and Phase 2a dimension guidance. The server
				compile gate validates on save.
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
		<div class="empty-card">Loading scoring config…</div>
	{:else if loadError}
		<div class="empty-card error-card">
			<p>{loadError}</p>
			<Button variant="outline" size="sm" onclick={load}>
				<RefreshCw size={14} />
				Retry
			</Button>
		</div>
	{:else}
		<ScoringEditorTabs {assignmentId} initial={initialScoring} />
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
