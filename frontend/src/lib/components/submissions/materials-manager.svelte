<script lang="ts">
	import { onMount } from "svelte";
	import CircleAlert from "@lucide/svelte/icons/circle-alert";
	import CircleCheck from "@lucide/svelte/icons/circle-check";
	import CircleX from "@lucide/svelte/icons/circle-x";
	import Database from "@lucide/svelte/icons/database";
	import FileText from "@lucide/svelte/icons/file-text";
	import FolderX from "@lucide/svelte/icons/folder-x";
	import KeyRound from "@lucide/svelte/icons/key-round";
	import Loader from "@lucide/svelte/icons/loader";
	import Trash2 from "@lucide/svelte/icons/trash-2";
	import Upload from "@lucide/svelte/icons/upload";

	import {
		deleteMaterial,
		fetchMaterials,
		uploadMaterials,
		type MaterialUploadResult,
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
	let uploading = $state(false);
	let uploadResults = $state<MaterialUploadResult[]>([]);
	let inputRef: HTMLInputElement | undefined = $state(undefined);

	function kindLabelFor(name: string, kind: MaterialsStatus["files"][number]["kind"]): string {
		if (kind === "material-data") return "Input data";
		const lower = name.toLowerCase();
		if (lower === "key.ipynb" || lower.endsWith("_key.ipynb")) return "Key";
		if (lower.endsWith(".pdf")) return "PDF";
		return "Material";
	}

	function kindIconFor(name: string, kind: MaterialsStatus["files"][number]["kind"]) {
		if (kind === "material-data") return Database;
		const lower = name.toLowerCase();
		if (lower === "key.ipynb" || lower.endsWith("_key.ipynb")) return KeyRound;
		return FileText;
	}

	function handlePick() {
		inputRef?.click();
	}

	async function handleFiles(e: Event) {
		const list = (e.currentTarget as HTMLInputElement).files;
		if (!list || list.length === 0) return;
		const files = Array.from(list);
		uploading = true;
		uploadResults = [];
		try {
			const { status, results } = await uploadMaterials(assignmentId, files);
			uploadResults = results;
			onChange(status);
			const ok = results.filter((r) => !r.error).length;
			const failed = results.length - ok;
			addToast(
				"success",
				`${ok} material file(s) uploaded${failed > 0 ? ` · ${failed} failed` : ""}`,
				4000,
			);
		} catch (err) {
			addToast(
				"error",
				err instanceof Error ? err.message : "Failed to upload materials",
				4000,
			);
		} finally {
			uploading = false;
			if (inputRef) inputRef.value = "";
		}
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

	<input
		type="file"
		multiple
		accept=".pdf,.ipynb,.csv,.tsv,.txt,.dat,.xlsx,.xls,.json,.npz,.npy,.pkl,.pickle,.parquet,.h5,.hdf5,.mat,.zip,.gz"
		class="hidden-input"
		bind:this={inputRef}
		onchange={handleFiles}
	/>

	<div class="mm-upload-bar">
		<button class="mm-upload" type="button" disabled={uploading || busy} onclick={handlePick}>
			{#if uploading}
				<Loader size={13} class="mm-spin" />
				Uploading…
			{:else}
				<Upload size={13} />
				Upload materials
			{/if}
		</button>
		<span class="mm-upload-hint">PDF, key notebook, and input-data files</span>
	</div>

	{#if uploadResults.length > 0}
		<ul class="mm-upload-results">
			{#each uploadResults as result (result.name)}
				<li class="mm-row" class:mm-error-row={result.error}>
					{#if result.error}
						<CircleAlert size={13} class="mm-error-icon" />
					{:else}
						<CircleCheck size={13} class="mm-ok-icon" />
					{/if}
					<span class="mm-row-kind">{kindLabelFor(result.name, result.kind)}</span>
					<span class="mm-row-name" class:mm-error-name={result.error}>{result.name}</span
					>
					{#if result.error}
						<span class="mm-error-text">{result.error}</span>
					{:else if result.replaced}
						<span class="mm-replaced">Replaced</span>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}

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
				{@const Icon = kindIconFor(file.name, file.kind)}
				<li class="mm-row">
					<Icon size={14} class="mm-row-icon" />
					<span class="mm-row-kind">{kindLabelFor(file.name, file.kind)}</span>
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
	.hidden-input {
		display: none;
	}
	.mm-upload-bar {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-bottom: 10px;
	}
	.mm-upload {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: var(--bg);
		color: var(--fg);
		font-size: 12px;
		font-weight: 500;
		padding: 5px 12px;
		cursor: pointer;
		transition:
			background 0.15s,
			border-color 0.15s;
	}
	.mm-upload:hover:not(:disabled) {
		background: color-mix(in oklch, var(--fg) 5%, transparent);
		border-color: var(--muted);
	}
	.mm-upload:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.mm-upload-hint {
		font-size: 11px;
		color: var(--muted-foreground);
	}
	:global(.mm-spin) {
		animation: mm-spin 0.9s linear infinite;
	}
	@keyframes mm-spin {
		to {
			transform: rotate(360deg);
		}
	}
	.mm-upload-results {
		list-style: none;
		margin: 0 0 10px;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.mm-upload-results .mm-row {
		background: transparent;
	}
	.mm-error-row {
		background: color-mix(in oklch, var(--error) 6%, transparent);
	}
	:global(.mm-ok-icon) {
		color: var(--success);
		flex-shrink: 0;
	}
	:global(.mm-error-icon) {
		color: var(--error);
		flex-shrink: 0;
	}
	.mm-error-name {
		color: var(--error);
	}
	.mm-error-text {
		font-size: 11px;
		color: var(--error);
		flex-shrink: 0;
	}
	.mm-replaced {
		font-size: 10px;
		font-weight: 500;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--muted-foreground);
		flex-shrink: 0;
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
