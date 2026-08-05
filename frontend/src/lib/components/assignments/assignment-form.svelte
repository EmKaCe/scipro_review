<script lang="ts">
	/**
	 * @file Assignment form — create/edit an assignment.
	 *
	 * Fields: id (disabled when editing), title, enabled, criteria_files
	 * (comma-separated), and the 5 known grading dimensions as checkboxes
	 * (the catalog is deliberately hardcoded — it mirrors the writer's
	 * KNOWN_DIMENSIONS set; see grading.ts).
	 *
	 * The criteria-upload component lives next to this form (rendered by the
	 * parent page); after a successful upload the parent refreshes the
	 * assignment list, so the next edit session includes the new path.
	 *
	 * Client-side validation (id pattern, non-empty title, >= 1 dimension)
	 * is shown inline; server 400s surface through the onSubmit rejection.
	 */

	import type { AssignmentSummary } from "$lib/services/submissions-api.js";

	/** The 5 grading dimensions the rubric knows about (see grading.ts). */
	export const DIMENSION_CATALOG = [
		"code_quality_design",
		"code_execution_results",
		"assignment_requirements",
		"scientific_programming",
		"creativity",
	] as const;

	/** Payload submitted by the form (create or partial update). */
	export interface AssignmentFormPayload {
		id: string;
		title: string;
		enabled: boolean;
		criteria_files: string[];
		dimensions: string[];
	}

	interface Props {
		/** Existing assignment when editing, null when creating. */
		initial?: (AssignmentSummary & { dimensions?: string[] }) | null;
		/** Invoked with the parsed payload on a valid submit (may reject with the server error). */
		onSubmit: (input: AssignmentFormPayload) => Promise<void>;
		/** When true the submit button shows a busy state and is disabled. */
		busy?: boolean;
	}

	let { initial = null, onSubmit, busy = false }: Props = $props();

	let editing = $derived(initial !== null);
	let id = $state("");
	let title = $state("");
	let enabled = $state(true);
	let criteriaText = $state("");
	/** Checked dimension keys; default to the full catalog for new assignments. */
	let dimensions = $state<string[]>([]);
	/** Guards the one-time initialization effect below. */
	let initialized = false;

	// Initialize from the `initial` prop once on mount (the parent remounts
	// this form per assignment via {#if formOpen}).
	$effect(() => {
		if (initialized) return;
		initialized = true;
		if (initial === null) {
			id = "";
			title = "";
			enabled = true;
			criteriaText = "";
			dimensions = [...DIMENSION_CATALOG];
		} else {
			id = initial.id;
			title = initial.title;
			enabled = initial.enabled;
			criteriaText = (initial.criteria_files ?? []).join(", ");
			dimensions =
				initial.dimensions !== undefined && initial.dimensions.length > 0
					? [...initial.dimensions]
					: [...DIMENSION_CATALOG];
		}
	});

	let idError = $state<string | null>(null);
	let titleError = $state<string | null>(null);
	let dimensionsError = $state<string | null>(null);
	let submitError = $state<string | null>(null);

	const ID_PATTERN = /^[a-z0-9_]+$/;

	function toggleDimension(key: string) {
		dimensions = dimensions.includes(key)
			? dimensions.filter((d) => d !== key)
			: [...dimensions, key];
		if (dimensions.length > 0) dimensionsError = null;
	}

	/** Parse the comma-separated criteria_files input, trimming empties. */
	function parseCriteriaFiles(): string[] {
		return criteriaText
			.split(",")
			.map((s) => s.trim())
			.filter((s) => s.length > 0);
	}

	async function handleSubmit(e: SubmitEvent) {
		e.preventDefault();
		submitError = null;
		idError = null;
		titleError = null;
		dimensionsError = null;

		let valid = true;
		if (!editing && !ID_PATTERN.test(id)) {
			idError = "Id must match ^[a-z0-9_]+$ (lowercase letters, digits, underscores)";
			valid = false;
		}
		if (title.trim().length === 0) {
			titleError = "Title is required";
			valid = false;
		}
		if (dimensions.length === 0) {
			dimensionsError = "Select at least one dimension";
			valid = false;
		}
		if (!valid) return;

		try {
			await onSubmit({
				id,
				title: title.trim(),
				enabled,
				criteria_files: parseCriteriaFiles(),
				dimensions,
			});
		} catch (err) {
			submitError = err instanceof Error ? err.message : "Save failed";
		}
	}
