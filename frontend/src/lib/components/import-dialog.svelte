<script lang="ts">
	import X from "@lucide/svelte/icons/x";
	import Upload from "@lucide/svelte/icons/upload";
	import FileText from "@lucide/svelte/icons/file-text";
	import AlertCircle from "@lucide/svelte/icons/alert-circle";
	import CustomCheckbox from "$lib/components/ui/custom-checkbox.svelte";
	import { Tooltip, TooltipTrigger, TooltipContent } from "$lib/components/ui/tooltip/index.js";
	import { formatFileSize } from "$lib/utils.js";

	type ImportState = "empty" | "selected" | "error";

	/** Props for the file import dialog component. */
	interface Props {
		/** Whether the dialog is currently visible. */
		open: boolean;
		/** Callback invoked when the dialog is closed. */
		onclose: () => void;
		/** Callback invoked with the selected file and read-only flag when import is confirmed. */
		onimport: (file: File, readOnly: boolean) => void;
		/** Optional callback invoked with all selected files for bulk import. */
		onbulkimport?: (files: File[], readOnly: boolean) => void;
	}

	let { open, onclose, onimport, onbulkimport }: Props = $props();

	let dialogRef: HTMLDivElement | undefined = $state();
	let importState = $state<ImportState>("empty");
	let selectedFiles = $state<File[]>([]);
	let readOnly = $state(true);
	let errorMessage = $state("");
	let isDragOver = $state(false);
	/** Element focused before the dialog opened — focus returns here on close. */
	let previouslyFocused: HTMLElement | null = null;

	let canImport = $derived(selectedFiles.length > 0);

	$effect(() => {
		if (open) {
			// Remember the trigger so focus can be restored on close (WCAG 2.1 AA 2.4.3).
			previouslyFocused = document.activeElement as HTMLElement | null;
			if (dialogRef) {
				const focusable = dialogRef.querySelectorAll<HTMLElement>(
					'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
				);
				if (focusable.length > 0) {
					focusable[0].focus();
				} else {
					dialogRef.focus();
				}
			}
		} else if (previouslyFocused) {
			previouslyFocused.focus();
			previouslyFocused = null;
		}
	});

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === "Escape") {
			onclose();
			return;
		}
		if (e.key === "Tab" && dialogRef) {
			const focusable = dialogRef.querySelectorAll<HTMLElement>(
				'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
			);
			if (focusable.length === 0) return;
			const first = focusable[0];
			const last = focusable[focusable.length - 1];
			if (e.shiftKey && document.activeElement === first) {
				e.preventDefault();
				last.focus();
			} else if (!e.shiftKey && document.activeElement === last) {
				e.preventDefault();
				first.focus();
			}
		}
	}

	$effect(() => {
		if (open) {
			importState = "empty";
			selectedFiles = [];
			readOnly = true;
			errorMessage = "";
			isDragOver = false;
		}
	});

	function handleFileSelect(event: Event) {
		const input = event.target as HTMLInputElement;
		if (input.files && input.files.length > 0) {
			selectedFiles = Array.from(input.files);
			importState = "selected";
			errorMessage = "";
		}
	}

	function handleDrop(event: DragEvent) {
		event.preventDefault();
		isDragOver = false;
		if (event.dataTransfer?.files && event.dataTransfer.files.length > 0) {
			selectedFiles = Array.from(event.dataTransfer.files);
			importState = "selected";
			errorMessage = "";
		}
	}

	function handleDragOver(event: DragEvent) {
		event.preventDefault();
		isDragOver = true;
	}

	function handleDragLeave() {
		isDragOver = false;
	}

	function clearFiles() {
		selectedFiles = [];
		importState = "empty";
		errorMessage = "";
		const input = document.getElementById("import-file-input") as HTMLInputElement | null;
		if (input) input.value = "";
	}

	function removeFile(index: number) {
		selectedFiles = selectedFiles.filter((_, i) => i !== index);
		if (selectedFiles.length === 0) {
			importState = "empty";
		}
	}

	function handleImport() {
		if (!canImport || selectedFiles.length === 0) return;
		if (selectedFiles.length > 1 && onbulkimport) {
			onbulkimport(selectedFiles, readOnly);
		} else {
			for (const file of selectedFiles) {
				onimport(file, readOnly);
			}
		}
	}

	function handleOverlayClick(event: MouseEvent) {
		if (event.target === event.currentTarget) {
			onclose();
		}
	}

	function getFileFormatBadge(file: File): string {
		const ext = file.name.split(".").pop()?.toLowerCase();
		if (ext === "yaml" || ext === "yml") return "YAML v2";
		if (ext === "json") return "JSON";
		return ext?.toUpperCase() || "Unknown";
	}
</script>

