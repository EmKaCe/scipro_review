<script lang="ts">
	import { onMount } from "svelte";
	import CircleCheck from "@lucide/svelte/icons/circle-check";
	import CircleX from "@lucide/svelte/icons/circle-x";
	import Database from "@lucide/svelte/icons/database";
	import FileText from "@lucide/svelte/icons/file-text";
	import FolderX from "@lucide/svelte/icons/folder-x";
	import Trash2 from "@lucide/svelte/icons/trash-2";

	import {
		deleteMaterial,
		fetchMaterials,
		type MaterialsStatus,
	} from "$lib/services/submissions-api.js";
	import { addToast } from "$lib/stores/toast.svelte.js";

	interface Props {
		assignmentId: string;
		/** Current materials state (from the parent's indicator fetch). */
		materials: MaterialsStatus | null;
		onChange: (status: MaterialsStatus) => void;
	}

	let { assignmentId, materials, onChange }: Props = $props();

	let busy = $state(false);
	let deleting = $state<string | null>(null);

	function kindLabel(kind: MaterialsStatus["files"][number]["kind"]): string {
		return kind === "material-data" ? "Input data" : "Material";
	}

	function kindIcon(kind: MaterialsStatus["files"][number]["kind"]) {
		return kind === "material-data" ? Database : FileText;
	}

	async function handleDeleteFile(name: string) {
		if (deleting) return;
		deleting = name;
		try {
			const { status } = await deleteMaterial(assignmentId, name);
			onChange(status);
			addToast("success", `Removed ${name}`, 3000);
		} catch (err) {
			addToast(
				"error",
				err instanceof Error ? err.message : "Failed to delete material",
				4000,
			);
		} finally {
			deleting = null;
		}
	}

	async function handleClearAll() {
		if (busy) return;
		if (!confirm("Remove ALL materials for this assignment? This cannot be undone.")) return;
		busy = true;
		try {
			const { status } = await deleteMaterial(assignmentId);
			onChange(status);
			addToast("success", "All materials removed", 3000);
		} catch (err) {
			addToast(
				"error",
				err instanceof Error ? err.message : "Failed to clear materials",
				4000,
			);
		} finally {
			busy = false;
		}
	}

	onMount(() => {
		fetchMaterials(assignmentId)
			.then(onChange)
			.catch(() => {
				// parent keeps showing the previous status; errors surface via toasts
			});
	});

	// Re-fetch when the assignment changes.
	$effect(() => {
		const id = assignmentId;
		fetchMaterials(id)
			.then(onChange)
			.catch(() => {});
	});
</script>

<div class="materials-manager">
	<div class="mm-header">
		<span class="mm-title">Assignment materials</span>
		<span class="mm-subtitle">
			{assignmentId} · files copied into the execution sandbox (input data) / used for reference
			(key, PDF)
		</span>
	</div>

	{#if !materials || materials.files.length === 0}
		<div class="mm-empty">
			<FolderX size={18} />
			<span
				>No materials uploaded yet — upload the assignment PDF, key notebook, and input data
				files.</span
			>
		</div>
	{:else}
		<ul class="mm-list">
			{#each materials.files as file (file.relativePath)}
				{@const Icon = kindIcon(file.kind)}
				<li class="mm-row">
					<Icon size={14} class="mm-row-icon" />
					<span class="mm-row-kind">{kindLabel(file.kind)}</span>
					<span class="mm-row-name">{file.name}</span>
					<button
						class="mm-delete"
						title="Delete this file"
						disabled={deleting === file.name}
						onclick={() => handleDeleteFile(file.name)}
					>
						<Trash2 size={13} />
						{deleting === file.name ? "…" : "Delete"}
					</button>
				</li>
			{/each}
		</ul>
		<div class="mm-footer">
			<span class="mm-summary">
				<CircleCheck size={12} class="mm-check" /> PDF {materials.hasPdf ? "✓" : "—"}
				· Key {materials.hasKey ? "✓" : "—"}
				· Data {materials.hasInputData ? "✓" : "—"}
			</span>
			<button class="mm-clear" disabled={busy} onclick={handleClearAll}>
				<CircleX size={13} />
				Clear all
			</button>
		</div>
	{/if}
</div>

<style>
	.materials-manager {
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--card);
		padding: 12px 14px;
		margin-bottom: 12px;
	}
	.mm-header {
		display: flex;
		align-items: baseline;
		gap: 10px;
		flex-wrap: wrap;
		margin-bottom: 8px;
	}
	.mm-title {
		font-size: 13px;
		font-weight: 600;
		color: var(--fg);
	}
	.mm-subtitle {
		font-size: 11px;
		color: var(--muted-foreground);
	}
	.mm-empty {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 10px 12px;
		border: 1px dashed var(--border);
		border-radius: var(--radius-md);
		font-size: 12px;
		color: var(--muted-foreground);
	}
	.mm-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.mm-row {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 10px;
		border-radius: var(--radius-md);
		background: color-mix(in oklch, var(--fg) 3%, transparent);
		font-size: 12px;
	}
	:global(.mm-row-icon) {
		color: var(--muted-foreground);
		flex-shrink: 0;
	}
	.mm-row-kind {
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--muted-foreground);
		min-width: 62px;
	}
	.mm-row-name {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--fg);
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 11px;
	}
	.mm-delete {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		border: 1px solid color-mix(in oklch, var(--error) 30%, transparent);
		border-radius: var(--radius-md);
		background: transparent;
		color: var(--error);
		font-size: 11px;
		font-weight: 500;
		padding: 3px 8px;
		cursor: pointer;
		transition: background 0.15s;
	}
	.mm-delete:hover:not(:disabled) {
		background: color-mix(in oklch, var(--error) 10%, transparent);
	}
	.mm-delete:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.mm-footer {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		margin-top: 10px;
	}
	.mm-summary {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-size: 11px;
		color: var(--muted-foreground);
	}
	:global(.mm-check) {
		color: var(--success);
	}
	.mm-clear {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: transparent;
		color: var(--fg);
		font-size: 11px;
		font-weight: 500;
		padding: 3px 8px;
		cursor: pointer;
	}
	.mm-clear:hover:not(:disabled) {
		background: color-mix(in oklch, var(--fg) 5%, transparent);
	}
	.mm-clear:disabled {
		opacity: 0.5;
		cursor: default;
	}
</style>
