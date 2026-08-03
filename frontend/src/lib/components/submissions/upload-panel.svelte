<script lang="ts">
	/**
	 * @file Upload Panel — real upload flow (Phase 3f B2).
	 *
	 * Empty → uploading → results. Files go straight to the backend via
	 * submissionsStore.upload; the server classifies each file and returns
	 * per-file results (kind, replaced, per-file error). No preview/edit
	 * machinery — classification is deterministic server-side (DDR P3-7).
	 */

	import Upload from "@lucide/svelte/icons/upload";
	import Loader from "@lucide/svelte/icons/loader";
	import CircleCheck from "@lucide/svelte/icons/circle-check";
	import CircleAlert from "@lucide/svelte/icons/circle-alert";
	import { submissionsStore } from "$lib/services/submissions-store.js";
	import type { SubmissionUploadResult } from "$lib/services/submissions-api.js";
	import { addToast } from "$lib/stores/toast.svelte.js";

	interface Props {
		/** If true, renders as a full-width card inline with page content. */
		inline?: boolean;
		/** Assignment the uploaded files belong to. */
		assignmentId: string;
		/** Invoked after a successful (non-throwing) upload. */
		onUploaded?: () => void;
		/** Invoked when the user dismisses the results via Done. */
		onClose?: () => void;
	}

	let { inline = false, assignmentId, onUploaded, onClose }: Props = $props();

	let results = $state<SubmissionUploadResult[]>([]);
	let uploading = $state(false);
	let uploadingCount = $state(0);
	let error = $state<string | null>(null);
	let inputRef: HTMLInputElement | undefined = $state(undefined);

	let hasResults = $derived(results.length > 0);
	let okCount = $derived(results.filter((r) => !r.error).length);
	let failedCount = $derived(results.length - okCount);

	function handlePick() {
		inputRef?.click();
	}

	function kindLabel(kind: SubmissionUploadResult["kind"]): string {
		switch (kind) {
			case "submission":
				return "Submission";
			case "material-data":
				return "Input Data";
			case "material-file":
				return "Material";
		}
	}

	function chipClass(kind: SubmissionUploadResult["kind"]): string {
		switch (kind) {
			case "submission":
				return "chip-submission";
			case "material-data":
				return "chip-data";
			case "material-file":
				return "chip-material";
		}
	}

	async function handleFiles(e: Event) {
		const list = (e.currentTarget as HTMLInputElement).files;
		if (!list || list.length === 0) return;
		const files = Array.from(list);
		uploading = true;
		uploadingCount = files.length;
		error = null;
		try {
			// Ensure the store targets this assignment before upload.
			if (submissionsStore.assignmentId !== assignmentId) {
				await submissionsStore.load(assignmentId);
			}
			const res = await submissionsStore.upload(files);
			results = res.results;
			onUploaded?.();
			const ok = res.results.filter((r) => !r.error).length;
			const failed = res.results.length - ok;
			addToast(
				"success",
				`${ok} file(s) uploaded${failed > 0 ? ` · ${failed} failed` : ""}`,
				4000,
			);
		} catch (err) {
			error = err instanceof Error ? err.message : "Upload failed";
		} finally {
			uploading = false;
			if (inputRef) inputRef.value = "";
		}
	}

	function handleDone() {
		results = [];
		onClose?.();
	}
</script>

