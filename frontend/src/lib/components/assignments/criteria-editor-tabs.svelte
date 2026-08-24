<script lang="ts">
	/**
	 * @file Criteria editor tabs — Visual Editor / Raw YAML / Preview.
	 *
	 * One editable draft (`EditableCategory[]`) shared by all three tabs:
	 *   - Visual Editor: controlled CriteriaEditor (category/main-point CRUD)
	 *   - Raw YAML: live-editable YAML; valid edits re-parse into the draft,
	 *     invalid edits show an inline error and keep the last valid draft
	 *   - Preview: read-only rubric rendering of the draft
	 *
	 * Save validates the shared draft, PUTs it to the assignment's criteria
	 * file, and clears the rubric cache so review pages pick it up.
	 */
	import * as yaml from "js-yaml";
	import PenLine from "@lucide/svelte/icons/pen-line";
	import FileCode2 from "@lucide/svelte/icons/file-code-2";
	import Eye from "@lucide/svelte/icons/eye";
	import Save from "@lucide/svelte/icons/save";
	import Sparkles from "@lucide/svelte/icons/sparkles";
	import LoaderCircle from "@lucide/svelte/icons/loader-circle";
	import TriangleAlert from "@lucide/svelte/icons/triangle-alert";

	import { Button } from "$lib/components/ui/button/index.js";
	import { draftCriteria, saveCriteria } from "$lib/services/submissions-api.js";
	import { clearCache } from "$lib/services/criteria-loader.js";
	import { addToast } from "$lib/stores/toast.svelte.js";
	import type { CriteriaFile } from "$lib/types/criteria.js";
	import CriteriaEditor from "./criteria-editor.svelte";
	import CriteriaPreview from "./criteria-preview.svelte";
	import {
		fromServerCategories,
		toServerCategories,
		validateCategories,
		type EditableCategory,
	} from "./criteria-editor-model.js";

	interface Props {
		assignmentId: string;
		/** Existing criteria, or null when the assignment has no own file yet. */
		initial: CriteriaFile | null;
		/**
		 * Fixed grading dimensions (key + title) driving the editor's chip
		 * pickers and the preview's dimension chips. Empty when the grading
		 * config could not be loaded — the UI degrades gracefully.
		 */
		dimensions?: { key: string; title: string }[];
	}

	let { assignmentId, initial, dimensions = [] }: Props = $props();

	type Tab = "visual" | "yaml" | "preview";
	const TABS: { id: Tab; label: string; icon: typeof PenLine }[] = [
		{ id: "visual", label: "Visual Editor", icon: PenLine },
		{ id: "yaml", label: "Raw YAML", icon: FileCode2 },
		{ id: "preview", label: "Preview", icon: Eye },
	];

	let activeTab = $state<Tab>("visual");
	let categories = $state<EditableCategory[]>([]);
	let yamlText = $state("");
	let yamlError = $state<string | null>(null);
	let busy = $state(false);
	let drafting = $state(false);
	let saveError = $state<string | null>(null);
	let draftError = $state<string | null>(null);
	/** Consistency-pass notes from the draft pipeline (coverage gaps etc.). */
	let draftNotes = $state<string[]>([]);
	let validationError = $state<string | null>(null);
	/** JSON of the last saved server shape — dirty = draft differs from it. */
	let savedServerShape = $state("");

	// Seed the draft whenever the loaded criteria change (the parent remounts
	// per assignment; this also re-seeds after a fresh page load).
	let seededInitial: CriteriaFile | null | undefined = undefined;
	$effect(() => {
		if (seededInitial === initial) return;
		seededInitial = initial;
		categories = fromServerCategories(initial?.categories ?? {});
		yamlText = yaml.dump({ categories: toServerCategories(categories) });
		savedServerShape = JSON.stringify(toServerCategories(categories));
	});

	let dirty = $derived(JSON.stringify(toServerCategories(categories)) !== savedServerShape);

	function switchTab(tab: Tab) {
		if (tab === "yaml") {
			// Re-sync the raw text from the draft when entering the tab.
			yamlText = yaml.dump({ categories: toServerCategories(categories) });
			yamlError = null;
		}
		activeTab = tab;
	}

	/** Parse typed YAML into the shared draft; invalid text keeps the last valid draft. */
	function handleYamlInput(value: string) {
		yamlText = value;
		try {
			const parsed = yaml.load(value) as
				{ categories?: Record<string, unknown> } | null | undefined;
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				throw new Error("expected a mapping with a `categories` key");
			}
			const categoriesMap = parsed.categories;
			if (
				!categoriesMap ||
				typeof categoriesMap !== "object" ||
				Array.isArray(categoriesMap)
			) {
				throw new Error("`categories` must be a mapping of category keys to objects");
			}
			categories = fromServerCategories(categoriesMap as CriteriaFile["categories"]);
			yamlError = null;
		} catch (e) {
			yamlError = e instanceof Error ? e.message : "invalid YAML";
		}
	}

	async function handleSave() {
		if (busy) return;
		saveError = null;
		validationError = null;

		const problem = validateCategories(categories);
		if (problem) {
			validationError = problem;
			return;
		}

		busy = true;
		try {
			const response = await saveCriteria(assignmentId, toServerCategories(categories));
			clearCache();
			categories = fromServerCategories(response.content.categories);
			yamlText = yaml.dump({ categories: toServerCategories(categories) });
			savedServerShape = JSON.stringify(toServerCategories(categories));
			addToast("success", `Criteria saved for ${assignmentId}`, 3000);
		} catch (e) {
			saveError = e instanceof Error ? e.message : "Failed to save criteria";
		} finally {
			busy = false;
		}
	}

	/**
	 * Ask the LLM endpoint for a draft criteria document and re-seed the
	 * editor draft with it. NEVER persists: the draft replaces the current
	 * editor draft (the dirty chip appears because `savedServerShape` is
	 * unchanged), and the teacher must review and click Save — which goes
	 * through the existing compile-gate PUT.
	 */
	async function handleDraft() {
		if (busy || drafting) return;
		draftError = null;
		saveError = null;
		validationError = null;
		drafting = true;
		try {
			const { draft, notes } = await draftCriteria(assignmentId);
			if (!draft) {
				draftError = "Draft failed: the server returned no draft";
				return;
			}
			categories = fromServerCategories(draft.categories);
			yamlText = yaml.dump({ categories: toServerCategories(categories) });
			if (notes && notes.length > 0) {
				draftNotes = notes;
			}
			addToast("success", "Draft generated — review before saving", 3500);
		} catch (e) {
			draftError = `Draft failed: ${e instanceof Error ? e.message : "unknown error"}`;
		} finally {
			drafting = false;
		}
	}
