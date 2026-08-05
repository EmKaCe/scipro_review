<script lang="ts">
	import { submissionsStore } from "$lib/services/submissions-store.js";
	import { headerConfig } from "$lib/stores/header.svelte.js";
	import { addToast } from "$lib/stores/toast.svelte.js";
	import { base } from "$app/paths";
	import type { SubmissionMeta } from "$lib/types/submissions.js";
	import SkeletonPulse from "$lib/components/ui/skeleton-pulse.svelte";
	import ConfigErrorBanner from "$lib/components/submissions/config-error-banner.svelte";
	import AlertTriangle from "@lucide/svelte/icons/alert-triangle";
	import RefreshCw from "@lucide/svelte/icons/refresh-cw";

	import AssignmentSelector from "$lib/components/submissions/assignment-selector.svelte";
	import UploadBar from "$lib/components/submissions/upload-bar.svelte";
	import UploadPanel from "$lib/components/submissions/upload-panel.svelte";
	import MaterialsIndicator from "$lib/components/submissions/materials-indicator.svelte";
	import MaterialsManager from "$lib/components/submissions/materials-manager.svelte";
	import SubmissionsDashboard from "$lib/components/submissions/submissions-dashboard.svelte";
	import MenuButton from "$lib/components/ui/menu-button.svelte";
	import ConfirmationDialog from "$lib/components/confirmation-dialog.svelte";
	import Archive from "@lucide/svelte/icons/archive";
	import {
		downloadBackup,
		fetchAssignments,
		fetchMaterials,
		restoreBackup,
	} from "$lib/services/submissions-api.js";
	import type { MaterialsStatus } from "$lib/services/submissions-api.js";

	// -----------------------------------------------------------------------
	// Header config
	// -----------------------------------------------------------------------
	$effect(() => {
		headerConfig.headerState = "dashboard";
		headerConfig.showBack = false;
		headerConfig.showImport = false;
		headerConfig.showSave = false;
		headerConfig.showExport = false;
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
	let selectedAssignment = $state("");
	/** Assignment dropdown options, fed from GET /api/assignments (no hardcoded stub). */
	let assignmentOptions = $state<{ id: string; label: string; disabled?: boolean }[]>([]);
	/** Set when GET /api/assignments fails; the selector then shows the empty placeholder. */
	let assignmentsError = $state<string | null>(null);
	/**
	 * Set when the assignment configuration (assignments list or materials)
	 * fails to load — surfaced as a dismissible banner above the table so a
	 * broken config is never a silent null (Phase 3g T3).
	 */
	let configError = $state<string | null>(null);
	let searchQuery = $state("");
	let statusFilter = $state("all");
	let uploadPanelOpen = $state(false);
	let processing = $state(false);
	/** Materials manager panel visibility (dashboard). */
	let materialsOpen = $state(false);
	/** Materials state for the selected assignment (B3 — real API). */
	let materials = $state<MaterialsStatus | null>(null);

	// -----------------------------------------------------------------------
	// Teacher backup (download / restore the whole data directory)
	// -----------------------------------------------------------------------
	let backupFileInput: HTMLInputElement | undefined = $state(undefined);
	let backupBusy = $state(false);

	async function handleDownloadBackup() {
		if (backupBusy) return;
		backupBusy = true;
		try {
			const { fileName, content } = await downloadBackup();
			const blob = new Blob([content], { type: "application/zip" });
			const url = URL.createObjectURL(blob);
			const link = document.createElement("a");
			link.href = url;
			link.download = fileName;
			link.click();
			URL.revokeObjectURL(url);
			addToast("success", `Backup downloaded: ${fileName}`, 3500);
		} catch (e) {
			addToast("error", e instanceof Error ? e.message : "Failed to download backup", 4000);
		} finally {
			backupBusy = false;
		}
	}

	function handleOpenBackupPicker() {
		backupFileInput?.click();
	}

	async function handleRestoreBackup(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = "";
		if (!file) return;
		backupBusy = true;
		try {
			const { restored } = await restoreBackup(file);
			addToast("success", `Backup restored (${restored} files). Reloading…`, 3500);
			await loadSubmissions();
		} catch (err) {
			addToast(
				"error",
				err instanceof Error ? err.message : "Failed to restore backup",
				4000,
			);
		} finally {
			backupBusy = false;
		}
	}

	// -----------------------------------------------------------------------
	// Data loading (Phase 3b store — real API)
	// -----------------------------------------------------------------------
	$effect(() => {
		// No assignment yet (still fetching the list) — skip the empty-id call.
		if (!selectedAssignment) return;
		loadSubmissions();
	});

	// Materials indicator: re-fetch whenever the selected assignment changes.
	$effect(() => {
		const assignmentId = selectedAssignment;
		if (!assignmentId) return;
		let cancelled = false;
		fetchMaterials(assignmentId)
			.then((m) => {
				if (!cancelled) materials = m;
			})
			.catch((e) => {
				if (cancelled) return;
				materials = null;
				configError =
					e instanceof Error ? e.message : "Failed to load assignment materials";
			});
		return () => {
			cancelled = true;
		};
	});

	// Assignment dropdown: fetch the enabled list once on mount and default
	// the selection to the first assignment. Until this resolves, the
	// selector renders the "No assignments configured" placeholder.
	$effect(() => {
		void (async () => {
			try {
				const { assignments } = await fetchAssignments();
				const options = assignments.map((a) => ({ id: a.id, label: a.title }));
				assignmentOptions = options;
				selectedAssignment = options[0]?.id ?? "";
				if (options.length === 0) {
					// Nothing to load — release the skeleton so the content
					// state renders with the empty selector placeholder.
					isLoading = false;
				}
			} catch (e) {
				const message = e instanceof Error ? e.message : "Failed to load assignments";
				assignmentsError = message;
				configError = message;
				isLoading = false;
				addToast("error", message, 4000);
			}
		})();
	});

	async function loadSubmissions() {
		isLoading = true;
		error = null;
		try {
			await submissionsStore.load(selectedAssignment);
			submissions = submissionsStore.submissions;
		} catch (e) {
			error = e instanceof Error ? e.message : "Failed to load submissions";
		} finally {
			isLoading = false;
		}
	}

	// -----------------------------------------------------------------------
	// Submission lifecycle: archive / restore / delete
	// -----------------------------------------------------------------------
	/** Pending delete target (confirm dialog). */
	let deleteTarget = $state<SubmissionMeta | null>(null);
	let deleting = $state(false);

	async function handleArchive(id: string, action: "archive" | "restore") {
		try {
			await submissionsStore.archive(id, action);
			addToast("success", action === "archive" ? `Archived ${id}` : `Restored ${id}`, 3000);
		} catch (e) {
			addToast("error", e instanceof Error ? e.message : "Archive action failed", 4000);
		}
	}

	function requestDelete(id: string) {
		const meta = submissions.find((s) => s.id === id) ?? null;
		deleteTarget = meta;
	}

	async function handleDelete() {
		const target = deleteTarget;
		if (!target || deleting) return;
		deleting = true;
		try {
			await submissionsStore.delete(target.id);
			addToast("success", `Deleted ${target.id}`, 3000);
		} catch (e) {
			addToast("error", e instanceof Error ? e.message : "Delete failed", 4000);
		} finally {
			deleting = false;
			deleteTarget = null;
		}
	}

	// -----------------------------------------------------------------------
	// Handlers
	// -----------------------------------------------------------------------
	function handleAssignmentChange(id: string) {
		selectedAssignment = id;
		// loadSubmissions() re-runs via the $effect on selectedAssignment.
	}

	function handleSearchChange(q: string) {
		searchQuery = q;
	}

	function handleStatusFilterChange(f: string) {
		statusFilter = f;
		// Reload with archived rows when the "Archived" filter is active.
		submissionsStore.includeArchived = f === "archived";
		void loadSubmissions();
	}

	async function handleProcessAll() {
		if (processing) return;
		const pending = submissions.filter((s) => s.status === "pending");
		if (pending.length === 0) {
			addToast("info", "No pending submissions to process", 3000);
			return;
		}
		processing = true;
		submissionsStore.startPolling(); // live row statuses while the synchronous batch runs
		try {
			const resp = await submissionsStore.process();
			addToast(
				"success",
				`Processed ${resp.succeeded} of ${resp.submitted} submission(s)${resp.failed > 0 ? `, ${resp.failed} failed` : ""}`,
				5000,
			);
		} catch (e) {
			addToast("error", e instanceof Error ? e.message : "Batch processing failed", 5000);
		} finally {
			processing = false;
		}
	}

	function handlePreEvaluateAll() {
		addToast("info", "Pre-evaluation coming in Phase 4", 4000);
	}

	function handleToggleUploadPanel() {
		uploadPanelOpen = !uploadPanelOpen;
	}

	/** After a successful panel upload: refresh materials + keep the list fresh. */
	async function handleUploaded() {
		try {
			materials = await fetchMaterials(selectedAssignment);
		} catch {
			materials = null;
		}
		submissions = submissionsStore.submissions;
	}
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
			{#each [1, 2, 3, 4, 5] as _i (_i)}
				<div
					class="flex items-center gap-4 border-b border-border px-3.5 py-2.5 last:border-0"
				>
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
				assignments={assignmentOptions}
				selected={selectedAssignment}
				onChange={handleAssignmentChange}
			/>
			<button class="btn-upload-more" onclick={handleToggleUploadPanel}>
				{uploadPanelOpen ? "Close Upload" : "Upload More"}
			</button>
		</div>

		<!-- ── Upload Panel (inline, toggled by "Upload More" button) ── -->
		{#if uploadPanelOpen}
			<UploadPanel
				inline={true}
				assignmentId={selectedAssignment}
				onUploaded={handleUploaded}
			/>
		{/if}

		<!-- ── Materials: indicator (toggles the manager) + management panel ── -->
		<div class="materials-section">
			<button
				class="materials-toggle"
				title="Manage assignment materials (upload, replace, delete)"
				onclick={() => (materialsOpen = !materialsOpen)}
			>
				<MaterialsIndicator
					materials={[
						{ label: "PDF", present: materials?.hasPdf ?? false },
						{ label: "Key", present: materials?.hasKey ?? false },
						{ label: "Data", present: materials?.hasInputData ?? false },
					]}
				/>
				<span class="materials-toggle-label">{materialsOpen ? "Hide" : "Manage"}</span>
			</button>
			{#if materialsOpen}
				<MaterialsManager
					assignmentId={selectedAssignment}
					{materials}
					onChange={(status) => (materials = status)}
				/>
			{/if}
		</div>

		<!-- ── Dashboard table ── -->
		{#if configError}
			<ConfigErrorBanner message={configError} onDismiss={() => (configError = null)} />
		{/if}
		<SubmissionsDashboard
			{submissions}
			{searchQuery}
			{statusFilter}
			assignmentId={selectedAssignment}
			onSearchChange={handleSearchChange}
			onStatusFilterChange={handleStatusFilterChange}
			onArchive={handleArchive}
			onDelete={requestDelete}
		/>

		<!-- ── Action bar ── -->
		{#if assignmentsError}
			<p class="assignments-error">Assignments unavailable: {assignmentsError}</p>
		{/if}
		<div class="action-bar">
			<div class="action-left">
				<button
					class="btn-action btn-primary"
					onclick={handleProcessAll}
					disabled={processing}
				>
					{processing
						? `Processing ${submissions.filter((s) => s.status === "executing").length}/${submissions.filter((s) => s.status === "pending").length + submissions.filter((s) => s.status === "executing").length}…`
						: "Process All"}
				</button>
				<button
					class="btn-action btn-outline"
					onclick={handlePreEvaluateAll}
					disabled={!submissions.some(
						(s) => s.status === "executed" || s.status === "pre-evaluated",
					)}
				>
					Pre-evaluate All
				</button>
				{#snippet backupIcon()}
					<Archive size={14} />
				{/snippet}
				<MenuButton
					label="Backup"
					primaryOnClick={handleDownloadBackup}
					items={[
						{
							id: "restore",
							label: "Restore backup…",
							description: "Import a teacher backup zip (replaces data directory)",
							onclick: handleOpenBackupPicker,
						},
					]}
					icon={backupIcon}
					groupClass="btn-action btn-outline"
					variantClass="gap-1.5"
				/>
				<input
					type="file"
					accept=".zip,application/zip"
					hidden
					bind:this={backupFileInput}
					onchange={handleRestoreBackup}
				/>
			</div>
		</div>

		<!-- ── Compact upload zone (below table) ── -->
		<!-- Phase 2 stub: upload zone opens the inline UploadPanel with mock classification data -->
		<UploadBar compact={true} onClick={handleToggleUploadPanel} />
	</div>
{/if}

<!-- Delete confirmation (destructive, requires typing the student ID). -->
<ConfirmationDialog
	open={deleteTarget !== null}
	title="Delete Submission"
	message={deleteTarget
		? `Permanently delete <span class="font-medium text-foreground">${deleteTarget.studentId}</span>? This removes the notebook, its execution results, and its plagiarism pairs. This cannot be undone.`
		: ""}
	confirmLabel="Delete"
	variant="danger"
	requireTyping={deleteTarget?.studentId ?? ""}
	onconfirm={handleDelete}
	oncancel={() => (deleteTarget = null)}
/>

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
		transition:
			background 0.15s,
			border-color 0.15s;
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
	.materials-toggle {
		display: inline-flex;
		align-items: center;
		gap: 10px;
		background: transparent;
		border: none;
		cursor: pointer;
		padding: 2px 0;
		font: inherit;
	}
	.materials-toggle-label {
		font-size: 11px;
		font-weight: 500;
		color: var(--primary);
	}

	/* ── Action bar ── */
	.action-bar {
		display: flex;
		align-items: center;
		justify-content: flex-start;
	}
	.assignments-error {
		margin: 0;
		font-size: 13px;
		color: var(--destructive);
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
		transition:
			background 0.15s,
			border-color 0.15s,
			opacity 0.15s;
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
