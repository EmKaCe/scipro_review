<script lang="ts">
	import { listSubmissions } from "$lib/services/submissions-store.js";
	import { headerConfig } from "$lib/stores/header.svelte.js";
	import { addToast } from "$lib/stores/toast.svelte.js";
	import { goto } from "$app/navigation";
	import { base } from "$app/paths";
	import type { SubmissionMeta } from "$lib/types/submissions.js";
	import SkeletonPulse from "$lib/components/ui/skeleton-pulse.svelte";
	import AlertTriangle from "@lucide/svelte/icons/alert-triangle";
	import RefreshCw from "@lucide/svelte/icons/refresh-cw";

	import AssignmentSelector from "$lib/components/submissions/assignment-selector.svelte";
	import UploadBar from "$lib/components/submissions/upload-bar.svelte";
	import UploadPanel from "$lib/components/submissions/upload-panel.svelte";
	import MaterialsIndicator from "$lib/components/submissions/materials-indicator.svelte";
	import SubmissionsDashboard from "$lib/components/submissions/submissions-dashboard.svelte";

	// -----------------------------------------------------------------------
	// Header config
	// -----------------------------------------------------------------------
	$effect(() => {
		headerConfig.headerState = "dashboard";
		headerConfig.showBack = false;
		headerConfig.showImport = false;
		headerConfig.showSave = false;
		return () => {
			headerConfig.headerState = "dashboard";
		};
	});

	// -----------------------------------------------------------------------
	// State
	// -----------------------------------------------------------------------
	let submissions = $state<SubmissionMeta[]>([]);
	let isLoading = $state(true);
	let error = $state<string | null>(null);
	let selectedAssignment = $state("soil_contamination");
	let searchQuery = $state("");
	let statusFilter = $state("all");
	let uploadPanelOpen = $state(false);

	// -----------------------------------------------------------------------
	// Data loading
	// -----------------------------------------------------------------------
	$effect(() => {
		loadSubmissions();
	});

	async function loadSubmissions() {
		isLoading = true;
		error = null;
		try {
			// Phase 2 stub: simulate async load
			submissions = listSubmissions();
		} catch (e) {
			error = e instanceof Error ? e.message : "Failed to load submissions";
		} finally {
			isLoading = false;
		}
	}

	// -----------------------------------------------------------------------
	// Handlers
	// -----------------------------------------------------------------------
	function handleAssignmentChange(id: string) {
		selectedAssignment = id;
		loadSubmissions();
	}

	function handleSearchChange(q: string) {
		searchQuery = q;
	}

	function handleStatusFilterChange(f: string) {
		statusFilter = f;
	}

	function handleProcessAll() {
		addToast("info", "Processing pipeline coming in Phase 3", 4000);
	}

	function handlePreEvaluateAll() {
		addToast("info", "Pre-evaluation coming in Phase 4", 4000);
	}

	function handleToggleUploadPanel() {
		uploadPanelOpen = !uploadPanelOpen;
	}

	// Phase 2 stub: flag for stubbed functionality
	const IS_PHASE_2_STUB = true;
</script>

<svelte:head>
	<title>SciPro Review — Submissions</title>
</svelte:head>

