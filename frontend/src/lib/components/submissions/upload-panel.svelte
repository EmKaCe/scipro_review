<script lang="ts">
	/**
	 * @file Upload Panel — modern drag-and-drop upload UX.
	 *
	 * Files land in a preview list first: each row gets a client-side
	 * classification (submission / material-data / material-file), a status
	 * icon (✓ valid, ⚠ warning, ✗ error), a size readout and a per-file kind
	 * override dropdown for material files. "Upload N files" then uploads the
	 * whole list in ONE batched request (the server persists every file in a
	 * single multipart POST and returns per-file results), shows per-file
	 * results inline, and re-uploads only the files that have not succeeded
	 * yet on retry. After a fully successful batch the panel auto-closes
	 * after 3 seconds.
	 *
	 * The server (upload route + file-service.validateSubmissionFile) is the
	 * source of truth: client-side detection mirrors the server's filename
	 * rules and notebooks are additionally validated client-side (JSON +
	 * `cells` array) before they are ever sent.
	 */

	import Upload from "@lucide/svelte/icons/upload";
	import Loader from "@lucide/svelte/icons/loader";
	import CircleCheck from "@lucide/svelte/icons/circle-check";
	import CircleAlert from "@lucide/svelte/icons/circle-alert";
	import CircleX from "@lucide/svelte/icons/circle-x";
	import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
	import X from "@lucide/svelte/icons/x";
	import Check from "@lucide/svelte/icons/check";
	import { onDestroy } from "svelte";

	import { submissionsStore } from "$lib/services/submissions-store.js";
	import type { SubmissionUploadResult, UploadKind } from "$lib/services/submissions-api.js";
	import { addToast } from "$lib/stores/toast.svelte.js";

	interface Props {
		/** If true, renders as a full-width card inline with page content. */
		inline?: boolean;
		/** Assignment the uploaded files belong to. */
		assignmentId: string;
		/**
		 * Invoked after an upload run with the per-file server results (only
		 * files that were actually uploaded in that run) — lets the parent
		 * auto-select the new rows without diffing a possibly-stale list.
		 */
		onUploaded?: (results: SubmissionUploadResult[]) => void;
		/** Invoked when the user dismisses the panel (✕) or it auto-closes. */
		onClose?: () => void;
	}

	let { inline = false, assignmentId, onUploaded, onClose }: Props = $props();

	// ---------------------------------------------------------------------
	// Types & constants
	// ---------------------------------------------------------------------

	type FileStatus = "ok" | "warning" | "error";
	type FilePhase = "pending" | "uploading" | "succeeded" | "failed";

	interface PendingFile {
		id: string;
		file: File;
		/** Client-side validation outcome. */
		status: FileStatus;
		/** Warning/error text from client-side validation. */
		message: string | null;
		/** Kind derived from the file name + content (client-side mirror of the server). */
		detectedKind: UploadKind;
		/** Effective kind (detected, or user override via the dropdown). */
		kind: UploadKind;
		/** Upload lifecycle phase. */
		phase: FilePhase;
		/** Upload failure text (server validation error or request error). */
		errorMessage: string | null;
		/** Server result once the file was uploaded. */
		result?: SubmissionUploadResult;
	}

	/** Mirrors file-service.STUDENT_FILENAME_RE: semester prefix + number. */
	const STUDENT_FILENAME_RE = /^(\d{4}(?:SS|WS))_(\d{2,})/;
	/** Mirrors file-service.DATA_EXTENSIONS (assignment input data). */
	const DATA_EXTENSIONS = new Set([
		"csv",
		"tsv",
		"txt",
		"dat",
		"xlsx",
		"xls",
		"json",
		"npz",
		"npy",
		"pkl",
		"pickle",
		"parquet",
		"h5",
		"hdf5",
		"mat",
		"zip",
		"gz",
	]);
	const MAX_SIZE_BYTES = 50 * 1024 * 1024;

	// ---------------------------------------------------------------------
	// State
	// ---------------------------------------------------------------------

	let files = $state<PendingFile[]>([]);
	let uploading = $state(false);
	let error = $state<string | null>(null);
	let inputRef: HTMLInputElement | undefined = $state(undefined);
	/** Settled files within the current upload run (for "Uploading… 5/12"). */
	let progress = $state({ done: 0, total: 0 });
	let closeTimer: ReturnType<typeof setTimeout> | undefined = $state(undefined);

	// Drag-and-drop depth counter — dragleave fires when entering child
	// elements, so a boolean would flicker. Only 0 means "no drag active".
	let dragDepth = $state(0);
	let isDragActive = $derived(dragDepth > 0);

	// ---------------------------------------------------------------------
	// Derived UI state
	// ---------------------------------------------------------------------

	const uploadTargets = $derived(
		files.filter(
			(f) => f.status !== "error" && (f.phase === "pending" || f.phase === "failed"),
		),
	);
	const succeededCount = $derived(files.filter((f) => f.phase === "succeeded").length);
	const failedCount = $derived(files.filter((f) => f.phase === "failed").length);
	const skippedCount = $derived(files.filter((f) => f.status === "error").length);
	const hasFailures = $derived(failedCount > 0);

	const uploadLabel = $derived(
		hasFailures
			? `Retry ${uploadTargets.length} file${uploadTargets.length === 1 ? "" : "s"}`
			: `Upload ${uploadTargets.length} file${uploadTargets.length === 1 ? "" : "s"}`,
	);

	const listTitle = $derived(
		succeededCount > 0 ? "Upload results" : `Files to upload (${files.length})`,
	);

	/** One-line classification summary, e.g. "12 files selected: 10 submissions, 1 data file, 1 material file". */
	const summaryText = $derived.by(() => {
		if (files.length === 0) return "";
		let subs = 0;
		let data = 0;
		let mat = 0;
		for (const f of files) {
			if (f.status === "error") continue; // skipped, counted separately
			// After upload the server verdict wins; before that the effective kind.
			const kind = f.phase === "succeeded" && f.result ? f.result.kind : f.kind;
			if (kind === "submission") subs += 1;
			else if (kind === "material-data") data += 1;
			else mat += 1;
		}
		const parts: string[] = [
			`${subs} submission${subs === 1 ? "" : "s"}`,
			`${data} data file${data === 1 ? "" : "s"}`,
			`${mat} material file${mat === 1 ? "" : "s"}`,
		];
		if (skippedCount > 0) parts.push(`${skippedCount} skipped`);
		const prefix =
			succeededCount > 0
				? `${succeededCount} file${succeededCount === 1 ? "" : "s"} uploaded`
				: `${files.length} file${files.length === 1 ? "" : "s"} selected`;
		return `${prefix}: ${parts.join(", ")}${failedCount > 0 ? ` · ${failedCount} failed` : ""}`;
	});

	// ---------------------------------------------------------------------
	// Client-side detection & validation (mirrors file-service.classifyFile)
	// ---------------------------------------------------------------------

	function extOf(name: string): string {
		const dot = name.lastIndexOf(".");
		return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
	}

	function isStudentNotebookName(name: string): boolean {
		return STUDENT_FILENAME_RE.test(name) && extOf(name) === "ipynb";
	}

	/**
	 * Classify + validate one file. `.ipynb` files must parse as JSON and
	 * carry a `cells` array; student-pattern names become submissions,
	 * other notebooks become material-file. Everything else is a material.
	 */
	async function inspectFile(
		file: File,
	): Promise<{ status: FileStatus; message: string | null; detectedKind: UploadKind }> {
		if (extOf(file.name) === "ipynb") {
			try {
				const parsed: unknown = JSON.parse(await file.text());
				const hasCells =
					typeof parsed === "object" &&
					parsed !== null &&
					Array.isArray((parsed as { cells?: unknown }).cells);
				if (!hasCells) {
					return {
						status: "error",
						message: 'Not a valid notebook: missing "cells" array',
						detectedKind: "material-file",
					};
				}
				return {
					status: "ok",
					message: null,
					detectedKind: isStudentNotebookName(file.name) ? "submission" : "material-file",
				};
			} catch {
				return {
					status: "error",
					message: "Not a valid notebook: file is not valid JSON",
					detectedKind: "material-file",
				};
			}
		}
		return {
			status: "ok",
			message: null,
			detectedKind: DATA_EXTENSIONS.has(extOf(file.name)) ? "material-data" : "material-file",
		};
	}

	// ---------------------------------------------------------------------
	// File picking (browse + drop)
	// ---------------------------------------------------------------------

	async function addFiles(list: FileList | File[]) {
		const incoming = Array.from(list);
		if (incoming.length === 0) return;
		cancelAutoClose();

		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- transient local dedupe scratch set for one handler call, not reactive component state
		const seen = new Set(
			files.map((f) => `${f.file.name}|${f.file.size}|${f.file.lastModified}`),
		);
		let duplicates = 0;
		for (const file of incoming) {
			const key = `${file.name}|${file.size}|${file.lastModified}`;
			if (seen.has(key)) {
				duplicates += 1;
				continue;
			}
			seen.add(key);
			const inspection = await inspectFile(file);
			let status = inspection.status;
			let message = inspection.message;
			if (status === "ok" && file.size > MAX_SIZE_BYTES) {
				status = "warning";
				message = "Large file (>50 MB)";
			}
			files.push({
				id: key,
				file,
				status,
				message,
				detectedKind: inspection.detectedKind,
				kind: inspection.detectedKind,
				phase: "pending",
				errorMessage: null,
			});
		}
		if (duplicates > 0) {
			addToast(
				"info",
				`${duplicates} duplicate file${duplicates === 1 ? "" : "s"} skipped`,
				3000,
			);
		}
	}

	function handleFiles(e: Event) {
		const list = (e.currentTarget as HTMLInputElement).files;
		if (list) void addFiles(list);
		if (inputRef) inputRef.value = "";
	}

	function handlePick() {
		inputRef?.click();
	}

	function removeFile(id: string) {
		cancelAutoClose();
		files = files.filter((f) => f.id !== id);
	}

	function setKind(entry: PendingFile, kind: UploadKind) {
		entry.kind = kind;
	}

	// ── Drag & drop ────────────────────────────────────────────────────────
	// Without dragover.preventDefault() the browser refuses the drop, and
	// without an explicit drop handler the OS file drop is ignored entirely.
	function handleDragEnter(e: DragEvent) {
		e.preventDefault();
		dragDepth += 1;
	}

	function handleDragLeave(e: DragEvent) {
		e.preventDefault();
		dragDepth = Math.max(0, dragDepth - 1);
	}

	function handleDragOver(e: DragEvent) {
		e.preventDefault();
	}

	function handleDrop(e: DragEvent) {
		e.preventDefault();
		dragDepth = 0;
		const dropped = e.dataTransfer?.files;
		if (dropped && dropped.length > 0) {
			void addFiles(dropped);
		}
	}

	// ---------------------------------------------------------------------
	// Upload
	// ---------------------------------------------------------------------

	/**
	 * Upload the pending + failed files in ONE batched request (all files in
	 * a single multipart POST, then a single list refresh — BUG-018). Per-file
	 * phases/go results are assigned from the returned per-file results.
	 * Files that already succeeded are skipped (retry semantics).
	 */
	async function startUpload() {
		const targets = uploadTargets;
		if (targets.length === 0 || uploading) return;
		cancelAutoClose();
		uploading = true;
		error = null;
		progress = { done: 0, total: targets.length };

		const batchResults: SubmissionUploadResult[] = [];
		try {
			// Ensure the store targets this assignment before upload.
			if (submissionsStore.assignmentId !== assignmentId) {
				await submissionsStore.load(assignmentId);
			}
			// Mark every target as uploading up front, then send ALL files in
			// ONE multipart request (the server's upload route accepts any
			// number of files per POST). Results come back together and are
			// matched to each file below by name+size — single request, single
			// list refresh (BUG-018).
			for (const entry of targets) {
				entry.phase = "uploading";
			}
			const res = await submissionsStore.uploadMany(
				targets.map((entry) => ({
					file: entry.file,
					kind: entry.kind !== entry.detectedKind ? entry.kind : undefined,
				})),
			);
			// Group results by file name; two distinct files can share a name
			// (e.g. an edited re-upload of 2026SS_01.ipynb), so a name keyed
			// Map alone would collapse them — disambiguate by byte size.
			// eslint-disable-next-line svelte/prefer-svelte-reactivity -- transient local per-request result grouping, not reactive component state
			const resultsByName = new Map<string, SubmissionUploadResult[]>();
			for (const r of res.results) {
				const arr = resultsByName.get(r.fileName) ?? [];
				arr.push(r);
				resultsByName.set(r.fileName, arr);
			}
			for (const entry of targets) {
				const candidates = resultsByName.get(entry.file.name) ?? [];
				const result = candidates.find((r) => r.bytes === entry.file.size) ?? candidates[0];
				if (!result) {
					entry.phase = "failed";
					entry.errorMessage = "No result returned for this file";
				} else {
					batchResults.push(result);
					entry.result = result;
					if (result.error) {
						entry.phase = "failed";
						entry.errorMessage = result.error;
					} else {
						entry.phase = "succeeded";
					}
				}
				progress.done += 1;
			}

			if (batchResults.length > 0) onUploaded?.(batchResults);

			const ok = batchResults.filter((r) => !r.error).length;
			const failed = batchResults.length - ok;
			if (failed > 0) {
				addToast(
					"warning",
					`${ok} file${ok === 1 ? "" : "s"} uploaded · ${failed} failed`,
					5000,
				);
			} else if (ok > 0) {
				addToast("success", `${ok} file${ok === 1 ? "" : "s"} uploaded`, 4000);
				// Auto-close after a fully successful run (keep open on errors
				// so the teacher can retry or remove the failed rows).
				if (onClose) {
					closeTimer = setTimeout(() => {
						resetPanel();
						onClose();
					}, 3000);
				}
			}
		} catch (err) {
			error = err instanceof Error ? err.message : "Upload failed";
			// Request-level failure (e.g. assignment load) — put in-flight
			// rows back to pending so the retry button can pick them up.
			for (const entry of targets) {
				if (entry.phase === "uploading") entry.phase = "pending";
			}
		} finally {
			uploading = false;
		}
	}

	// ---------------------------------------------------------------------
	// Close / reset
	// ---------------------------------------------------------------------

	function resetPanel() {
		files = [];
		uploading = false;
		error = null;
		progress = { done: 0, total: 0 };
		cancelAutoClose();
	}

	function cancelAutoClose() {
		if (closeTimer) {
			clearTimeout(closeTimer);
			closeTimer = undefined;
		}
	}

	function handleClose() {
		resetPanel();
		onClose?.();
	}

	onDestroy(() => {
		cancelAutoClose();
	});

	// ---------------------------------------------------------------------
	// Formatting helpers
	// ---------------------------------------------------------------------

	function formatBytes(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
		return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
	}

	function kindLabel(kind: UploadKind): string {
		switch (kind) {
			case "submission":
				return "Submission";
			case "material-data":
				return "Input Data";
			case "material-file":
				return "Material";
		}
	}

	function chipClass(kind: UploadKind): string {
		switch (kind) {
			case "submission":
				return "chip-submission";
			case "material-data":
				return "chip-data";
			case "material-file":
				return "chip-material";
		}
	}
