<script lang="ts">
	/**
	 * @file Read-only rubric preview — how the criteria will look to the
	 * grader in the rubric checklist (sentiment sections, main points,
	 * sub-point items, comment/deduction flags, category notes).
	 *
	 * Mirrors rubric-section/rubric-item visual language; all checkboxes are
	 * static squares so it reads as a preview, not an editor.
	 */
	import ChevronDown from "@lucide/svelte/icons/chevron-down";
	import MessageSquareText from "@lucide/svelte/icons/message-square-text";
	import MinusCircle from "@lucide/svelte/icons/minus-circle";
	import NotebookPen from "@lucide/svelte/icons/notebook-pen";
	import { SENTIMENTS, type EditableCategory, type Sentiment } from "./criteria-editor-model.js";

	interface Props {
		/** Draft categories to preview (same shape the visual editor edits). */
		categories: EditableCategory[];
	}

	let { categories }: Props = $props();

	let expanded = $state<Record<string, boolean>>({});

	function isExpanded(category: EditableCategory): boolean {
		return expanded[category.key] ?? true; // preview starts expanded
	}

	const sentimentStyle = $derived.by(() => {
		const map: Record<Sentiment, string> = {
			positive: "var(--success)",
			neutral: "var(--border)",
			negative: "var(--destructive)",
		};
		return map;
	});

	const sentimentLabel: Record<Sentiment, string> = {
		positive: "Positive",
		neutral: "Neutral",
		negative: "Negative",
	};

	let stats = $derived.by(() => {
		let items = 0;
		let comments = 0;
		let deductions = 0;
		for (const category of categories) {
			for (const sentiment of SENTIMENTS) {
				for (const mp of category[sentiment]) {
					for (const sp of mp.sub_points) {
						items++;
						if (sp.comment) comments++;
						if (sp.point_deduction) deductions++;
					}
				}
			}
		}
		return { items, comments, deductions };
	});
</script>

