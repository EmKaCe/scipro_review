<script lang="ts">
	/**
	 * Autofix card for one failed cell (P3-3, human-writes-final model).
	 *
	 * State machine:
	 *   - no suggestion yet  → "Auto-fix unavailable" + [Suggest fix]
	 *   - suggestion.skipped → same, with a note that the fix service was
	 *                          not reachable (retry allowed)
	 *   - suggestion ready   → read-only suggestion (explanation + summary,
	 *                          Original/Patched source toggle, confidence)
	 *                          + [Copy to notes] → editable textarea
	 *                          pre-filled with the suggestion → Save persists
	 *                          the teacher's EDITED version into the
	 *                          submission notes; Reset restores the original
	 *                          suggestion text.
	 *
	 * The original suggestion stays in the store for Reset — the teacher
	 * writes the final review; the AI only suggests and assists.
	 */
	import { autofixStore } from "$lib/services/autofix-store.svelte.js";
	import { addToast } from "$lib/stores/toast.svelte.js";
	import Wrench from "@lucide/svelte/icons/wrench";
	import ShieldCheck from "@lucide/svelte/icons/shield-check";
	import CircleCheck from "@lucide/svelte/icons/circle-check";
	import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
	import Copy from "@lucide/svelte/icons/copy";
	import LoaderCircle from "@lucide/svelte/icons/loader-circle";
	import { Button } from "$lib/components/ui/button/index.js";

	interface Props {
		/** 0-based cell index in the notebook. */
		cellIndex: number;
		/** The failing cell's source (as executed). */
		source: string;
		/** Error message from the failed execution. */
		error: string;
		/** Traceback lines (optional). */
		traceback?: string[] | null;
		/** Submission id — autofix route + notes persistence target. */
		submissionId: string;
		/** Assignment id — route scoping. */
		assignmentId: string;
		/** Existing submission notes (autofix notes are appended to them). */
		existingNotes?: string;
		/** Notify the parent that the top-level notes changed (saved notes). */
		onNotesSaved?: (notes: string) => void;
	}

	let {
		cellIndex,
		source,
		error,
		traceback,
		submissionId,
		assignmentId,
		existingNotes = "",
		onNotesSaved,
	}: Props = $props();

	// Reactive store state for this cell.
	let suggestion = $derived(autofixStore.suggestionFor(cellIndex));
	let requesting = $derived(autofixStore.isRequesting(cellIndex));
	let requestError = $derived(autofixStore.errors.get(cellIndex));
	let noteDraft = $derived(autofixStore.notes.get(cellIndex) ?? "");
	let isSaved = $derived(autofixStore.saved.has(cellIndex));
	let verifyResult = $derived(autofixStore.verifyResultFor(cellIndex));
	let verifying = $derived(autofixStore.isVerifying(cellIndex));
	let verifyError = $derived(autofixStore.verifyErrors.get(cellIndex));

	let editorOpen = $state(false);
	let showPatched = $state(true);
	let saving = $state(false);

	/** The suggestion's summary text — pre-fills the notes editor. */
	let suggestionText = $derived(suggestion?.explanation ?? suggestion?.suggestion ?? "");

	async function handleSuggest() {
		await autofixStore.suggest(submissionId, assignmentId, {
			cellIndex,
			cellSource: source,
			cellError: error,
			traceback: traceback ?? [],
		});
		// If the suggestion arrived and is usable, surface the notes editor
		// hint through the card itself; the teacher opens it explicitly.
	}

	async function handleVerify() {
		// The patched source is only SYNTAX-valid at this point — claiming
		// "Fixed" would be dishonest. Verification re-runs the WHOLE
		// notebook (never a single cell: that loses kernel state built by
		// earlier cells — the _00 regression) and reports the truth.
		const patched = suggestion?.patchedSource;
		if (!patched) return;
		await autofixStore.verify(submissionId, assignmentId, cellIndex, patched);
	}

	async function handleCopyToNotes() {
		editorOpen = true;
		autofixStore.notes.set(cellIndex, suggestionText);
	}

	async function handleSaveNote() {
		saving = true;
		try {
			const notes = await autofixStore.saveNote(
				submissionId,
				assignmentId,
				cellIndex,
				noteDraft,
				existingNotes,
			);
			onNotesSaved?.(notes);
			addToast("success", `Note for cell ${cellIndex + 1} saved`, 3000);
		} catch (err) {
			addToast("error", err instanceof Error ? err.message : "Failed to save note", 4000);
		} finally {
			saving = false;
		}
	}

	function handleResetNote() {
		autofixStore.notes.set(cellIndex, suggestionText);
	}

	function confidencePct(): string | null {
		if (suggestion?.confidence === null || suggestion?.confidence === undefined) return null;
		return `${Math.round(suggestion.confidence * 100)}%`;
	}
