<script lang="ts">
	import Clipboard from "@lucide/svelte/icons/clipboard";
	import Download from "@lucide/svelte/icons/download";
	import FileText from "@lucide/svelte/icons/file-text";
	import ArrowLeft from "@lucide/svelte/icons/arrow-left";
	import Printer from "@lucide/svelte/icons/printer";

	/** Props for the evaluation action bar with copy, export, and navigation buttons. */
	interface Props {
		/** Callback to copy the evaluation to the clipboard. */
		onCopy: () => void;
		/** Callback to export the evaluation as YAML. */
		onExportYaml: () => void;
		/** Callback to export the evaluation as Markdown. */
		onExportMarkdown: () => void;
		/** Callback to navigate back to the review editor. */
		onBack: () => void;
		/** Callback to print the evaluation. */
		onPrint?: () => void;
	}

	let { onCopy, onExportYaml, onExportMarkdown, onBack, onPrint }: Props = $props();
</script>

<div
	class="evaluation-action-bar sticky bottom-4 z-30 flex flex-wrap items-center gap-2 rounded-[var(--radius)] border border-border bg-card p-3 shadow-lg"
>
	<button
		onclick={onCopy}
		class="flex h-9 items-center gap-2 rounded-[var(--radius)] bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
	>
		<Clipboard size={14} />
		Copy to Clipboard
	</button>
	<button
		onclick={onExportYaml}
		class="flex h-9 items-center gap-2 rounded-[var(--radius)] border border-border px-4 text-sm font-medium text-foreground transition-colors hover:bg-black/5 dark:hover:bg-white/10"
	>
		<Download size={14} />
		Export YAML
	</button>
	<button
		onclick={onExportMarkdown}
		class="flex h-9 items-center gap-2 rounded-[var(--radius)] border border-border px-4 text-sm font-medium text-foreground transition-colors hover:bg-black/5 dark:hover:bg-white/10"
	>
		<FileText size={14} />
		Export Markdown
	</button>
	{#if onPrint}
		<button
			onclick={onPrint}
			class="flex h-9 items-center gap-2 rounded-[var(--radius)] border border-border px-4 text-sm font-medium text-foreground transition-colors hover:bg-black/5 dark:hover:bg-white/10"
		>
			<Printer size={14} />
			Print
		</button>
	{/if}
	<div class="flex-1"></div>
	<button
		onclick={onBack}
		class="flex h-9 items-center gap-2 rounded-[var(--radius)] px-4 text-sm font-medium text-muted-foreground transition-colors hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10"
	>
		<ArrowLeft size={14} />
		Back to Review
	</button>
</div>