<!-- ================================================================ -->
<!-- Loading state -->
<!-- ================================================================ -->
{#if isLoading}
	<div class="page-layout">
		<!-- Assignment row skeleton -->
		<div class="assign-upload-row">
			<SkeletonPulse class="h-[34px] w-[360px] rounded-[var(--radius-md)]" />
			<SkeletonPulse class="h-[34px] w-[110px] rounded-[var(--radius)]" />
		</div>

		<!-- Materials skeleton -->
		<div class="materials-section">
			<SkeletonPulse class="h-3 w-48" />
		</div>

		<!-- Table card skeleton -->
		<div class="overflow-hidden rounded-[var(--radius-lg)] border border-border">
			<!-- Toolbar -->
			<div class="flex items-center gap-3 border-b border-border px-3.5 py-2">
				<SkeletonPulse class="h-7 w-[260px] rounded-[var(--radius-md)]" />
				<SkeletonPulse class="h-7 w-[140px] rounded-[var(--radius-md)]" />
			</div>
			<!-- Table header -->
			<div class="flex items-center gap-4 border-b border-border px-3.5 py-2.5">
				<SkeletonPulse class="h-3 w-[13%]" />
				<SkeletonPulse class="h-3 w-[14%]" />
				<SkeletonPulse class="h-3 w-[15%]" />
				<SkeletonPulse class="h-3 w-[13%]" />
				<SkeletonPulse class="h-3 w-[12%]" />
			</div>
			<!-- Table rows -->
			{#each [1, 2, 3, 4, 5] as _i ( _i)}
				<div class="flex items-center gap-4 border-b border-border px-3.5 py-2.5 last:border-0">
					<SkeletonPulse class="h-3 w-[13%]" />
					<SkeletonPulse class="h-4 w-[14%] rounded-full" />
					<SkeletonPulse class="h-3 w-[15%]" />
					<SkeletonPulse class="h-3 w-[13%]" />
					<SkeletonPulse class="h-3 w-[12%]" />
					<SkeletonPulse class="ml-auto h-6 w-14 rounded-[var(--radius-md)]" />
				</div>
			{/each}
		</div>

		<!-- Action bar skeleton -->
		<div class="flex items-center gap-2">
			<SkeletonPulse class="h-8 w-[110px] rounded-[var(--radius)]" />
			<SkeletonPulse class="h-8 w-[130px] rounded-[var(--radius)]" />
		</div>

		<!-- Upload bar skeleton -->
		<SkeletonPulse class="h-9 w-full rounded-[var(--radius-md)]" />
	</div>

<!-- ================================================================ -->
<!-- Error state -->
<!-- ================================================================ -->
{:else if error}
	<div class="flex items-center justify-center px-6 py-20 md:px-10 lg:px-16 xl:px-24">
		<div class="max-w-md text-center">
			<AlertTriangle size={40} class="mx-auto text-destructive" />
			<h2 class="mt-4 text-lg font-semibold text-foreground">Something went wrong</h2>
			<p class="mt-2 text-sm text-muted-foreground">{error}</p>
			<div class="mt-6 flex items-center justify-center gap-3">
				<button
					onclick={loadSubmissions}
					class="inline-flex items-center gap-2 rounded-[var(--radius)] bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
				>
					<RefreshCw size={14} />
					Try again
				</button>
				<a
					href={base}
					class="inline-flex items-center gap-1 rounded-[var(--radius)] border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-black/5 dark:hover:bg-white/10"
				>
					Go to Dashboard
				</a>
			</div>
		</div>
	</div>

<!-- ================================================================ -->
<!-- Content state -->
<!-- ================================================================ -->
{:else}
	<div class="page-layout">
		<!-- ── Assignment row ── -->
		<div class="assign-upload-row">
			<AssignmentSelector
				selected={selectedAssignment}
				onChange={handleAssignmentChange}
			/>
			<button
				class="btn-upload-more"
				onclick={handleToggleUploadPanel}
			>
				{uploadPanelOpen ? "Close Upload" : "Upload More"}
			</button>
		</div>

		<!-- ── Upload Panel (inline, toggled by "Upload More" button) ── -->
		{#if uploadPanelOpen}
			<UploadPanel inline={true} />
		{/if}

		<!-- ── Materials indicator ── -->
		<div class="materials-section">
			<MaterialsIndicator />
		</div>

		<!-- ⚠️ Phase 2 stub: materials are always "present" in stub data. -->

		<!-- ── Dashboard table ── -->
		<SubmissionsDashboard
			submissions={submissions}
			searchQuery={searchQuery}
			statusFilter={statusFilter}
			onSearchChange={handleSearchChange}
			onStatusFilterChange={handleStatusFilterChange}
		/>

		<!-- ── Action bar ── -->
		<div class="action-bar">
			<div class="action-left">
				<button class="btn-action btn-primary" onclick={handleProcessAll}>
					Process All
				</button>
				<button
					class="btn-action btn-outline"
					onclick={handlePreEvaluateAll}
					disabled={!submissions.some(s => s.status === "executed" || s.status === "pre-evaluated")}
				>
					Pre-evaluate All
				</button>
			</div>
		</div>

		<!-- ── Compact upload zone (below table) ── -->
		<!-- Phase 2 stub: upload zone opens the inline UploadPanel with mock classification data -->
		<UploadBar compact={true} onClick={handleToggleUploadPanel} />
	</div>
{/if}

<style>
	.page-layout {
		padding: 24px 32px;
		max-width: 1200px;
		margin: 0 auto;
		width: 100%;
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	/* ── Assignment + Upload row ── */
	.assign-upload-row {
		display: flex;
		align-items: center;
		gap: 12px;
		flex-wrap: wrap;
	}
	.btn-upload-more {
		display: inline-flex;
		align-items: center;
		height: 34px;
		padding: 0 16px;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: transparent;
		font-size: 13px;
		font-weight: 500;
		color: var(--fg);
		cursor: pointer;
		transition: background 0.15s, border-color 0.15s;
		white-space: nowrap;
	}
	.btn-upload-more:hover {
		background: color-mix(in oklch, var(--fg) 4%, transparent);
		border-color: var(--muted);
	}

	/* ── Mobile dashboard ── */
	@media (max-width: 767px) {
		.page-layout {
			padding: 12px 16px;
			gap: 12px;
		}
		.assign-upload-row {
			flex-direction: column;
			align-items: stretch;
		}
		.btn-upload-more {
			width: 100%;
			justify-content: center;
		}
	}

	/* ── Materials indicator ── */
	.materials-section {
		padding: 0 14px;
		/* Match table cell horizontal padding so text aligns with card contents */
	}

	/* ── Action bar ── */
	.action-bar {
		display: flex;
		align-items: center;
		justify-content: flex-start;
	}
	.action-left {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.btn-action {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		height: 32px;
		padding: 0 14px;
		border-radius: var(--radius);
		font-size: 13px;
		font-weight: 500;
		white-space: nowrap;
		cursor: pointer;
		transition: background 0.15s, border-color 0.15s, opacity 0.15s;
	}
	.btn-action:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}
	.btn-primary {
		background: var(--accent);
		color: var(--accent-on);
		border: 1px solid var(--accent);
	}
	.btn-primary:hover:not(:disabled) {
		background: var(--accent-hover);
		border-color: var(--accent-hover);
	}
	.btn-outline {
		background: transparent;
		color: var(--fg);
		border: 1px solid var(--border);
	}
	.btn-outline:hover:not(:disabled) {
		background: color-mix(in oklch, var(--fg) 4%, transparent);
		border-color: var(--muted);
	}

	/* ── Responsive ── */
	@media (max-width: 900px) {
		.page-layout {
			padding: 16px;
		}
		.assign-upload-row {
			flex-direction: column;
			align-items: stretch;
		}
		.action-bar {
			flex-direction: column;
			align-items: flex-start;
		}
	}
</style>
