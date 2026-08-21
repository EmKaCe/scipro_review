<script lang="ts">
	/**
	 * @file Read-only scoring-config preview — anchors table, evidence
	 * pattern list, disallowed libraries, dimension guidance text blocks.
	 *
	 * Renders the same draft shape the visual editor edits, so the preview
	 * always reflects the current draft (including raw-YAML edits).
	 */
	import { ANCHOR_KEYS, type EditableScoringConfig } from "./scoring-editor-model.js";

	interface Props {
		/** Draft scoring config to preview. */
		draft: EditableScoringConfig;
	}

	let { draft }: Props = $props();

	const anchorEntries = $derived(
		ANCHOR_KEYS.filter((key) => (draft.anchors[key] ?? "").trim() !== "").map((key) => ({
			key,
			value: draft.anchors[key]!,
		})),
	);

	const libraryList = $derived(
		draft.disallowedLibraries
			.split(",")
			.map((lib) => lib.trim())
			.filter((lib) => lib.length > 0),
	);

	const allowedLibraryList = $derived(
		draft.allowedLibraries
			.split(",")
			.map((lib) => lib.trim())
			.filter((lib) => lib.length > 0),
	);

	const guidanceEntries = $derived(Object.entries(draft.dimensionGuidance));
</script>

<div class="scoring-preview">
	{#if anchorEntries.length === 0 && draft.evidencePatterns.length === 0 && libraryList.length === 0 && guidanceEntries.length === 0}
		<p class="preview-empty">
			Nothing to preview yet — add anchors, patterns, libraries or guidance in the Visual
			Editor, or paste YAML in the Raw YAML tab.
		</p>
	{:else}
		<!-- ── Anchors ─────────────────────────────────────────────────── -->
		{#if anchorEntries.length > 0}
			<section class="preview-section">
				<h3 class="preview-title">Calibration anchors</h3>
				<table class="anchors-table" aria-label="Calibration anchors">
					<tbody>
						{#each anchorEntries as entry (entry.key)}
							<tr>
								<th scope="row" class="anchor-key">{entry.key}</th>
								<td class="anchor-value">{entry.value}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</section>
		{/if}

		<!-- ── Evidence patterns ───────────────────────────────────────── -->
		{#if draft.evidencePatterns.length > 0}
			<section class="preview-section">
				<h3 class="preview-title">Evidence patterns</h3>
				<ul class="pattern-list">
					{#each draft.evidencePatterns as pattern (pattern.key)}
						<li class="pattern-item">
							<div class="pattern-meta">
								<span class="pattern-key">{pattern.key}</span>
								<span class="pattern-chip">{pattern.semantics}</span>
								<span class="pattern-chip">{pattern.haystack}</span>
								{#if pattern.captureGroup.trim() !== ""}
									<span class="pattern-chip"
										>capture group {pattern.captureGroup}</span
									>
								{/if}
							</div>
							<pre class="pattern-regex">{pattern.pattern}</pre>
						</li>
					{/each}
				</ul>
			</section>
		{/if}

		<!-- ── Disallowed libraries ────────────────────────────────────── -->
		{#if libraryList.length > 0}
			<section class="preview-section">
				<h3 class="preview-title">Disallowed libraries</h3>
				<div class="lib-list">
					{#each libraryList as lib (lib)}
						<span class="lib-chip">{lib}</span>
					{/each}
				</div>
			</section>
		{/if}

		<!-- ── Allowed libraries (Pass 3 import allow-list) ────────────── -->
		{#if allowedLibraryList.length > 0}
			<section class="preview-section">
				<h3 class="preview-title">Allowed libraries</h3>
				<div class="lib-list">
					{#each allowedLibraryList as lib (lib)}
						<span class="lib-chip">{lib}</span>
					{/each}
				</div>
			</section>
		{/if}

		<!-- ── Dimension guidance ──────────────────────────────────────── -->
		{#if guidanceEntries.length > 0}
			<section class="preview-section">
				<h3 class="preview-title">Dimension guidance</h3>
				{#each guidanceEntries as [dim, text] (dim)}
					<div class="guidance-block">
						<h4 class="guidance-key">{dim}</h4>
						<p class="guidance-text">{text}</p>
					</div>
				{/each}
			</section>
		{/if}
	{/if}
</div>

<style>
	.scoring-preview {
		display: flex;
		flex-direction: column;
		gap: 16px;
	}
	.preview-empty {
		margin: 0;
		padding: 20px;
		border: 1px dashed var(--border);
		border-radius: var(--radius-md);
		color: var(--muted-foreground);
		font-size: 13px;
		text-align: center;
	}
	.preview-section {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 14px;
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: var(--card);
	}
	.preview-title {
		margin: 0;
		font-size: 12px;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--muted-foreground);
	}
	.anchors-table {
		border-collapse: collapse;
		width: 100%;
		max-width: 420px;
	}
	.anchors-table th,
	.anchors-table td {
		padding: 5px 10px;
		border-bottom: 1px solid var(--border);
		text-align: left;
		font-size: 13px;
	}
	.anchors-table tr:last-child th,
	.anchors-table tr:last-child td {
		border-bottom: none;
	}
	.anchor-key {
		font-family: var(--font-mono);
		font-size: 12px;
		font-weight: 500;
		color: var(--muted-foreground);
		width: 90px;
	}
	.anchor-value {
		font-family: var(--font-mono);
		font-size: 12.5px;
		color: var(--fg);
	}
	.pattern-list {
		display: flex;
		flex-direction: column;
		gap: 10px;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.pattern-item {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 10px;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: color-mix(in oklch, var(--fg) 2%, transparent);
	}
	.pattern-meta {
		display: flex;
		align-items: center;
		gap: 6px;
		flex-wrap: wrap;
	}
	.pattern-key {
		font-family: var(--font-mono);
		font-size: 12px;
		font-weight: 600;
		color: var(--fg);
	}
	.pattern-chip {
		padding: 1px 7px;
		border-radius: 999px;
		background: color-mix(in oklch, var(--accent) 12%, transparent);
		color: var(--accent-foreground);
		font-size: 10.5px;
		font-weight: 500;
	}
	.pattern-regex {
		margin: 0;
		padding: 8px 10px;
		border-radius: var(--radius);
		background: var(--background);
		color: var(--fg);
		font-family: var(--font-mono);
		font-size: 11.5px;
		line-height: 1.5;
		white-space: pre-wrap;
		word-break: break-all;
	}
	.lib-list {
		display: flex;
		align-items: center;
		gap: 6px;
		flex-wrap: wrap;
	}
	.lib-chip {
		padding: 2px 9px;
		border: 1px solid var(--border);
		border-radius: 999px;
		background: var(--background);
		color: var(--fg);
		font-family: var(--font-mono);
		font-size: 11.5px;
	}
	.guidance-block {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.guidance-key {
		margin: 0;
		font-family: var(--font-mono);
		font-size: 12px;
		font-weight: 600;
		color: var(--fg);
	}
	.guidance-text {
		margin: 0;
		font-size: 12.5px;
		line-height: 1.55;
		color: var(--fg);
		white-space: pre-wrap;
	}
</style>