</script>

<div class="criteria-editor-tabs">
	<div class="tab-bar">
		<div class="tab-list" role="tablist" aria-label="Criteria editor mode">
			{#each TABS as tab (tab.id)}
				<button
					type="button"
					role="tab"
					aria-selected={activeTab === tab.id}
					class="tab-button {activeTab === tab.id ? 'active' : ''}"
					onclick={() => switchTab(tab.id)}
				>
					<tab.icon size={14} />
					{tab.label}
				</button>
			{/each}
		</div>
		<div class="tab-actions">
			{#if dirty}
				<span class="dirty-chip" title="Unsaved changes">Unsaved changes</span>
			{/if}
			<Button
				variant="secondary"
				size="sm"
				onclick={handleDraft}
				disabled={busy || drafting}
				title="Generate a draft criteria document from the assignment's rubric (review before saving)"
			>
				{#if drafting}
					<span class="spinner"><LoaderCircle size={14} /></span>
				{:else}
					<Sparkles size={14} />
				{/if}
				{drafting ? "Drafting…" : "Draft with AI"}
			</Button>
			<Button
				variant="default"
				size="sm"
				onclick={handleSave}
				disabled={busy || !dirty || drafting}
				title="Validate and save the current criteria"
			>
				{#if busy}
					<span class="spinner"><LoaderCircle size={14} /></span>
				{:else}
					<Save size={14} />
				{/if}
				{busy ? "Saving…" : "Save criteria"}
			</Button>
		</div>
	</div>

	{#if validationError || saveError || draftError}
		<div class="editor-error" role="alert">
			<TriangleAlert size={14} class="shrink-0" />
			<span>{validationError ?? saveError ?? draftError}</span>
		</div>
	{/if}

	{#if draftNotes.length > 0}
		<div class="draft-notes" role="note">
			<TriangleAlert size={14} class="shrink-0" />
			<div class="draft-notes-body">
				<p class="draft-notes-title">Draft notes — review before saving</p>
				<ul class="draft-notes-list">
					{#each draftNotes as note (note)}
						<li>{note}</li>
					{/each}
				</ul>
			</div>
		</div>
	{/if}

	<div class="tab-panel" role="tabpanel">
		{#if activeTab === "visual"}
			<CriteriaEditor {categories} {dimensions} onChange={(next) => (categories = next)} />
		{:else if activeTab === "yaml"}
			<div class="yaml-panel">
				<textarea
					class="yaml-textarea {yamlError ? 'has-error' : ''}"
					value={yamlText}
					oninput={(e) => handleYamlInput(e.currentTarget.value)}
					spellcheck="false"
					aria-label="Raw criteria YAML"></textarea>
				{#if yamlError}
					<p class="yaml-error" role="alert">
						<TriangleAlert size={13} class="shrink-0" />
						<span>YAML problem: {yamlError}</span>
					</p>
				{:else}
					<p class="yaml-hint">
						Edits are parsed live into the Visual Editor and Preview. Save writes the
						current draft to the assignment's criteria file.
					</p>
				{/if}
			</div>
		{:else}
			<CriteriaPreview {categories} {dimensions} />
		{/if}
	</div>
</div>

<style>
	.criteria-editor-tabs {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}
	.tab-bar {
		display: flex;
		align-items: center;
		gap: 12px;
		flex-wrap: wrap;
		border-bottom: 1px solid var(--border);
		padding-bottom: 10px;
	}
	.tab-list {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 3px;
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: var(--muted);
	}
	.tab-button {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 5px 12px;
		border: none;
		border-radius: calc(var(--radius-md) - 2px);
		background: transparent;
		color: var(--muted-foreground);
		font-size: 12.5px;
		font-weight: 500;
		cursor: pointer;
		white-space: nowrap;
		transition:
			background 0.15s,
			color 0.15s;
	}
	.tab-button:hover {
		color: var(--fg);
	}
	.tab-button.active {
		background: var(--card);
		color: var(--fg);
		box-shadow: 0 1px 2px rgb(0 0 0 / 0.08);
	}
	.tab-actions {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-left: auto;
	}
	.dirty-chip {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-size: 12px;
		font-weight: 500;
		color: var(--warning);
	}
	.dirty-chip::before {
		content: "";
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--warning);
	}
	.editor-error {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		padding: 9px 11px;
		border: 1px solid color-mix(in oklch, var(--destructive) 35%, transparent);
		border-radius: var(--radius-md);
		background: color-mix(in oklch, var(--destructive) 8%, transparent);
		color: var(--destructive);
		font-size: 12.5px;
	}
	.draft-notes {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		padding: 9px 11px;
		border: 1px solid color-mix(in oklch, var(--warning) 35%, transparent);
		border-radius: var(--radius-md);
		background: color-mix(in oklch, var(--warning) 8%, transparent);
		color: var(--muted-foreground);
		font-size: 12.5px;
	}
	.draft-notes-body {
		min-width: 0;
	}
	.draft-notes-title {
		margin: 0;
		font-weight: 600;
		color: var(--foreground);
	}
	.draft-notes-list {
		margin: 4px 0 0;
		padding-left: 18px;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.draft-notes :global(svg) {
		margin-top: 1px;
		flex-shrink: 0;
		color: var(--warning);
	}
	.tab-panel {
		min-width: 0;
	}
	.yaml-panel {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.yaml-textarea {
		width: 100%;
		min-height: 420px;
		padding: 12px 14px;
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: var(--background);
		color: var(--fg);
		font-family: var(--font-mono);
		font-size: 12.5px;
		line-height: 1.55;
		resize: vertical;
		tab-size: 2;
		transition: border-color 0.15s;
	}
	.yaml-textarea:focus {
		outline: none;
		border-color: var(--ring);
		box-shadow: 0 0 0 2px color-mix(in oklch, var(--ring) 25%, transparent);
	}
	.yaml-textarea.has-error {
		border-color: color-mix(in oklch, var(--destructive) 50%, var(--border));
	}
	.yaml-error {
		display: flex;
		align-items: flex-start;
		gap: 6px;
		margin: 0;
		font-size: 12px;
		color: var(--destructive);
	}
	.yaml-hint {
		margin: 0;
		font-size: 12px;
		color: var(--muted-foreground);
	}
	.spinner {
		display: inline-flex;
		animation: spin 0.9s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
</style>
