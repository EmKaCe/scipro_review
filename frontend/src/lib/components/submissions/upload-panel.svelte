<script lang="ts">
	/**
	 * @file Upload Panel — Unified upload flow with smart classification.
	 *
	 * Phase 2: stub — operates on in-memory mock data, shows toasts.
	 * Phase 3: real file upload via backend.
	 */

	import Upload from "@lucide/svelte/icons/upload";
	import { addToast } from "$lib/stores/toast.svelte.js";

	/** Phase 2 stub flag — set false when backend is wired. */
	const IS_PHASE_2_STUB = true;

	interface DetectedFile {
		id: string;
		name: string;
		type: "submission" | "key" | "data" | "pdf";
		confidence: number;
		editing: boolean;
	}

	type UploadPhase = "empty" | "detected" | "reviewing";

	interface Props {
		/** If true, renders as a full‑width card inline with page content. */
		inline?: boolean;
	}

	let { inline = false }: Props = $props();

	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	let uploadPhase: UploadPhase = $state("empty");
	let files: DetectedFile[] = $state([]);

	let hasFiles: boolean = $derived(files.length > 0);

	const detectionPattern = "^\\d{4}[WS]S_";

	// ── Stub simulation ──

	function simulateFileDetection() {
		if (!IS_PHASE_2_STUB) return;
		files = [
			{
				id: "f1",
				name: "2026SS_03_student.ipynb",
				type: "submission",
				confidence: 0.95,
				editing: false,
			},
			{
				id: "f2",
				name: "2026SS_03_student.key.ipynb",
				type: "key",
				confidence: 0.88,
				editing: false,
			},
			{ id: "f3", name: "assignment.pdf", type: "pdf", confidence: 0.82, editing: false },
			{ id: "f4", name: "measurements.csv", type: "data", confidence: 0.76, editing: false },
			{ id: "f5", name: "report.key.ipynb", type: "key", confidence: 0.64, editing: false },
		];
		uploadPhase = "detected";
	}

	// ── Handlers ──

	function handleDropZoneClick() {
		if (!hasFiles) {
			simulateFileDetection();
		} else {
			addToast("info", "Phase 3: real file upload");
		}
	}

	function startReview() {
		addToast("info", "Phase 3: classification pipeline execution");
	}

	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	function preEvaluate() {
		addToast("info", "Phase 3: pre-evaluation run");
	}

	// Batch edit state
	let allSelected = $state(false);
	let batchEditOpen = $state(false);

	function toggleAllSelected() {
		allSelected = !allSelected;
	}
</script>

