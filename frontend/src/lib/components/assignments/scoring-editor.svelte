<script lang="ts">
	/**
	 * @file Visual scoring-config editor — anchors / evidence patterns /
	 * disallowed libraries / dimension guidance CRUD.
	 *
	 * Controlled component: the parent (scoring-editor-tabs) owns the draft
	 * and passes it down; every mutation reports back via `onChange`. Save,
	 * validation, raw-YAML and preview live in the parent wrapper.
	 */
	import ChevronDown from "@lucide/svelte/icons/chevron-down";
	import ChevronUp from "@lucide/svelte/icons/chevron-up";
	import Plus from "@lucide/svelte/icons/plus";
	import Trash2 from "@lucide/svelte/icons/trash-2";

	import { Button } from "$lib/components/ui/button/index.js";
	import {
		ANCHOR_KEYS,
		EVIDENCE_SEMANTICS,
		HAYSTACKS,
		SCORING_DIMENSIONS,
		type EditablePattern,
		type EditableScoringConfig,
		emptyPattern,
	} from "./scoring-editor-model.js";

	interface Props {
		/** Current draft (owned by the parent tabs wrapper). */
		draft: EditableScoringConfig;
		/** Report a mutation; the parent replaces its draft with `next`. */
		onChange: (next: EditableScoringConfig) => void;
	}

	let { draft, onChange }: Props = $props();

	// -----------------------------------------------------------------------
	// Anchors
	// -----------------------------------------------------------------------

	function setAnchor(key: string, value: string) {
		onChange({ ...draft, anchors: { ...draft.anchors, [key]: value } });
	}

	// -----------------------------------------------------------------------
	// Evidence patterns
	// -----------------------------------------------------------------------

	function addPattern() {
		onChange({
			...draft,
			evidencePatterns: [
				...draft.evidencePatterns,
				emptyPattern(draft.evidencePatterns.map((p) => p.key)),
			],
		});
	}

	function removePattern(index: number) {
		onChange({
			...draft,
			evidencePatterns: draft.evidencePatterns.filter((_, i) => i !== index),
		});
	}

	function movePattern(index: number, dir: -1 | 1) {
		const target = index + dir;
		if (target < 0 || target >= draft.evidencePatterns.length) return;
		const next = [...draft.evidencePatterns];
		const [item] = next.splice(index, 1);
		next.splice(target, 0, item!);
		onChange({ ...draft, evidencePatterns: next });
	}

	function updatePattern(index: number, patch: Partial<EditablePattern>) {
		onChange({
			...draft,
			evidencePatterns: draft.evidencePatterns.map((p, i) =>
				i === index ? { ...p, ...patch } : p,
			),
		});
	}

	// -----------------------------------------------------------------------
	// Disallowed libraries
	// -----------------------------------------------------------------------

	function setDisallowedLibraries(value: string) {
		onChange({ ...draft, disallowedLibraries: value });
	}

	// -----------------------------------------------------------------------
	// Dimension guidance
	// -----------------------------------------------------------------------

	const guidanceDimensions = $derived(
		SCORING_DIMENSIONS.filter((dim) => dim in draft.dimensionGuidance),
	);
	const addableDimensions = $derived(
		SCORING_DIMENSIONS.filter((dim) => !(dim in draft.dimensionGuidance)),
	);

	function setGuidance(dim: string, value: string) {
		onChange({
			...draft,
			dimensionGuidance: { ...draft.dimensionGuidance, [dim]: value },
		});
	}

	function removeGuidance(dim: string) {
		const next = { ...draft.dimensionGuidance };
		delete next[dim];
		onChange({ ...draft, dimensionGuidance: next });
	}

	function addGuidance(dim: string) {
		onChange({
			...draft,
			dimensionGuidance: { ...draft.dimensionGuidance, [dim]: "" },
		});
	}
</script>