<div class="upload-panel" class:inline>
	<!-- Card header -->
	<div class="panel-header">
		<h1 class="panel-title">Upload Files</h1>
	</div>

	<!-- Hidden native picker -->
	<input
		type="file"
		multiple
		accept=".ipynb,.pdf,.csv,.tsv,.txt,.dat,.xlsx,.xls,.json,.npz,.npy,.pkl,.pickle,.parquet,.h5,.hdf5,.mat,.zip,.gz"
		class="hidden-input"
		bind:this={inputRef}
		onchange={handleFiles}
	/>

	{#if uploading}
		<!-- ── Uploading state: spinner + progress note, drop zone disabled ── -->
		<div class="drop-zone drop-zone-disabled" aria-busy="true">
			<span class="spinner"><Loader size={24} /></span>
			<p class="drop-zone-title">Uploading {uploadingCount} file(s)…</p>
		</div>
	{:else if hasResults}
		<!-- ── Results state: server response table ── -->
		<p class="results-summary">
			<span class="summary-ok">{okCount} files uploaded</span>
			{#if failedCount > 0}
				<span class="summary-failed"> · {failedCount} failed</span>
			{/if}
		</p>

		<div class="class-table-wrap">
			<table class="class-table">
				<thead>
					<tr>
						<th>File</th>
						<th>Type</th>
						<th>Status</th>
					</tr>
				</thead>
				<tbody>
					{#each results as result, i (i)}
						<tr class:upload-error-row={result.error}>
							<td>
								<span class="file-name" class:file-error={result.error}
									>{result.fileName}</span
								>
								{#if result.error}
									<span class="upload-error-message">
										<CircleAlert size={12} />
										{result.error}
									</span>
								{/if}
							</td>
							<td>
								<span class="chip {chipClass(result.kind)}"
									>{kindLabel(result.kind)}</span
								>
							</td>
							<td>
								{#if result.error}
									<span class="status-failed">Failed</span>
								{:else if result.replaced}
									<span class="badge-replaced">Replaced</span>
								{:else}
									<span class="status-uploaded"
										><CircleCheck size={12} /> Uploaded</span
									>
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>

		<!-- Compressed drop bar (still active → picks more files) -->
		<div
			class="drop-bar"
			role="button"
			tabindex="0"
			onclick={handlePick}
			onkeydown={(e) => e.key === "Enter" && handlePick()}
		>
			<span class="drop-bar-icon"><Upload size={16} /></span>
			<span class="drop-bar-text">Drop more files or click to add</span>
		</div>

		<!-- Done → back to empty -->
		<div class="results-footer">
			<button class="done-btn" type="button" onclick={handleDone}>Done</button>
		</div>
	{:else}
		<!-- ── Empty state: drop zone ── -->
		<div
			class="drop-zone"
			role="button"
			tabindex="0"
			onclick={handlePick}
			onkeydown={(e) => e.key === "Enter" && handlePick()}
		>
			<span class="drop-zone-icon"><Upload size={32} /></span>
			<p class="drop-zone-title">Drop files here or click to browse</p>
			<p class="drop-zone-sub">Supports .ipynb, .pdf, .csv, and other assignment files</p>
			<button class="browse-btn" type="button" onclick={handlePick}>
				<Upload size={14} />
				Browse Files
			</button>
			{#if error}
				<p class="upload-error-message">{error}</p>
			{/if}
		</div>

		<!-- Detection rules help -->
		<div class="detection-rules">
			<strong>Auto-detection:</strong> filenames like
			<code>2026SS_01.ipynb</code> are classified as <strong>Submission</strong>; data files
			(.csv, .xlsx, …) as <strong>Input Data</strong>; everything else (e.g. .pdf) as
			<strong>Material</strong>.
		</div>
	{/if}
</div>

<style>
	/* ── Panel container ── */
	.upload-panel {
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		background: var(--card);
		overflow: hidden;
	}
	.upload-panel.inline .panel-header {
		padding: 16px 14px 0;
	}
	.upload-panel.inline .drop-zone {
		margin: 14px;
	}
	.upload-panel.inline .drop-bar {
		margin: 10px 14px 0;
	}
	.upload-panel.inline .detection-rules {
		margin: 8px 14px 14px;
		padding: 8px 12px;
	}
	.upload-panel.inline .class-table-wrap {
		margin: 0 14px;
	}
	.upload-panel.inline .results-summary {
		padding: 14px 14px 8px;
	}
	.upload-panel.inline .results-footer {
		padding: 12px 14px 14px;
	}

	/* ── Header ── */
	.panel-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 20px 24px 0;
		gap: 16px;
		flex-wrap: wrap;
	}
	.panel-title {
		font-size: 16px;
		font-weight: 600;
		letter-spacing: -0.01em;
		color: var(--fg);
		white-space: nowrap;
	}

	/* ── Hidden picker ── */
	.hidden-input {
		display: none;
	}

	/* ── Drop zone (empty + uploading states) ── */
	.drop-zone {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 6px;
		margin: 24px;
		padding: 36px 20px;
		border: 2px dashed var(--border);
		border-radius: var(--radius-lg);
		background: var(--bg);
		cursor: pointer;
		transition:
			border-color 0.15s,
			background 0.15s;
	}
	.drop-zone:hover {
		border-color: var(--accent);
		background: color-mix(in oklch, var(--accent) 2%, transparent);
	}
	.drop-zone-disabled {
		opacity: 0.45;
		pointer-events: none;
		cursor: default;
	}
	.drop-zone-disabled:hover {
		border-color: var(--border);
		background: var(--bg);
	}
	.drop-zone-icon {
		display: inline-flex;
		color: var(--muted-foreground);
		margin-bottom: 2px;
	}
	.drop-zone-title {
		font-size: 14px;
		font-weight: 500;
		color: var(--fg);
	}
	.drop-zone-sub {
		font-size: 12px;
		color: var(--muted-foreground);
		text-align: center;
	}
	.spinner {
		display: inline-flex;
		animation: spin 0.9s linear infinite;
		color: var(--accent);
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
	.browse-btn {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		margin-top: 10px;
		padding: 7px 20px;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--bg);
		color: var(--fg);
		font-size: 13px;
		font-weight: 500;
		cursor: pointer;
		transition:
			background 0.15s,
			border-color 0.15s;
	}
	.browse-btn:hover {
		background: color-mix(in oklch, var(--fg) 4%, transparent);
		border-color: var(--muted);
	}

	/* ── Drop bar (results state) ── */
	.drop-bar {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		margin: 16px 24px 0;
		padding: 12px 16px;
		border: 2px dashed var(--border);
		border-radius: var(--radius-md);
		background: color-mix(in oklch, var(--accent) 4%, transparent);
		cursor: pointer;
		transition:
			border-color 0.15s,
			background 0.15s;
	}
	.drop-bar:hover {
		border-color: var(--accent);
	}
	.drop-bar-icon {
		display: inline-flex;
		color: var(--accent);
		flex-shrink: 0;
	}
	.drop-bar-text {
		font-size: 13px;
		font-weight: 500;
		color: var(--fg);
	}

	/* ── Detection rules help ── */
	.detection-rules {
		margin: 12px 24px 24px;
		padding: 10px 14px;
		background: color-mix(in oklch, var(--info) 6%, transparent);
		border-radius: var(--radius-sm);
		font-size: 11px;
		color: var(--muted-foreground);
		line-height: 1.5;
	}
	.detection-rules code {
		font-family: ui-monospace, monospace;
		background: var(--muted);
		padding: 1px 4px;
		border-radius: 3px;
		font-size: 10px;
	}

	/* ── Results summary ── */
	.results-summary {
		padding: 16px 24px 0;
		font-size: 13px;
		font-weight: 500;
		color: var(--fg);
	}
	.summary-failed {
		color: var(--error);
	}

	/* ── Results table ── */
	.class-table-wrap {
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		margin: 10px 24px 0;
		overflow: hidden;
	}
	.class-table {
		border-collapse: collapse;
		width: 100%;
		font-size: 13px;
	}
	.class-table thead {
		background: var(--muted-bg);
		border-bottom: 1px solid var(--border);
	}
	.class-table th {
		text-align: left;
		padding: 10px 14px;
		font-size: 11px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--muted-foreground);
		white-space: nowrap;
	}
	.class-table td {
		padding: 10px 14px;
		border-bottom: 1px solid var(--border);
		vertical-align: middle;
	}
	.class-table tbody tr:last-child td {
		border-bottom: none;
	}
	.class-table tbody tr:hover {
		background: color-mix(in oklch, var(--accent) 3%, transparent);
	}
	.file-name {
		font-family: var(--font-mono);
		font-size: 12px;
		color: var(--fg);
		word-break: break-all;
	}
	.file-error {
		color: var(--error);
	}
	.upload-error-row {
		background: color-mix(in oklch, var(--error) 6%, transparent);
	}
	.class-table tbody tr.upload-error-row:hover {
		background: color-mix(in oklch, var(--error) 10%, transparent);
	}
	.upload-error-message {
		display: flex;
		align-items: center;
		gap: 4px;
		margin-top: 4px;
		font-size: 11px;
		color: var(--error);
	}
	.status-uploaded {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-size: 12px;
		color: var(--success);
	}
	.status-failed {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-size: 12px;
		font-weight: 500;
		color: var(--error);
	}
	.badge-replaced {
		display: inline-flex;
		align-items: center;
		padding: 2px 8px;
		border-radius: 999px;
		font-size: 11px;
		font-weight: 500;
		background: var(--muted);
		color: var(--muted-foreground);
	}

	/* ── Kind chips (server classification, DDR P3-7) ── */
	.chip {
		display: inline-flex;
		align-items: center;
		padding: 2px 8px;
		border-radius: 999px;
		font-size: 11px;
		font-weight: 500;
		line-height: 1.4;
		white-space: nowrap;
	}
	.chip-submission {
		background: oklch(0.92 0.045 195);
		color: oklch(0.55 0.12 195);
	}
	.chip-data {
		background: oklch(0.9 0.1 145);
		color: oklch(0.5 0.15 145);
	}
	.chip-material {
		background: var(--muted);
		color: var(--muted-foreground);
	}

	/* ── Results footer ── */
	.results-footer {
		display: flex;
		justify-content: flex-end;
		padding: 12px 24px 20px;
	}
	.done-btn {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 8px 20px;
		font-size: 13px;
		font-weight: 500;
		color: var(--accent-on);
		background: var(--accent);
		border: none;
		border-radius: var(--radius);
		cursor: pointer;
		transition: background 0.15s;
	}
	.done-btn:hover {
		background: var(--accent-hover);
	}

	/* ── Dark mode refinements ── */
	:global(.dark) .chip-submission {
		background: oklch(0.25 0.05 195);
		color: oklch(0.65 0.1 195);
	}
	:global(.dark) .chip-data {
		background: oklch(0.22 0.08 145);
		color: oklch(0.6 0.15 145);
	}
	:global(.dark) .drop-zone {
		background: var(--muted-bg);
	}
	:global(.dark) .drop-zone:hover {
		background: color-mix(in oklch, var(--accent) 8%, var(--muted-bg));
	}
	:global(.dark) .drop-bar {
		background: color-mix(in oklch, var(--accent) 10%, var(--bg));
	}
	:global(.dark) .drop-bar:hover {
		background: color-mix(in oklch, var(--accent) 15%, var(--bg));
	}
</style>