<div class="criteria-preview">
	{#if categories.length === 0}
		<p class="preview-empty">
			Nothing to preview yet — add a category in the Visual Editor, or paste YAML in the Raw
			YAML tab.
		</p>
	{:else}
		<div class="preview-stats" aria-label="Preview summary">
			<span class="stat-chip"
				>{categories.length} categor{categories.length === 1 ? "y" : "ies"}</span
			>
			<span class="stat-chip">{stats.items} item{stats.items === 1 ? "" : "s"}</span>
			{#if stats.comments > 0}
				<span class="stat-chip stat-chip-comment">
					<MessageSquareText size={12} />
					{stats.comments} with comment
				</span>
			{/if}
			{#if stats.deductions > 0}
				<span class="stat-chip stat-chip-deduction">
					<MinusCircle size={12} />
					{stats.deductions} with deduction
				</span>
			{/if}
		</div>

		{#each categories as category (category.key)}
			{@const open = isExpanded(category)}
			<section class="preview-category" class:collapsed={!open}>
				<button
					type="button"
					class="preview-category-head"
					aria-expanded={open}
					onclick={() => (expanded[category.key] = !open)}
				>
					<span class="preview-key">{category.key}</span>
					<span class="preview-title">{category.title || "(untitled)"}</span>
					{#if category.additional_notes}
						<span class="preview-notes-badge" title="Notes field enabled">
							<NotebookPen size={12} />
							Notes
						</span>
					{/if}
					<span class="preview-chevron {open ? 'rotated' : ''}">
						<ChevronDown size={14} />
					</span>
				</button>
				{#if open}
					<div class="preview-body">
						{#each SENTIMENTS as sentiment (sentiment)}
							{@const points = category[sentiment]}
							{#if points.length > 0}
								<div class="preview-section">
									<h4
										class="preview-sentiment-label"
										style="border-color: {sentimentStyle[sentiment]}"
									>
										{sentimentLabel[sentiment]}
									</h4>
									<div
										class="preview-sentiment-body"
										style="border-color: {sentimentStyle[sentiment]}"
									>
										{#each points as mp, mpIndex (mpIndex)}
											<div class="preview-main-point">
												{#if mp.main_point}
													<p class="preview-main-point-label">
														{mp.main_point}
													</p>
												{/if}
												<ul class="preview-items">
													{#each mp.sub_points as sp, spIndex (spIndex)}
														<li class="preview-item">
															<span
																class="preview-checkbox"
																aria-hidden="true"
															></span>
															<span class="preview-item-text"
																>{sp.text}</span
															>
															{#if sp.comment}
																<span
																	class="preview-flag preview-flag-comment"
																	title="Reveals a comment box when checked"
																>
																	<MessageSquareText size={11} />
																	comment
																</span>
															{/if}
															{#if sp.point_deduction}
																<span
																	class="preview-flag preview-flag-deduction"
																	title="Reveals a deduction input when checked"
																>
																	<MinusCircle size={11} />
																	deduction
																</span>
															{/if}
														</li>
													{/each}
												</ul>
											</div>
										{/each}
									</div>
								</div>
							{/if}
						{/each}
					</div>
				{/if}
			</section>
		{/each}
	{/if}
</div>

<style>
	.criteria-preview {
		display: flex;
		flex-direction: column;
		gap: 12px;
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
	.preview-stats {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}
	.stat-chip {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		padding: 4px 10px;
		border: 1px solid var(--border);
		border-radius: 999px;
		background: var(--card);
		color: var(--muted-foreground);
		font-size: 12px;
		font-weight: 500;
	}
	.stat-chip-comment {
		color: var(--info);
		border-color: color-mix(in oklch, var(--info) 35%, var(--border));
	}
	.stat-chip-deduction {
		color: var(--destructive);
		border-color: color-mix(in oklch, var(--destructive) 35%, var(--border));
	}
	.preview-category {
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: var(--card);
		overflow: hidden;
	}
	.preview-category-head {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		padding: 10px 14px;
		border: none;
		background: transparent;
		color: var(--fg);
		cursor: pointer;
		text-align: left;
	}
	.preview-category-head:hover {
		background: color-mix(in oklch, var(--fg) 3%, transparent);
	}
	.preview-key {
		font-family: var(--font-mono);
		font-size: 12px;
		color: var(--muted-foreground);
	}
	.preview-title {
		flex: 1;
		font-weight: 600;
		font-size: 13.5px;
	}
	.preview-notes-badge {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 2px 8px;
		border-radius: 999px;
		background: color-mix(in oklch, var(--accent) 12%, transparent);
		color: var(--accent-foreground);
		font-size: 11px;
		font-weight: 500;
	}
	.preview-chevron {
		transition: transform 0.15s;
		color: var(--muted-foreground);
	}
	.preview-chevron.rotated {
		transform: rotate(180deg);
	}
	.preview-body {
		display: flex;
		flex-direction: column;
		gap: 14px;
		padding: 4px 14px 14px;
	}
	.preview-section {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.preview-sentiment-label {
		margin: 0;
		padding-left: 8px;
		border-left: 2px solid;
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--muted-foreground);
	}
	.preview-sentiment-body {
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding-left: 10px;
		border-left: 2px solid;
	}
	.preview-main-point {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.preview-main-point-label {
		margin: 0;
		font-size: 12.5px;
		font-weight: 600;
		color: var(--fg);
	}
	.preview-items {
		display: flex;
		flex-direction: column;
		gap: 6px;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.preview-item {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		font-size: 13px;
		line-height: 1.45;
		color: var(--fg);
	}
	.preview-checkbox {
		width: 15px;
		height: 15px;
		margin-top: 1px;
		flex-shrink: 0;
		border: 1px solid var(--border);
		border-radius: 4px;
		background: var(--background);
	}
	.preview-item-text {
		flex: 1;
	}
	.preview-flag {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		margin-top: 1px;
		padding: 1px 6px;
		border-radius: 999px;
		font-size: 10.5px;
		font-weight: 500;
		white-space: nowrap;
	}
	.preview-flag-comment {
		background: color-mix(in oklch, var(--info) 10%, transparent);
		color: var(--info);
	}
	.preview-flag-deduction {
		background: color-mix(in oklch, var(--destructive) 10%, transparent);
		color: var(--destructive);
	}
</style>