</script>

<form onsubmit={handleSubmit} class="assignment-form">
	<div class="field">
		<label for="assignment-id">Id</label>
		<input
			id="assignment-id"
			type="text"
			bind:value={id}
			disabled={editing}
			placeholder="snake_case_id"
			spellcheck="false"
			autocomplete="off"
		/>
		{#if idError}<p class="field-error">{idError}</p>{/if}
	</div>

	<div class="field">
		<label for="assignment-title">Title</label>
		<input
			id="assignment-title"
			type="text"
			bind:value={title}
			placeholder="Assignment title shown to students"
		/>
		{#if titleError}<p class="field-error">{titleError}</p>{/if}
	</div>

	<label class="toggle-row">
		<input id="assignment-enabled" type="checkbox" bind:checked={enabled} />
		<span>Enabled (visible in the student assignment selector)</span>
	</label>

	<div class="field">
		<label for="assignment-criteria">Criteria files</label>
		<input
			id="assignment-criteria"
			type="text"
			bind:value={criteriaText}
			placeholder="data/criteria/general.yaml, data/criteria/my.yaml"
			spellcheck="false"
		/>
		<p class="field-hint">Comma-separated paths relative to the data directory.</p>
	</div>

	<fieldset class="dimensions">
		<legend>Dimensions</legend>
		{#each DIMENSION_CATALOG as key (key)}
			<label class="dimension-row">
				<input
					type="checkbox"
					checked={dimensions.includes(key)}
					onchange={() => toggleDimension(key)}
				/>
				<span>{key}</span>
			</label>
		{/each}
		{#if dimensionsError}<p class="field-error">{dimensionsError}</p>{/if}
	</fieldset>

	{#if submitError}<p class="field-error submit-error">{submitError}</p>{/if}

	<div class="form-actions">
		<button type="submit" class="btn-submit" disabled={busy}>
			{busy ? "Saving…" : editing ? "Save changes" : "Create assignment"}
		</button>
	</div>
</form>

<style>
	.assignment-form {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}
	.field {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.field label,
	.dimensions legend {
		font-size: 13px;
		font-weight: 600;
		color: var(--fg);
	}
	.field input[type="text"] {
		height: 36px;
		padding: 0 10px;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--card);
		color: var(--fg);
		font-size: 14px;
	}
	.field input[type="text"]:focus {
		outline: 2px solid var(--ring);
		outline-offset: 1px;
	}
	.field input:disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}
	.field-hint {
		font-size: 12px;
		color: var(--muted);
	}
	.field-error {
		margin: 0;
		font-size: 12.5px;
		color: var(--destructive);
	}
	.toggle-row,
	.dimension-row {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 14px;
		cursor: pointer;
	}
	.toggle-row input,
	.dimension-row input {
		width: 15px;
		height: 15px;
		accent-color: var(--primary);
	}
	.dimensions {
		display: flex;
		flex-direction: column;
		gap: 8px;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 12px;
	}
	.dimensions legend {
		padding: 0 6px;
	}
	.dimension-row span {
		font-family: var(--font-mono, monospace);
		font-size: 13px;
	}
	.submit-error {
		padding: 8px 10px;
		border: 1px solid color-mix(in oklch, var(--destructive) 40%, transparent);
		border-radius: var(--radius);
		background: color-mix(in oklch, var(--destructive) 8%, transparent);
	}
	.form-actions {
		display: flex;
		justify-content: flex-end;
	}
	.btn-submit {
		height: 34px;
		padding: 0 16px;
		border: 1px solid var(--accent);
		border-radius: var(--radius);
		background: var(--accent);
		color: var(--accent-on);
		font-size: 13px;
		font-weight: 600;
		cursor: pointer;
		transition: opacity 0.15s;
	}
	.btn-submit:hover:not(:disabled) {
		opacity: 0.9;
	}
	.btn-submit:disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}
</style>
