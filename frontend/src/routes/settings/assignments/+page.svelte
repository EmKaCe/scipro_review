<script lang="ts">
	/**
	 * @file /settings/assignments — assignment management surface.
	 *
	 * Lists assignments (enabled only, via GET /api/assignments — disabled
	 * entries appear after being created/toggled), and offers create / edit /
	 * delete plus criteria YAML upload per assignment. Delete uses a confirm
	 * dialog; the 409 "has submissions" message surfaces as a toast.
	 */

	import Pencil from "@lucide/svelte/icons/pencil";
	import Plus from "@lucide/svelte/icons/plus";
	import RefreshCw from "@lucide/svelte/icons/refresh-cw";
	import Settings2 from "@lucide/svelte/icons/settings-2";
	import Trash2 from "@lucide/svelte/icons/trash-2";
	import X from "@lucide/svelte/icons/x";

	import { base } from "$app/paths";

	import AssignmentForm, {
		type AssignmentFormPayload,
	} from "$lib/components/assignments/assignment-form.svelte";
	import CriteriaUpload from "$lib/components/assignments/criteria-upload.svelte";
	import ConfirmationDialog from "$lib/components/confirmation-dialog.svelte";
	import { Button } from "$lib/components/ui/button/index.js";
	import { buttonVariants } from "$lib/components/ui/button/button-variants.js";
	import { cn } from "$lib/utils.js";
	import {
		type AssignmentSummary,
		createAssignment,
		deleteAssignment,
		fetchAssignments,
		updateAssignment,
	} from "$lib/services/submissions-api.js";
	import { headerConfig } from "$lib/stores/header.svelte.js";
	import { addToast } from "$lib/stores/toast.svelte.js";

	// -----------------------------------------------------------------------
	// Header
	// -----------------------------------------------------------------------
	$effect(() => {
		headerConfig.headerState = "dashboard";
		headerConfig.showBack = true;
		headerConfig.breadcrumb = "Assignments";
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
	let assignments = $state<AssignmentSummary[]>([]);
	let isLoading = $state(true);
	let listError = $state<string | null>(null);
	/** The assignment being edited (or the "new" sentinel). */
	let editing = $state<AssignmentSummary | null>(null);
	let formOpen = $state(false);
	let saving = $state(false);
	/** Assignment targeted by the criteria upload row. */
	let uploadTarget = $state<AssignmentSummary | null>(null);
	let deleteTarget = $state<AssignmentSummary | null>(null);
	let deleting = $state(false);

	async function load() {
		isLoading = true;
		listError = null;
		try {
			const res = await fetchAssignments();
			assignments = res.assignments;
		} catch (err) {
			listError = err instanceof Error ? err.message : "Failed to load assignments";
		} finally {
			isLoading = false;
		}
	}

	// Load once on mount.
	$effect(() => {
		void load();
	});

	function startCreate() {
		editing = null;
		formOpen = true;
	}

	function startEdit(a: AssignmentSummary) {
		editing = a;
		formOpen = true;
	}

	function closeForm() {
		if (saving) return;
		formOpen = false;
		editing = null;
	}

	async function handleSubmit(input: AssignmentFormPayload) {
		saving = true;
		// A server rejection (400/409) is NOT caught here on purpose — it
		// propagates to the form's onSubmit rejection so the component can
		// display the message inline.
		try {
			if (editing) {
				await updateAssignment(editing.id, {
					title: input.title,
					enabled: input.enabled,
					criteria_files: input.criteria_files,
					dimensions: input.dimensions,
				});
				addToast("success", `Saved ${editing.id}`, 3000);
			} else {
				await createAssignment(input);
				addToast("success", `Created ${input.id}`, 3000);
			}
			formOpen = false;
			editing = null;
			await load();
		} finally {
			saving = false;
		}
	}

	async function handleDelete() {
		const target = deleteTarget;
		if (!target || deleting) return;
		deleting = true;
		try {
			await deleteAssignment(target.id);
			addToast("success", `Deleted ${target.id}`, 3000);
			deleteTarget = null;
			await load();
		} catch (err) {
			// e.g. the 409 "has submissions" guard.
			addToast("error", err instanceof Error ? err.message : "Delete failed", 4000);
		} finally {
			deleting = false;
		}
	}

	function handleUploaded(fileName: string) {
		addToast("success", `Uploaded ${fileName}`, 3000);
		uploadTarget = null;
		void load();
	}

	function criteriaCount(a: AssignmentSummary): number {
		return a.criteria_files.length;
	}
</script>

<svelte:head>
	<title>Assignments — SciPro Review</title>
</svelte:head>

<div class="page-layout">
	<div class="page-header">
		<div>
			<h1 class="page-title">Assignments</h1>
			<p class="page-subtitle">
				Manage the assignment registry, criteria files, and grading dimensions.
			</p>
		</div>
		<a
			class={cn(buttonVariants({ variant: "outline", size: "sm" }), "gap-1")}
			href={`${base}/settings`}
		>
			<X size={14} />
			Back to settings
		</a>
	</div>

	{#if isLoading}
		<div class="empty-card">Loading assignments…</div>
	{:else if listError}
		<div class="empty-card error-card">
			<p>{listError}</p>
			<Button variant="outline" size="sm" onclick={load}>
				<RefreshCw size={14} />
				Retry
			</Button>
		</div>
	{:else}
		<div class="toolbar">
			<Button variant="default" size="sm" onclick={startCreate}>
				<Plus size={14} />
				New assignment
			</Button>
		</div>

		{#if formOpen}
			<section class="card form-card">
				<div class="card-header">
					<h2>{editing ? `Edit ${editing.id}` : "New assignment"}</h2>
					<Button
						variant="ghost"
						size="icon"
						class="h-7 w-7"
						onclick={closeForm}
						aria-label="Close form"
					>
						<X size={16} />
					</Button>
				</div>
				<AssignmentForm initial={editing} onSubmit={handleSubmit} busy={saving} />
			</section>
		{/if}

		{#if assignments.length === 0 && !formOpen}
			<div class="empty-card">No assignments yet — create one to get started.</div>
		{/if}

		<ul class="assignment-list">
			{#each assignments as a (a.id)}
				<li class="card assignment-row">
					<div class="row-main">
						<div class="row-title">
							<span class="id">{a.id}</span>
							{#if a.enabled}
								<span class="badge badge-enabled">enabled</span>
							{:else}
								<span class="badge badge-disabled">disabled</span>
							{/if}
						</div>
						<p class="row-sub">
							{a.title} · {criteriaCount(a)} criteria file(s)
							{#if a.scoring_file}
								<span class="scoring-indicator"> · scoring config</span>
							{:else}
								<span
									class="not-calibrated-chip"
									title="No scoring config yet — pre-evaluation will skip calibration and use generic fallbacks"
								>
									· not calibrated
								</span>
							{/if}
						</p>
					</div>
					<div class="row-actions">
						<a
							class={cn(buttonVariants({ variant: "outline", size: "sm" }), "gap-1")}
							href={`${base}/settings/assignments/${a.id}/criteria`}
							title="Edit the rubric criteria for this assignment"
						>
							Edit criteria
						</a>
						<a
							class={cn(buttonVariants({ variant: "outline", size: "sm" }), "gap-1")}
							href={`${base}/settings/assignments/${a.id}/scoring`}
							title="Edit the scoring config for this assignment"
						>
							<Settings2 size={14} />
							Scoring
						</a>
						<Button
							variant="outline"
							size="sm"
							onclick={() => (uploadTarget = a)}
							title="Upload a criteria YAML file"
						>
							Upload criteria
						</Button>
						<Button variant="outline" size="sm" onclick={() => startEdit(a)}>
							<Pencil size={14} />
							Edit
						</Button>
						<Button
							variant="outline"
							size="sm"
							onclick={() => (deleteTarget = a)}
							class="text-destructive hover:text-destructive"
						>
							<Trash2 size={14} />
							Delete
						</Button>
					</div>
				</li>
				{#if uploadTarget?.id === a.id}
					<li class="card upload-card">
						<CriteriaUpload assignmentId={a.id} onUploaded={handleUploaded} />
					</li>
				{/if}
			{/each}
		</ul>
	{/if}
</div>

<!-- Delete confirmation (requires typing the assignment id). -->
<ConfirmationDialog
	open={deleteTarget !== null}
	title="Delete Assignment"
	message={deleteTarget
		? `Permanently delete <span class="font-medium text-foreground">${deleteTarget.id}</span>? Assignments with submissions cannot be deleted. This cannot be undone.`
		: ""}
	confirmLabel="Delete"
	variant="danger"
	requireTyping={deleteTarget?.id ?? ""}
	onconfirm={handleDelete}
	oncancel={() => (deleteTarget = null)}
/>

<style>
	.page-layout {
		padding: 24px 32px;
		max-width: 960px;
		margin: 0 auto;
		width: 100%;
		display: flex;
		flex-direction: column;
		gap: 16px;
	}
	.page-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 12px;
	}
	.page-title {
		margin: 0;
		font-size: 20px;
		font-weight: 650;
		letter-spacing: -0.01em;
	}
	.page-subtitle {
		margin: 4px 0 0;
		font-size: 13.5px;
		color: var(--muted-foreground);
	}
	.toolbar {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.card {
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--card);
	}
	.form-card {
		padding: 16px;
	}
	.card-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 14px;
	}
	.card-header h2 {
		margin: 0;
		font-size: 15px;
		font-weight: 600;
	}
	.icon-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		border: none;
		border-radius: var(--radius);
		background: transparent;
		color: var(--muted-foreground);
		cursor: pointer;
	}
	.icon-btn:hover {
		background: color-mix(in oklch, var(--fg) 6%, transparent);
		color: var(--fg);
	}
	.assignment-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.assignment-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 12px 14px;
		flex-wrap: wrap;
	}
	.row-main {
		min-width: 0;
	}
	.row-title {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.id {
		font-family: var(--font-mono, monospace);
		font-size: 13.5px;
		font-weight: 600;
	}
	.badge {
		font-size: 11px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		padding: 2px 8px;
		border-radius: 999px;
	}
	.badge-enabled {
		background: color-mix(in oklch, var(--primary) 14%, transparent);
		color: var(--primary);
	}
	.badge-disabled {
		background: color-mix(in oklch, var(--muted) 14%, transparent);
		color: var(--muted-foreground);
	}
	.row-sub {
		margin: 3px 0 0;
		font-size: 13px;
		color: var(--muted-foreground);
	}
	.scoring-indicator {
		color: var(--muted-foreground);
	}
	.not-calibrated-chip {
		color: color-mix(in oklch, var(--muted-foreground) 78%, transparent);
		font-style: italic;
	}
	.row-actions {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}
	.upload-card {
		padding: 14px;
	}
	.empty-card {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 12px;
		padding: 32px;
		border: 1px dashed var(--border);
		border-radius: var(--radius);
		color: var(--muted-foreground);
		font-size: 14px;
		text-align: center;
	}
	.error-card p {
		margin: 0;
		color: var(--destructive);
	}

	@media (max-width: 767px) {
		.page-layout {
			padding: 12px 16px;
		}
		.assignment-row {
			flex-direction: column;
			align-items: flex-start;
		}
	}
</style>