<div class="upload-panel" class:inline>
	<!-- Card header -->
	<div class="panel-header">
		<h1 class="panel-title">Upload Files</h1>
	</div>

	<!-- Drop zone (visible when empty) -->
	{#if !hasFiles}
		<div
			class="drop-zone"
			onclick={handleDropZoneClick}
			role="button"
			tabindex="0"
			onkeydown={(e) => e.key === "Enter" && handleDropZoneClick()}
		>
			<Upload size={32} class="drop-zone-icon" />
			<p class="drop-zone-title">Drop files here or click to browse</p>
			<p class="drop-zone-sub">Supports .ipynb, .pdf, .csv, and other assignment files</p>
			<button class="browse-btn" onclick={handleDropZoneClick}>
				<Upload size={14} />
				Browse Files
			</button>
			<p class="drop-zone-footnote">
				Files are classified automatically. Review and edit before uploading.
			</p>
		</div>
	{/if}

	<!-- Drop bar + file table (visible when files detected) -->
	{#if hasFiles}
		<!-- Compressed drop bar -->
		<div
			class="drop-bar"
			onclick={handleDropZoneClick}
			role="button"
			tabindex="0"
			onkeydown={(e) => e.key === "Enter" && handleDropZoneClick()}
		>
			<Upload size={16} class="drop-bar-icon" />
			<span class="drop-bar-text">Drop more files or click to add</span>
		</div>

		<!-- Detection rules help -->
		<div class="detection-rules">
			<strong>Auto-detection:</strong> Files matching filename pattern
			<code>{detectionPattern}</code>
			are classified as <strong>Submission</strong>.
			<code>.key.ipynb</code> &rarr; <strong>Key</strong>. <code>*.pdf</code> &rarr;
			<strong>PDF</strong>. Other files &rarr; <strong>Data</strong>. Use the &#x270F;&#xFE0F;
			button to override.
		</div>

		<!-- File classification table -->
		<div class="class-table-wrap">
			<table class="class-table">
				<thead>
					<tr>
						<th class="checkbox-col">
							<label class="table-checkbox-wrap">
								<input
									type="checkbox"
									class="table-checkbox"
									checked={allSelected}
									onchange={toggleAllSelected}
								/>
							</label>
						</th>
						<th>File</th>
						<th>Type</th>
						<th>Confidence</th>
						<th class="edit-col"></th>
					</tr>
				</thead>
				<tbody>
					{#each files as file (file.id)}
						<tr class:row-editing={file.editing}>
							<td class="checkbox-col">
								<label class="table-checkbox-wrap">
									<input type="checkbox" class="table-checkbox" />
								</label>
							</td>
							<td><span class="file-name">{file.name}</span></td>
							<td>
								<span class="chip chip-{file.type}">
									{file.type === "submission"
										? "Submission"
										: file.type === "key"
											? "Key"
											: file.type === "pdf"
												? "PDF"
												: "Data"}
								</span>
							</td>
							<td>
								<span
									class="confidence-text confidence-{file.confidence >= 0.8
										? 'high'
										: file.confidence >= 0.5
											? 'medium'
											: 'low'}"
								>
									{(file.confidence * 100).toFixed(0)}%
								</span>
							</td>
							<td class="edit-col">
								<button
									class="edit-action-btn"
									onclick={() => (file.editing = !file.editing)}
									aria-label="Edit classification"
								>
									&#x270F;&#xFE0F;
								</button>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>

		<!-- Batch edit toggle -->
		<div class="batch-edit-area">
			<button class="batch-edit-toggle" onclick={() => (batchEditOpen = !batchEditOpen)}>
				Batch Edit
			</button>
		</div>

		<!-- Batch edit panel -->
		{#if batchEditOpen}
			<div class="batch-edit-row">
				<span class="batch-edit-label">Change type to:</span>
				<select class="batch-edit-select">
					<option>Submission</option>
					<option>Key</option>
					<option>PDF</option>
					<option>Data</option>
				</select>
				<button class="apply-btn">Apply</button>
				<span class="batch-edit-subtitle"
					>{allSelected ? "All" : "Selected"} files will be updated.</span
				>
			</div>
		{/if}

		<!-- Upload actions -->
		<div class="upload-actions">
			<label class="upload-checkbox">
				<input type="checkbox" checked={allSelected} onchange={toggleAllSelected} />
				Select all
			</label>
			<button class="upload-btn" onclick={startReview}>
				<Upload size={16} />
				Process All
			</button>
		</div>
	{/if}

	<!-- Stub notice -->
	{#if IS_PHASE_2_STUB}
		<div class="stub-notice">
			Phase 2 stub &mdash; file detection is simulated. Real upload pipeline comes in Phase 3.
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
		margin: 8px 14px 0;
		padding: 8px 12px;
	}
	.upload-panel.inline .class-table-wrap {
		margin: 0 14px 12px;
	}
	.upload-panel.inline .upload-actions {
		padding: 0 14px 14px;
	}
	.upload-panel.inline .stub-notice {
		margin: 0;
		padding: 6px 14px;
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

	/* ── Drop zone (empty state) ── */
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
	.drop-zone-icon {
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
	.drop-zone-footnote {
		font-size: 11px;
		color: var(--muted-foreground);
		margin-top: 8px;
	}

	/* ── Drop bar (has-files state) ── */
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
		margin: 12px 24px 0;
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

	/* ── File classification table ── */
	.class-table-wrap {
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		margin: 0 24px 16px;
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
	.checkbox-col {
		text-align: center;
		width: 40px;
		min-width: 40px;
	}
	.edit-col {
		text-align: right;
		white-space: nowrap;
		width: 60px;
		min-width: 60px;
	}
	.table-checkbox-wrap {
		position: relative;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 16px;
		height: 16px;
		cursor: pointer;
	}
	.table-checkbox {
		appearance: none;
		width: 16px;
		height: 16px;
		border: 1.5px solid var(--border);
		border-radius: 4px;
		background: var(--card);
		cursor: pointer;
		flex-shrink: 0;
		margin: 0;
		transition:
			border-color 0.15s,
			background 0.15s;
	}
	.table-checkbox:checked {
		background: var(--accent);
		border-color: var(--accent);
	}
	.file-name {
		font-family: var(--font-mono);
		font-size: 12px;
		color: var(--fg);
		word-break: break-all;
	}
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
	.chip-key {
		background: oklch(0.91 0.06 280);
		color: oklch(0.5 0.16 280);
	}
	.chip-pdf {
		background: var(--muted);
		color: var(--muted-foreground);
	}
	.chip-data {
		background: oklch(0.9 0.1 145);
		color: oklch(0.5 0.15 145);
	}
	.confidence-text {
		font-size: 12px;
	}
	.confidence-high {
		color: var(--success);
	}
	.confidence-medium {
		color: var(--warning);
	}
	.confidence-low {
		color: var(--error);
	}
	.confidence-unknown {
		color: var(--muted-foreground);
	}
	.row-editing {
		background: color-mix(in oklch, var(--info) 6%, transparent) !important;
	}
	.edit-action-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 26px;
		height: 26px;
		border: none;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--muted-foreground);
		cursor: pointer;
		transition:
			background 0.15s,
			color 0.15s;
	}
	.edit-action-btn:hover {
		background: var(--muted-bg);
		color: var(--fg);
	}

	/* ── Batch edit ── */
	.batch-edit-area {
		padding: 0 24px 12px;
	}
	.batch-edit-toggle {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 4px 12px;
		font-size: 12px;
		font-weight: 500;
		color: var(--muted-foreground);
		background: transparent;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		cursor: pointer;
		transition:
			background 0.15s,
			color 0.15s;
	}
	.batch-edit-toggle:hover {
		color: var(--fg);
		background: var(--muted-bg);
	}
	.batch-edit-row {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
		padding: 0 24px 16px;
	}
	.batch-edit-label {
		font-size: 12px;
		color: var(--muted-foreground);
		white-space: nowrap;
	}
	.batch-edit-select {
		appearance: none;
		padding: 5px 24px 5px 8px;
		font-size: 12px;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--card);
		color: var(--fg);
		cursor: pointer;
	}
	.apply-btn {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 5px 14px;
		font-size: 12px;
		font-weight: 500;
		color: var(--accent-on);
		background: var(--accent);
		border: none;
		border-radius: var(--radius-sm);
		cursor: pointer;
		transition: background 0.15s;
	}
	.apply-btn:hover {
		background: var(--accent-hover);
	}
	.batch-edit-subtitle {
		font-size: 11px;
		color: var(--muted-foreground);
		line-height: 1.5;
	}

	/* ── Upload actions ── */
	.upload-actions {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		padding: 0 24px 20px;
	}
	.upload-checkbox {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 13px;
		color: var(--fg);
		cursor: pointer;
	}
	.upload-checkbox input[type="checkbox"] {
		appearance: none;
		width: 16px;
		height: 16px;
		border: 1.5px solid var(--border);
		border-radius: 4px;
		background: var(--card);
		cursor: pointer;
		flex-shrink: 0;
		transition:
			border-color 0.15s,
			background 0.15s;
	}
	.upload-checkbox input[type="checkbox"]:checked {
		background: var(--accent);
		border-color: var(--accent);
	}
	.upload-btn {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		padding: 10px 28px;
		font-size: 14px;
		font-weight: 500;
		color: var(--accent-on);
		background: var(--accent);
		border: none;
		border-radius: var(--radius);
		cursor: pointer;
		flex-shrink: 0;
		letter-spacing: -0.01em;
		transition: background 0.15s;
	}
	.upload-btn:hover:not(:disabled) {
		background: var(--accent-hover);
	}
	.upload-btn:disabled {
		opacity: 0.4;
		cursor: not-allowed;
		background: var(--muted-foreground);
	}

	/* ── Stub notice ── */
	.stub-notice {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 8px 16px;
		background: color-mix(in oklch, var(--warning) 10%, transparent);
		border-top: 1px solid var(--border);
		font-size: 11px;
		color: var(--warning);
	}

	/* ── Dark mode refinements ── */
	:global(.dark) .chip-submission {
		background: oklch(0.25 0.05 195);
		color: oklch(0.65 0.1 195);
	}
	:global(.dark) .chip-key {
		background: oklch(0.25 0.08 280);
		color: oklch(0.6 0.14 280);
	}
	:global(.dark) .chip-pdf {
		background: oklch(0.24 0.01 216.9);
		color: var(--muted-foreground);
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
