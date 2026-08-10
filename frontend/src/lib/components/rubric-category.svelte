<script lang="ts">
	import type { CategoryEntry } from "$lib/types/criteria.js";
	import type { CategorySelections } from "$lib/types/session.js";
	import ChevronDown from "@lucide/svelte/icons/chevron-down";
	import Sparkles from "@lucide/svelte/icons/sparkles";
	import RubricSection from "$lib/components/rubric-section.svelte";
	import { Editor } from "@tiptap/core";
	import StarterKit from "@tiptap/starter-kit";
	import Placeholder from "@tiptap/extension-placeholder";
	import { marked } from "marked";

	/** Props for the rubric category card component. */
	interface Props {
		/** The rubric category entry (key + data) to display. */
		entry: CategoryEntry;
		/** Current selection state for this category. */
		selections: CategorySelections;
		/** Whether the category card is expanded. */
		expanded: boolean;
		/** Whether the category is in read-only mode (disables all interactions). */
		disabled?: boolean;
		/**
		 * Teacher-mode gate for the inline "Ask copilot" chip (Phase 4e).
		 * The page sets it from the copilot apiMode holder; the chip is
		 * never rendered in the student/static build.
		 */
		showAskCopilot?: boolean;
		/** Callback to toggle the category's expanded/collapsed state. */
		onToggle: () => void;
		/** Callback when a checkbox is toggled. Key is the sub-point text. */
		onToggleCheckbox: (key: string, checked: boolean) => void;
		/** Callback when a comment text is updated. */
		onUpdateComment: (key: string, value: string) => void;
		/** Callback when a deduction value is updated. */
		onUpdateDeduction: (key: string, value: number) => void;
		/** Callback when the additional notes text is updated. */
		onUpdateNotes: (value: string) => void;
	}

	let {
		entry,
		selections,
		expanded,
		disabled = false,
		showAskCopilot = false,
		onToggle,
		onToggleCheckbox,
		onUpdateComment,
		onUpdateDeduction,
		onUpdateNotes,
	}: Props = $props();

	let category = $derived(entry.category);
	let isExpanded = $derived(expanded);
	let hasCheckedItems = $derived(selections.checked_items.size > 0);

	/**
	 * Inline "Ask copilot" chip (Phase 4e): fire a `copilot-request` DOM
	 * event with a prompt about this category. The submission page listens,
	 * switches to the Copilot tab and forwards the prompt to the panel.
	 */
	function askCopilot(): void {
		window.dispatchEvent(
			new CustomEvent("copilot-request", {
				detail: `Explain how the "${category.title}" criteria apply to this submission.`,
			}),
		);
	}

	let editor = $state<Editor | null>(null);
	let editorElement = $state<HTMLDivElement | null>(null);

	// Initialize TipTap editor only when the accordion is expanded
	$effect(() => {
		if (!isExpanded || !editorElement || editor) return;

		const timer = setTimeout(() => {
			if (!editorElement) return;

			// Convert markdown notes to HTML for TipTap (StarterKit only understands HTML)
			const rawNotes = selections.notes ?? "";
			const content = rawNotes.trim().startsWith("<")
				? rawNotes
				: marked.parse(rawNotes, { async: false });

			editor = new Editor({
				element: editorElement,
				extensions: [
					StarterKit,
					Placeholder.configure({
						placeholder: "Add notes...",
					}),
				],
				content,
				editable: !disabled,
				onUpdate: ({ editor }) => {
					// Only forward updates that differ from the current external
					// notes value — otherwise our own setContent echo (sync effect
					// below) would loop: forward → parent state write → selections
					// prop change → effect → setContent → onUpdate → ...
					const rawNotes = selections.notes ?? "";
					const normalized = rawNotes.trim().startsWith("<")
						? rawNotes
						: marked.parse(rawNotes, { async: false });
					const html = editor.getHTML();
					if (html !== normalized) {
						onUpdateNotes(html);
					}
				},
			});
		}, 50);

		return () => {
			clearTimeout(timer);
		};
	});

	// Destroy editor when accordion collapses
	$effect(() => {
		if (!isExpanded && editor) {
			editor.destroy();
			editor = null;
		}
	});

	// Sync editor content when selections change externally
	$effect(() => {
		if (editor) {
			const rawNotes = selections.notes ?? "";
			const normalized = rawNotes.trim().startsWith("<")
				? rawNotes
				: marked.parse(rawNotes, { async: false });
			if (editor.getHTML() !== normalized) {
				editor.commands.setContent(normalized, { emitUpdate: false });
			}
		}
	});

	// Update editable state when disabled changes
	$effect(() => {
		if (editor) {
			editor.setEditable(!disabled);
		}
	});
</script>