<div class="scoring-editor">
	<!-- ── 1. Anchors ─────────────────────────────────────────────────── -->
	<section class="editor-section">
		<h3 class="section-title">Calibration anchors</h3>
		<p class="section-hint">
			Leave all empty to disable calibration. Anchors are all-or-nothing: either fill
			every field or clear them all before saving.
		</p>
		<div class="anchor-grid">
			{#each ANCHOR_KEYS as key (key)}
				<label class="anchor-field">
					<span class="anchor-label">{key}</span>
					<input
						class="input anchor-input"
						type="text"
						inputmode="decimal"
						aria-label="Anchor {key}"
						placeholder="—"
						value={draft.anchors[key] ?? ""}
						oninput={(e) => setAnchor(key, (e.currentTarget as HTMLInputElement).value)}
					/>
				</label>
			{/each}
		</div>
	</section>

	<!-- ── 2. Evidence patterns ────────────────────────────────────────── -->
	<section class="editor-section">
		<h3 class="section-title">Evidence patterns</h3>
		<p class="section-hint">
			Regexes matched against the notebook's output / code / markdown. For
			<code>test_all</code>, put one pattern per line — all must match. For
			<code>capture_value</code> / <code>distinct_count</code>, set the capture group.
		</p>
		{#if draft.evidencePatterns.length === 0}
			<p class="section-empty">No evidence patterns yet — add your first one below.</p>
		{/if}
		{#each draft.evidencePatterns as pattern, index (pattern.key)}
			<div class="pattern-card">
				<div class="pattern-head">
					<input
						class="input pattern-key-input"
						aria-label="Pattern key"
						value={pattern.key}
						oninput={(e) =>
							updatePattern(index, {
								key: (e.currentTarget as HTMLInputElement).value.trim(),
							})}
					/>
					<select
						class="input pattern-select"
						aria-label="Pattern semantics"
						value={pattern.semantics}
						onchange={(e) =>
							updatePattern(index, {
								semantics: (e.currentTarget as HTMLSelectElement).value as EditablePattern["semantics"],
							})}
					>
						{#each EVIDENCE_SEMANTICS as semantics (semantics)}
							<option value={semantics}>{semantics}</option>
						{/each}
					</select>
					<select
						class="input pattern-select"
						aria-label="Pattern haystack"
						value={pattern.haystack}
						onchange={(e) =>
							updatePattern(index, {
								haystack: (e.currentTarget as HTMLSelectElement).value as EditablePattern["haystack"],
							})}
					>
						{#each HAYSTACKS as haystack (haystack)}
							<option value={haystack}>{haystack}</option>
						{/each}
					</select>
					<Button
						type="button"
						variant="ghost"
						size="icon"
						class="h-6 w-6"
						aria-label="Move pattern up"
						disabled={index === 0}
						onclick={() => movePattern(index, -1)}
					>
						<ChevronUp size={14} />
					</Button>
					<Button
						type="button"
						variant="ghost"
						size="icon"
						class="h-6 w-6"
						aria-label="Move pattern down"
						disabled={index === draft.evidencePatterns.length - 1}
						onclick={() => movePattern(index, 1)}
					>
						<ChevronDown size={14} />
					</Button>
					<Button
						type="button"
						variant="ghost"
						size="icon"
						class="h-6 w-6 text-destructive hover:text-destructive"
						aria-label="Remove pattern"
						onclick={() => removePattern(index)}
					>
						<Trash2 size={14} />
					</Button>
				</div>
				<textarea
					class="pattern-textarea"
					aria-label="Pattern regex"
					placeholder="One regex per line (test_all: all must match)"
					spellcheck="false"
					value={pattern.pattern}
					oninput={(e) =>
						updatePattern(index, {
							pattern: (e.currentTarget as HTMLTextAreaElement).value,
						})}
				></textarea>
				{#if pattern.semantics === "capture_value" || pattern.semantics === "distinct_count"}
					<label class="capture-field">
						<span class="capture-label">Capture group</span>
						<input
							class="input capture-input"
							type="text"
							inputmode="numeric"
							aria-label="Capture group"
							placeholder="1-9"
							value={pattern.captureGroup}
							oninput={(e) =>
								updatePattern(index, {
									captureGroup: (e.currentTarget as HTMLInputElement).value,
								})}
						/>
					</label>
				{/if}
			</div>
		{/each}
		<div class="editor-actions">
			<Button type="button" variant="outline" size="sm" onclick={addPattern}>
				<Plus size={14} />
				Add pattern
			</Button>
		</div>
	</section>

	<!-- ── 3. Disallowed libraries ────────────────────────────────────── -->
	<section class="editor-section">
		<h3 class="section-title">Disallowed libraries</h3>
		<p class="section-hint">
			Comma-separated library names flagged in pre-analysis (e.g.
			<code>tensorflow, torch</code>). Leave empty for none.
		</p>
		<input
			class="input libs-input"
			type="text"
			aria-label="Disallowed libraries"
			placeholder="tensorflow, torch, keras"
			value={draft.disallowedLibraries}
			oninput={(e) => setDisallowedLibraries((e.currentTarget as HTMLInputElement).value)}
		/>
	</section>

	<!-- ── 4. Dimension guidance ──────────────────────────────────────── -->
	<section class="editor-section">
		<h3 class="section-title">Dimension guidance</h3>
		<p class="section-hint">
			Per-dimension Phase 2a guidance suffix text. {`{A} {B} {L}`} placeholders are
			substituted from the anchors at prompt time.
		</p>
		{#if guidanceDimensions.length === 0}
			<p class="section-empty">No dimension guidance yet — add a dimension below.</p>
		{/if}
		{#each guidanceDimensions as dim (dim)}
			<div class="guidance-block">
				<div class="guidance-head">
					<span class="guidance-key">{dim}</span>
					<Button
						type="button"
						variant="ghost"
						size="icon"
						class="h-6 w-6 text-destructive hover:text-destructive"
						aria-label="Remove dimension guidance"
						onclick={() => removeGuidance(dim)}
					>
						<Trash2 size={13} />
					</Button>
				</div>
				<textarea
					class="guidance-textarea"
					aria-label="Guidance for {dim}"
					value={draft.dimensionGuidance[dim] ?? ""}
					oninput={(e) =>
						setGuidance(dim, (e.currentTarget as HTMLTextAreaElement).value)}
				></textarea>
			</div>
		{/each}
		{#if addableDimensions.length > 0}
			<div class="editor-actions">
				<select
					class="input add-dimension-select"
					aria-label="Add dimension"
					value=""
					onchange={(e) => {
						const dim = (e.currentTarget as HTMLSelectElement).value;
						if (dim !== "") addGuidance(dim);
						(e.currentTarget as HTMLSelectElement).value = "";
					}}
				>
					<option value="" disabled>Add dimension…</option>
					{#each addableDimensions as dim (dim)}
						<option value={dim}>{dim}</option>
					{/each}
				</select>
			</div>
		{/if}
	</section>
</div>

<style>
	.scoring-editor {
		display: flex;
		flex-direction: column;
		gap: 18px;
	}
	.editor-section {
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 14px;
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: var(--card);
	}
	.section-title {
		margin: 0;
		font-size: 13px;
		font-weight: 600;
		color: var(--fg);
	}
	.section-hint {
		margin: 0;
		font-size: 12px;
		line-height: 1.5;
		color: var(--muted-foreground);
	}
	.section-hint code {
		font-family: var(--font-mono);
		font-size: 11.5px;
		background: color-mix(in oklch, var(--fg) 6%, transparent);
		padding: 1px 4px;
		border-radius: 4px;
	}
	.section-empty {
		margin: 0;
		padding: 12px;
		border: 1px dashed var(--border);
		border-radius: var(--radius-md);
		color: var(--muted-foreground);
		font-size: 12.5px;
	}
	.anchor-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
		gap: 10px;
	}
	.anchor-field {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.anchor-label {
		font-family: var(--font-mono);
		font-size: 11.5px;
		color: var(--muted-foreground);
	}
	.anchor-input {
		width: 100%;
	}
	.pattern-card {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 10px;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: color-mix(in oklch, var(--fg) 2%, transparent);
	}
	.pattern-head {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}
	.pattern-key-input {
		width: 190px;
		font-family: var(--font-mono);
		font-size: 12px;
	}
	.pattern-select {
		width: auto;
		min-width: 120px;
	}
	.pattern-textarea {
		width: 100%;
		min-height: 64px;
		padding: 8px 10px;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--background);
		color: var(--fg);
		font-family: var(--font-mono);
		font-size: 12px;
		line-height: 1.5;
		resize: vertical;
		tab-size: 2;
		transition: border-color 0.15s;
	}
	.pattern-textarea:focus {
		outline: none;
		border-color: var(--ring);
		box-shadow: 0 0 0 2px color-mix(in oklch, var(--ring) 25%, transparent);
	}
	.capture-field {
		display: inline-flex;
		align-items: center;
		gap: 8px;
	}
	.capture-label {
		font-size: 12px;
		color: var(--muted-foreground);
	}
	.capture-input {
		width: 70px;
	}
	.libs-input {
		width: 100%;
	}
	.guidance-block {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.guidance-head {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.guidance-key {
		font-family: var(--font-mono);
		font-size: 12px;
		font-weight: 500;
		color: var(--fg);
	}
	.guidance-textarea {
		width: 100%;
		min-height: 90px;
		padding: 8px 10px;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--background);
		color: var(--fg);
		font-size: 12.5px;
		line-height: 1.5;
		resize: vertical;
		transition: border-color 0.15s;
	}
	.guidance-textarea:focus {
		outline: none;
		border-color: var(--ring);
		box-shadow: 0 0 0 2px color-mix(in oklch, var(--ring) 25%, transparent);
	}
	.editor-actions {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.add-dimension-select {
		width: auto;
		min-width: 180px;
	}
	:global(.input) {
		height: 32px;
		padding: 0 10px;
		border: 1px solid var(--input);
		border-radius: var(--radius-md);
		background: var(--bg);
		color: var(--fg);
		font-size: 13px;
	}
	:global(.input:focus) {
		outline: none;
		border-color: var(--accent);
		box-shadow: 0 0 0 2px var(--accent-soft);
	}
</style>