</script>

<div class="upload-panel" class:inline>
	<!-- Card header -->
	<div class="panel-header">
		<h1 class="panel-title">Upload Submissions</h1>
		{#if onClose}
			<button
				type="button"
				class="close-btn"
				title="Close upload panel"
				aria-label="Close upload panel"
				onclick={handleClose}
			>
				<X size={16} />
			</button>
		{/if}
	</div>

	<!-- Hidden native picker -->
	<input
		type="file"
		multiple
		accept=".ipynb,.csv,.pdf,.txt,.py,.json,.yaml,.yml"
		class="hidden-input"
		bind:this={inputRef}
		onchange={handleFiles}
	/>

	<div class="panel-body">
		<!-- ── Drop zone (always visible; disabled while uploading) ── -->
		<div
			class="drop-zone"
			class:dz-active={isDragActive}
			class:dz-disabled={uploading}
			role="button"
			tabindex="0"
			aria-label="Drop files here or click to browse"
			onclick={handlePick}
			onkeydown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					handlePick();
				}
			}}
			ondragenter={handleDragEnter}
			ondragleave={handleDragLeave}
			ondragover={handleDragOver}
			ondrop={handleDrop}
		>
			<span class="dz-icon"><Upload size={28} /></span>
			<p class="dz-title">Drop files here or click to browse</p>
			<p class="dz-sub">
				Accepts .ipynb, .csv, .pdf, .txt, .py, .json, .yaml, .yml — notebooks are checked
				before upload
			</p>
			<button
				class="browse-btn"
				type="button"
				onclick={(e) => {
					e.stopPropagation();
					handlePick();
				}}
			>
				<Upload size={14} />
				Browse Files
			</button>
		</div>

		{#if error}
			<p class="request-error" role="alert"><CircleAlert size={14} /> {error}</p>
		{/if}

		{#if files.length > 0}
			<!-- ── File list with per-file classification preview ── -->
			<div class="list-section">
				<p class="list-title">{listTitle}</p>
				<div class="file-list">
					{#each files as entry (entry.id)}
						<div
							class="file-row"
							class:row-failed={entry.phase === "failed"}
							class:row-succeeded={entry.phase === "succeeded"}
						>
							<span class="row-icon" aria-hidden="true">
								{#if entry.phase === "uploading"}
									<span class="spinner"><Loader size={15} /></span>
								{:else if entry.phase === "succeeded"}
									<CircleCheck size={15} class="text-success" />
								{:else if entry.phase === "failed"}
									<CircleX size={15} class="text-error" />
								{:else if entry.status === "ok"}
									<Check size={15} class="text-success" />
								{:else if entry.status === "warning"}
									<TriangleAlert size={15} class="text-warning" />
								{:else}
									<CircleX size={15} class="text-error" />
								{/if}
							</span>

							<div class="row-main">
								<div class="row-name-line">
									<span class="file-name" title={entry.file.name}
										>{entry.file.name}</span
									>
									<span class="file-size">{formatBytes(entry.file.size)}</span>
								</div>
								{#if entry.phase === "succeeded"}
									<span class="uploaded-note"
										><CircleCheck size={11} /> Uploaded</span
									>
								{:else if entry.errorMessage}
									<span class="error-note">{entry.errorMessage}</span>
								{:else if entry.message}
									<span
										class="validation-note"
										class:note-error={entry.status === "error"}
									>
										{entry.message}
									</span>
								{/if}
							</div>

							<span class="chip {chipClass(entry.kind)}">{kindLabel(entry.kind)}</span
							>

							<!-- Kind override dropdown — only when the detected kind might be wrong -->
							{#if entry.status !== "error" && entry.detectedKind !== "submission"}
								<select
									class="kind-select"
									aria-label="Override kind for {entry.file.name}"
									title="Override detected kind"
									value={entry.kind}
									disabled={uploading}
									onchange={(e) =>
										setKind(
											entry,
											(e.currentTarget as HTMLSelectElement)
												.value as UploadKind,
										)}
								>
									<option
										value="submission"
										disabled={!isStudentNotebookName(entry.file.name)}
										>Submission</option
									>
									<option value="material-data">Input Data</option>
									<option value="material-file">Material</option>
								</select>
							{/if}

							<button
								type="button"
								class="remove-btn"
								title="Remove file"
								aria-label="Remove {entry.file.name}"
								disabled={uploading}
								onclick={() => removeFile(entry.id)}
							>
								<X size={14} />
							</button>
						</div>
					{/each}
				</div>

				<p class="summary">{summaryText}</p>

				<div class="footer">
					<button
						class="upload-btn"
						type="button"
						disabled={uploading || uploadTargets.length === 0}
						onclick={startUpload}
					>
						{#if uploading}
							<span class="spinner"><Loader size={14} /></span>
							Uploading… {progress.done}/{progress.total}
						{:else}
							<Upload size={14} />
							{uploadLabel}
						{/if}
					</button>
				</div>
			</div>
		{:else}
			<!-- Detection rules help (empty state) -->
			<div class="detection-rules">
				<strong>Auto-detection:</strong> filenames like
				<code>2026SS_01.ipynb</code> are classified as <strong>Submission</strong>; data
				files (.csv, .xlsx, …) as <strong>Input Data</strong>; everything else (e.g. .pdf)
				as
				<strong>Material</strong>. Use the dropdown on a file row to override its kind.
			</div>
		{/if}
	</div>
</div>

<style>
	/* ── Panel container ── */
	.upload-panel {
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		background: var(--card);
		overflow: hidden;
	}
	.upload-panel.inline .panel-body {
		padding: 12px;
	}

	/* ── Header ── */
	.panel-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 16px 20px 0;
		gap: 12px;
	}
	.upload-panel.inline .panel-header {
		padding: 12px 12px 0;
	}
	.panel-title {
		font-size: 15px;
		font-weight: 600;
		letter-spacing: -0.01em;
		color: var(--fg);
	}
	.close-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		border-radius: var(--radius-sm);
		border: none;
		background: transparent;
		color: var(--muted-foreground);
		cursor: pointer;
		transition:
			background 0.15s,
			color 0.15s;
	}
	.close-btn:hover {
		background: var(--muted);
		color: var(--fg);
	}

	/* ── Body ── */
	.panel-body {
		padding: 16px 20px 20px;
	}

	/* ── Hidden picker ── */
	.hidden-input {
		display: none;
	}

	/* ── Drop zone ── */
	.drop-zone {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 6px;
		padding: 30px 20px;
		border: 2px dashed var(--border);
		border-radius: var(--radius-lg);
		background: var(--bg);
		cursor: pointer;
		transition:
			border-color 0.15s,
			background 0.15s;
	}
	.drop-zone:hover {
		border-color: var(--primary);
		background: color-mix(in oklch, var(--primary) 3%, transparent);
	}
	.drop-zone.dz-active,
	.drop-zone.dz-active:hover {
		border-color: var(--primary);
		background: color-mix(in oklch, var(--primary) 7%, transparent);
	}
	.drop-zone.dz-disabled {
		opacity: 0.45;
		pointer-events: none;
		cursor: default;
	}
	.drop-zone.dz-disabled:hover {
		border-color: var(--border);
		background: var(--bg);
	}
	.dz-icon {
		display: inline-flex;
		color: var(--primary);
		margin-bottom: 2px;
	}
	.dz-title {
		font-size: 14px;
		font-weight: 500;
		color: var(--fg);
	}
	.dz-sub {
		font-size: 12px;
		color: var(--muted-foreground);
		text-align: center;
	}
	.browse-btn {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		margin-top: 8px;
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

	.spinner {
		display: inline-flex;
		animation: spin 0.9s linear infinite;
		color: var(--primary);
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	/* ── Request-level error ── */
	.request-error {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-top: 12px;
		padding: 8px 12px;
		border-radius: var(--radius-sm);
		background: color-mix(in oklch, var(--error) 8%, transparent);
		font-size: 12px;
		color: var(--error);
	}

	/* ── File list ── */
	.list-section {
		margin-top: 16px;
	}
	.list-title {
		font-size: 13px;
		font-weight: 600;
		color: var(--fg);
		margin-bottom: 8px;
	}
	.file-list {
		max-height: 280px;
		overflow-y: auto;
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: var(--bg);
	}
	.file-row {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 9px 12px;
		border-bottom: 1px solid var(--border);
	}
	.file-row:last-child {
		border-bottom: none;
	}
	.file-row.row-failed {
		background: color-mix(in oklch, var(--error) 6%, transparent);
	}
	.file-row.row-succeeded {
		background: color-mix(in oklch, var(--success) 5%, transparent);
	}
	.row-icon {
		display: inline-flex;
		align-items: center;
		flex-shrink: 0;
	}
	.row-main {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.row-name-line {
		display: flex;
		align-items: baseline;
		gap: 8px;
		min-width: 0;
	}
	.file-name {
		font-family: var(--font-mono);
		font-size: 12px;
		color: var(--fg);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.file-size {
		font-size: 11px;
		color: var(--muted-foreground);
		white-space: nowrap;
	}
	.uploaded-note {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-size: 11px;
		font-weight: 500;
		color: var(--success);
	}
	.error-note {
		font-size: 11px;
		color: var(--error);
		line-height: 1.4;
	}
	.validation-note {
		font-size: 11px;
		color: var(--warning);
		line-height: 1.4;
	}
	.validation-note.note-error {
		color: var(--error);
	}

	/* ── Kind override dropdown ── */
	.kind-select {
		flex-shrink: 0;
		height: 28px;
		padding: 0 6px;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--card);
		color: var(--fg);
		font-size: 11px;
		cursor: pointer;
	}
	.kind-select:disabled {
		opacity: 0.5;
		cursor: default;
	}

	/* ── Remove button ── */
	.remove-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 26px;
		height: 26px;
		flex-shrink: 0;
		border: none;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--muted-foreground);
		cursor: pointer;
		transition:
			background 0.15s,
			color 0.15s;
	}
	.remove-btn:hover {
		background: color-mix(in oklch, var(--error) 10%, transparent);
		color: var(--error);
	}
	.remove-btn:disabled {
		opacity: 0.4;
		cursor: default;
	}

	/* ── Summary + footer ── */
	.summary {
		margin-top: 10px;
		font-size: 12px;
		color: var(--muted-foreground);
		line-height: 1.5;
	}
	.footer {
		display: flex;
		justify-content: flex-end;
		margin-top: 12px;
	}
	.upload-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		min-width: 180px;
		padding: 9px 22px;
		border: none;
		border-radius: var(--radius);
		background: var(--primary);
		color: var(--primary-foreground);
		font-size: 13px;
		font-weight: 600;
		cursor: pointer;
		transition: background 0.15s;
	}
	.upload-btn:hover:not(:disabled) {
		background: color-mix(in oklch, var(--primary) 85%, var(--foreground));
	}
	.upload-btn:disabled {
		opacity: 0.5;
		cursor: default;
	}

	/* ── Detection rules help ── */
	.detection-rules {
		margin-top: 12px;
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

	/* ── Kind chips (classification preview) ── */
	.chip {
		display: inline-flex;
		align-items: center;
		flex-shrink: 0;
		padding: 2px 8px;
		border-radius: 999px;
		font-size: 11px;
		font-weight: 500;
		line-height: 1.4;
		white-space: nowrap;
	}
	.chip-submission {
		background: var(--chip-submission-bg);
		color: var(--chip-submission-fg);
	}
	.chip-data {
		background: var(--chip-data-bg);
		color: var(--chip-data-fg);
	}
	.chip-material {
		background: var(--muted);
		color: var(--muted-foreground);
	}

	/* ── Dark mode refinements ── */
	:global(.dark) .drop-zone {
		background: var(--muted-bg);
	}
	:global(.dark) .drop-zone:hover {
		background: color-mix(in oklch, var(--primary) 8%, var(--muted-bg));
	}
	:global(.dark) .file-list {
		background: var(--muted-bg);
	}
</style>