<div
	id="category-{entry.key}"
	class="review-card rounded-[var(--radius)] border border-border bg-card"
>
	<div class="flex items-stretch rounded-t-[var(--radius)] border-b border-border bg-card">
		<button
			type="button"
			onclick={onToggle}
			class="flex flex-1 items-center justify-between p-3 text-left transition-colors hover:bg-black/[0.02] dark:hover:bg-white/[0.02]"
			aria-expanded={isExpanded}
			aria-controls="category-content-{entry.key}"
		>
			<div class="flex items-center gap-2">
				<span class="text-sm font-semibold text-foreground">{category.title}</span>
				{#if hasCheckedItems}
					<span class="h-1.5 w-1.5 rounded-full bg-success"></span>
				{/if}
			</div>
			<ChevronDown
				size={16}
				class="text-muted-foreground transition-transform duration-200 {isExpanded
					? ''
					: '-rotate-90'}"
			/>
		</button>
		{#if showAskCopilot}
			<button
				type="button"
				class="ask-copilot-chip"
				title="Ask copilot"
				aria-label="Ask copilot"
				onclick={askCopilot}
			>
				<Sparkles size={13} />
			</button>
		{/if}
	</div>

	<div
		id="category-content-{entry.key}"
		class="accordion-grid overflow-hidden transition-all duration-300 ease-in-out {isExpanded
			? 'open'
			: ''}"
		aria-hidden={!isExpanded}
	>
		<div class="accordion-inner min-h-0">
			<div class="space-y-3 p-3">
				{#if category.positive.length > 0}
					<RubricSection
						points={category.positive}
						sentiment="positive"
						{disabled}
						{onToggleCheckbox}
						{onUpdateComment}
						{onUpdateDeduction}
						comments={selections.comments}
						deductions={selections.deductions}
						checkedItems={selections.checked_items}
					/>
				{/if}
				{#if category.neutral.length > 0}
					<RubricSection
						points={category.neutral}
						sentiment="neutral"
						{disabled}
						{onToggleCheckbox}
						{onUpdateComment}
						{onUpdateDeduction}
						comments={selections.comments}
						deductions={selections.deductions}
						checkedItems={selections.checked_items}
					/>
				{/if}
				{#if category.negative.length > 0}
					<RubricSection
						points={category.negative}
						sentiment="negative"
						{disabled}
						{onToggleCheckbox}
						{onUpdateComment}
						{onUpdateDeduction}
						comments={selections.comments}
						deductions={selections.deductions}
						checkedItems={selections.checked_items}
					/>
				{/if}

				{#if category.additional_notes}
					<div class="space-y-2 pt-2">
						<h4
							class="text-xs font-semibold tracking-wider text-muted-foreground uppercase"
						>
							Notes
						</h4>
						<div
							bind:this={editorElement}
							class="min-h-[4.5rem] rounded-[var(--radius)] border border-border bg-background px-3 py-2 text-sm text-foreground {disabled
								? 'opacity-70'
								: ''}"
							role="textbox"
							aria-multiline="true"
							aria-label="Category notes"
						></div>
					</div>
				{/if}
			</div>
		</div>
	</div>
</div>

<style>
	.review-card {
		overflow: visible;
	}

	/* Inline "Ask copilot" chip (Phase 4e) — subtle icon-only affordance. */
	.ask-copilot-chip {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		align-self: center;
		width: 28px;
		height: 28px;
		margin-right: 8px;
		border: 1px solid transparent;
		border-radius: var(--radius);
		background: transparent;
		color: var(--muted-foreground);
		cursor: pointer;
		flex-shrink: 0;
	}
	.ask-copilot-chip:hover {
		color: var(--primary);
		background: var(--muted);
		border-color: var(--border);
	}

	.accordion-grid {
		display: grid;
		grid-template-rows: 0fr;
		transition:
			grid-template-rows 0.3s ease-in-out,
			opacity 0.3s ease-in-out;
		opacity: 0;
		overflow: hidden;
	}

	.accordion-grid.open {
		grid-template-rows: 1fr;
		opacity: 1;
	}

	.accordion-inner {
		min-height: 0;
		overflow: visible;
	}

	:global(.ProseMirror) {
		outline: none;
		min-height: 3rem;
	}
	:global(.ProseMirror:focus-visible) {
		outline: 2px solid var(--ring);
		outline-offset: 2px;
		border-radius: var(--radius);
	}

	:global(.ProseMirror p.is-editor-empty:first-child::before) {
		content: attr(data-placeholder);
		float: left;
		color: var(--muted-foreground);
		pointer-events: none;
		height: 0;
	}

	:global(.ProseMirror p) {
		margin-bottom: 0.5rem;
	}

	:global(.ProseMirror p:last-child) {
		margin-bottom: 0;
	}
</style>