</script>

<div class="autofix-card" class:autofix-card-skipped={suggestion?.skipped ?? false}>
	<!-- ── Header ── -->
	<div class="autofix-header">
		<Wrench size={14} style="color: var(--muted-foreground); flex-shrink: 0" />
		<span class="autofix-label">
			{suggestion
				? suggestion.skipped
					? "Auto-fix unavailable"
					: "Auto-fix attempted"
				: "Auto-fix"}
		</span>
		{#if suggestion && !suggestion.skipped}
			<span
				class="autofix-badge {verifyResult?.fixed
					? 'autofix-badge-fixed'
					: 'autofix-badge-failing'}"
			>
				{#if verifyResult?.fixed}
					<CircleCheck size={11} />
					Verified
				{:else}
					<TriangleAlert size={11} />
					Needs review
				{/if}
			</span>
		{/if}
	</div>

	{#if requestError}
		<div class="autofix-note autofix-error">
			<TriangleAlert size={12} />
			<span>Fix request failed: {requestError}</span>
		</div>
	{/if}

	{#if !suggestion}
		<!-- No request yet: the card is idle, not failed. -->
		{#if requesting}
			<div class="autofix-note">
				<LoaderCircle size={12} class="spin" />
				<span>Asking the fix service…</span>
			</div>
		{:else}
			<div class="autofix-note">
				No fix requested yet — click "Suggest fix" to ask the fix service.
			</div>
			<div class="autofix-footer">
				<Button variant="outline" size="xs" onclick={handleSuggest}>Suggest fix</Button>
			</div>
		{/if}
	{:else if suggestion.skipped}
		<!-- A request was made and the service returned nothing usable. -->
		<div class="autofix-note">The fix service was not reachable for this cell.</div>
		<div class="autofix-footer">
			<Button variant="outline" size="xs" onclick={handleSuggest} disabled={requesting}>
				{#if requesting}
					<LoaderCircle size={11} class="spin" />
				{/if}
				Suggest fix
			</Button>
		</div>
	{:else}
		<!-- Suggestion available: read-only summary + source toggle. -->
		{#if suggestionText}
			<div class="autofix-summary">{suggestionText}</div>
		{/if}

		{#if suggestion.patchedSource}
			<div class="autofix-toggle" role="group" aria-label="Source view">
				<Button
					variant="ghost"
					size="xs"
					aria-pressed={!showPatched}
					class={!showPatched ? "bg-accent text-accent-foreground" : ""}
					onclick={() => (showPatched = false)}
				>
					Original
				</Button>
				<Button
					variant="ghost"
					size="xs"
					aria-pressed={showPatched}
					class={showPatched ? "bg-accent text-accent-foreground" : ""}
					onclick={() => (showPatched = true)}
				>
					Patched
				</Button>
			</div>
			<div class="autofix-code">
				{#if showPatched}
					<pre>{suggestion.patchedSource}</pre>
				{:else}
					<pre>{source}</pre>
				{/if}
			</div>
		{/if}

		<div class="autofix-footer">
			{#if confidencePct()}
				<span class="autofix-confidence">Confidence {confidencePct()}</span>
			{/if}
			{#if suggestion.patchedSource && !verifyResult?.fixed}
				<Button variant="outline" size="xs" onclick={handleVerify} disabled={verifying}>
					{#if verifying}
						<LoaderCircle size={11} class="spin" />
					{:else}
						<ShieldCheck size={11} />
					{/if}
					{verifying ? "Verifying…" : "Verify fix"}
				</Button>
			{/if}
			<Button variant="outline" size="xs" onclick={handleCopyToNotes}>
				<Copy size={11} />
				Copy to notes
			</Button>
		</div>

		{#if verifyError}
			<div class="autofix-note autofix-error">
				<TriangleAlert size={12} />
				<span>Verification failed: {verifyError}</span>
			</div>
		{:else if verifyResult}
			{#if verifyResult.fixed}
				<div class="autofix-note autofix-verified">
					<CircleCheck size={12} />
					<span>
						Verified — runs clean with the whole notebook
						{#if verifyResult.reRunOutput}
							· output: {verifyResult.reRunOutput}
						{/if}
					</span>
				</div>
			{:else}
				<div class="autofix-note autofix-error">
					<TriangleAlert size={12} />
					<span>
						Still fails in the notebook:
						{verifyResult.reRunError ?? "unknown error"}
					</span>
				</div>
			{/if}
		{/if}

		<!-- Notes editor: the teacher edits the suggestion before it lands. -->
		{#if editorOpen}
			<div class="autofix-notes-editor">
				<textarea
					class="autofix-notes-textarea"
					rows="3"
					value={noteDraft}
					oninput={(e) => autofixStore.notes.set(cellIndex, e.currentTarget.value)}
					placeholder="Write your note for the student…"></textarea>
				<div class="autofix-notes-actions">
					<Button variant="default" size="xs" onclick={handleSaveNote} disabled={saving}>
						{#if saving}
							<LoaderCircle size={11} class="spin" />
						{/if}
						{isSaved ? "Save again" : "Save"}
					</Button>
					<Button variant="outline" size="xs" onclick={handleResetNote}>Reset</Button>
				</div>
			</div>
		{/if}
	{/if}
</div>

<style>
	.autofix-card {
		margin-top: 10px;
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: var(--card);
		padding: 10px 12px;
	}
	.autofix-header {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.autofix-label {
		font-size: 12px;
		font-weight: 600;
		color: var(--fg);
	}
	.autofix-badge {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 1px 8px;
		border-radius: 999px;
		font-size: 10px;
		font-weight: 600;
		margin-left: auto;
	}
	.autofix-badge-fixed {
		background: color-mix(in oklch, var(--success) 12%, transparent);
		color: var(--success);
		border: 1px solid color-mix(in oklch, var(--success) 25%, transparent);
	}
	.autofix-badge-failing {
		background: color-mix(in oklch, var(--warning) 12%, transparent);
		color: var(--warning);
		border: 1px solid color-mix(in oklch, var(--warning) 25%, transparent);
	}
	.autofix-summary {
		margin-top: 8px;
		font-size: 12px;
		line-height: 1.5;
		color: var(--muted-foreground);
	}
	.autofix-toggle {
		display: inline-flex;
		margin-top: 8px;
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		overflow: hidden;
	}
	.autofix-code {
		margin-top: 6px;
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: color-mix(in oklch, var(--fg) 4%, var(--bg));
		overflow: auto;
	}
	.autofix-code pre {
		margin: 0;
		padding: 8px 10px;
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 11px;
		line-height: 1.5;
		color: var(--fg);
		white-space: pre;
		tab-size: 2;
	}
	.autofix-note {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-top: 8px;
		font-size: 11px;
		color: var(--muted-foreground);
	}
	.autofix-error {
		color: var(--error);
	}
	.autofix-verified {
		color: var(--success);
	}
	.autofix-footer {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		margin-top: 8px;
	}
	.autofix-confidence {
		font-size: 11px;
		color: var(--muted-foreground);
		font-variant-numeric: tabular-nums;
	}
	.autofix-notes-editor {
		margin-top: 10px;
		border-top: 1px solid var(--border);
		padding-top: 10px;
	}
	.autofix-notes-textarea {
		width: 100%;
		box-sizing: border-box;
		padding: 8px;
		border: 1px solid var(--input);
		border-radius: var(--radius-md);
		font-size: 12px;
		font-family: var(--font-mono, ui-monospace, monospace);
		resize: vertical;
		background: var(--bg);
		color: var(--fg);
	}
	.autofix-notes-textarea:focus {
		outline: none;
		border-color: var(--ring);
		box-shadow: 0 0 0 2px color-mix(in oklch, var(--ring) 30%, transparent);
	}
	.autofix-notes-actions {
		display: flex;
		gap: 6px;
		margin-top: 6px;
	}
	/* Lucide icons render <svg> via components — :global for the analyzer. */
	:global(.spin) {
		animation: spin 0.9s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
</style>