{#if open}
	<div
		bind:this={dialogRef}
		role="dialog"
		aria-modal="true"
		aria-labelledby="import-dialog-title"
		tabindex="-1"
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm transition-opacity duration-200"
		onclick={handleOverlayClick}
		onkeydown={handleKeydown}
	>
		<div
			class="mx-4 flex max-h-[90vh] w-full max-w-lg scale-100 transform flex-col rounded-[var(--radius)] border border-border bg-card shadow-xl transition-transform duration-200"
		>
			<!-- Dialog Header -->
			<div class="flex shrink-0 items-center justify-between p-6 pb-4">
				<div>
					<h3 id="import-dialog-title" class="text-lg font-semibold tracking-tight">
						Import Reviews
					</h3>
					<p class="mt-0.5 text-sm text-muted-foreground">
						Import one or more review files to view or continue editing.
					</p>
				</div>
				<Tooltip>
					<TooltipTrigger
						onclick={onclose}
						class="flex h-8 w-8 items-center justify-center rounded-[var(--radius)] text-muted-foreground transition-colors hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10"
						aria-label="Close"
					>
						<X size={16} />
					</TooltipTrigger>
					<TooltipContent>Close</TooltipContent>
				</Tooltip>
			</div>

			<!-- Dialog Body -->
			<div class="space-y-4 overflow-y-auto px-6 pb-6">
				<!-- Error State -->
				{#if importState === "error"}
					<div
						class="flex items-start gap-2.5 rounded-[var(--radius)] border border-error/20 bg-error/10 p-3 dark:border-error/30 dark:bg-error/10"
					>
						<AlertCircle size={16} class="mt-0.5 shrink-0 text-error" />
						<div>
							<p class="text-sm font-medium text-error">Import failed</p>
							<p class="mt-0.5 text-xs leading-relaxed text-error/80">
								{errorMessage ||
									"Unable to parse file. Ensure it follows the v2 evaluation YAML schema or legacy JSON format."}
							</p>
						</div>
					</div>
				{/if}

				<!-- Drop Zone (shown when no file selected) -->
				{#if importState === "empty"}
					<div
						class="flex min-h-[120px] cursor-pointer flex-col items-center justify-center rounded-[var(--radius)] border-2 border-dashed p-6 text-center transition-all duration-200 {isDragOver
							? 'border-primary bg-primary/5'
							: 'border-border hover:border-primary/50'}"
						ondragover={handleDragOver}
						ondragleave={handleDragLeave}
						ondrop={handleDrop}
						onclick={() => {
							const input = document.getElementById(
								"import-file-input",
							) as HTMLInputElement;
							input?.click();
						}}
						role="button"
						tabindex={0}
						onkeydown={(e) => {
							if (e.key === "Enter" || e.key === " ") {
								const input = document.getElementById(
									"import-file-input",
								) as HTMLInputElement;
								input?.click();
							}
						}}
					>
						<Upload size={32} class="mb-2 text-muted-foreground" />
						<p class="text-sm font-medium text-foreground">Drag and drop files here</p>
						<p class="mt-1 text-xs text-muted-foreground">
							or <span class="font-medium text-primary">browse files</span>
						</p>
						<p class="mt-2 text-xs tracking-wider text-muted-foreground uppercase">
							.yaml, .yml, .json
						</p>
						<input
							id="import-file-input"
							type="file"
							accept=".yaml,.yml,.json"
							multiple
							class="hidden"
							onchange={handleFileSelect}
						/>
					</div>
				{/if}

				<!-- File Selected State -->
				{#if importState === "selected" && selectedFiles.length > 0}
					<div class="space-y-2">
						{#each selectedFiles as file, i (file.name + "-" + i)}
							<div
								class="flex items-center gap-3 rounded-[var(--radius)] border border-border p-3"
							>
								<div
									class="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius)] bg-primary/10"
								>
									<FileText size={18} class="text-primary" />
								</div>
								<div class="min-w-0 flex-1">
									<div class="flex items-center gap-2">
										<p class="truncate text-sm font-medium text-foreground">
											{file.name}
										</p>
										<span
											class="inline-flex shrink-0 items-center rounded-full bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary"
										>
											{getFileFormatBadge(file)}
										</span>
									</div>
									<p class="text-xs text-muted-foreground">
										{formatFileSize(file.size)}
									</p>
								</div>
								<Tooltip>
									<TooltipTrigger
										onclick={() => removeFile(i)}
										class="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius)] text-muted-foreground transition-colors hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10"
										aria-label="Remove file"
									>
										<X size={14} />
									</TooltipTrigger>
									<TooltipContent>Remove file</TooltipContent>
								</Tooltip>
							</div>
						{/each}
						{#if selectedFiles.length > 1}
							<button
								onclick={clearFiles}
								class="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
							>
								<X size={12} />
								Clear all
							</button>
						{/if}
					</div>
				{/if}

				<!-- Options -->
				<div class="flex items-start gap-2.5">
					<CustomCheckbox
						id="import-readonly"
						bind:checked={readOnly}
						class="mt-0.5 shrink-0"
					/>
					<div>
						<label
							for="import-readonly"
							class="cursor-pointer text-sm font-medium text-foreground select-none"
							>Open as read-only</label
						>
						<p class="mt-0.5 text-xs leading-relaxed text-muted-foreground">
							Imported reviews open in read-only mode by default. Click "Edit" on the
							review page to modify.
						</p>
					</div>
				</div>
			</div>

			<!-- Dialog Footer -->
			<div class="flex shrink-0 justify-end gap-2 p-6 pt-0">
				<button
					onclick={onclose}
					class="h-9 rounded-[var(--radius)] border border-border px-4 text-sm font-medium text-foreground transition-colors hover:bg-black/5 dark:hover:bg-white/10"
				>
					Cancel
				</button>
				<button
					onclick={handleImport}
					disabled={!canImport}
					autofocus
					class="inline-flex h-9 items-center gap-2 rounded-[var(--radius)] bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity {canImport
						? 'cursor-pointer hover:opacity-90'
						: 'cursor-not-allowed opacity-50'}"
				>
					<Upload size={14} />
					Import
				</button>
			</div>
		</div>
	</div>
{/if}
