<script lang="ts">
	/**
	 * @file Visual criteria editor — category / main-point / sub-point CRUD.
	 *
	 * Controlled component: the parent (criteria-editor-tabs) owns the draft
	 * and passes it down; every mutation reports back via `onChange`. Save,
	 * validation, raw-YAML and preview live in the parent wrapper.
	 */
	import ChevronDown from "@lucide/svelte/icons/chevron-down";
	import ChevronUp from "@lucide/svelte/icons/chevron-up";
	import Plus from "@lucide/svelte/icons/plus";
	import Trash2 from "@lucide/svelte/icons/trash-2";

	import { Button } from "$lib/components/ui/button/index.js";
	import {
		SENTIMENTS,
		type Sentiment,
		type EditableCategory,
		emptyCategory,
		emptyMainPoint,
		emptySubPoint,
	} from "./criteria-editor-model.js";

	interface Props {
		/** Current draft (owned by the parent tabs wrapper). */
		categories: EditableCategory[];
		/** Report a mutation; the parent replaces its draft with `next`. */
		onChange: (next: EditableCategory[]) => void;
	}

	let { categories, onChange }: Props = $props();

	// -----------------------------------------------------------------------
	// Category CRUD
	// -----------------------------------------------------------------------

	function addCategory() {
		onChange([...categories, emptyCategory(categories.map((c) => c.key))]);
	}

	function removeCategory(index: number) {
		onChange(categories.filter((_, i) => i !== index));
	}

	function moveCategory(index: number, dir: -1 | 1) {
		const target = index + dir;
		if (target < 0 || target >= categories.length) return;
		const next = [...categories];
		const [item] = next.splice(index, 1);
		next.splice(target, 0, item!);
		onChange(next);
	}

	function renameCategoryKey(index: number, value: string) {
		onChange(categories.map((c, i) => (i === index ? { ...c, key: value.trim() } : c)));
	}

	// -----------------------------------------------------------------------
	// Main-point / sub-point CRUD
	// -----------------------------------------------------------------------

	function addMainPoint(categoryIndex: number, sentiment: Sentiment) {
		const next = [...categories];
		next[categoryIndex] = {
			...next[categoryIndex]!,
			[sentiment]: [...next[categoryIndex]![sentiment], emptyMainPoint()],
		};
		onChange(next);
	}

	function removeMainPoint(categoryIndex: number, sentiment: Sentiment, index: number) {
		const next = [...categories];
		next[categoryIndex] = {
			...next[categoryIndex]!,
			[sentiment]: next[categoryIndex]![sentiment].filter((_, i) => i !== index),
		};
		onChange(next);
	}

	function moveMainPoint(
		categoryIndex: number,
		sentiment: Sentiment,
		index: number,
		dir: -1 | 1,
	) {
		const list = categories[categoryIndex]![sentiment];
		const target = index + dir;
		if (target < 0 || target >= list.length) return;
		const moved = [...list];
		const [item] = moved.splice(index, 1);
		moved.splice(target, 0, item!);
		const next = [...categories];
		next[categoryIndex] = { ...next[categoryIndex]!, [sentiment]: moved };
		onChange(next);
	}

	function addSubPoint(categoryIndex: number, sentiment: Sentiment, mainPointIndex: number) {
		const next = [...categories];
		const mainPoints = [...next[categoryIndex]![sentiment]];
		mainPoints[mainPointIndex] = {
			...mainPoints[mainPointIndex]!,
			sub_points: [...mainPoints[mainPointIndex]!.sub_points, emptySubPoint()],
		};
		next[categoryIndex] = { ...next[categoryIndex]!, [sentiment]: mainPoints };
		onChange(next);
	}

	function removeSubPoint(
		categoryIndex: number,
		sentiment: Sentiment,
		mainPointIndex: number,
		subPointIndex: number,
	) {
		const next = [...categories];
		const mainPoints = [...next[categoryIndex]![sentiment]];
		mainPoints[mainPointIndex] = {
			...mainPoints[mainPointIndex]!,
			sub_points: mainPoints[mainPointIndex]!.sub_points.filter(
				(_, i) => i !== subPointIndex,
			),
		};
		next[categoryIndex] = { ...next[categoryIndex]!, [sentiment]: mainPoints };
		onChange(next);
	}

	function moveSubPoint(
		categoryIndex: number,
		sentiment: Sentiment,
		mainPointIndex: number,
		subPointIndex: number,
		dir: -1 | 1,
	) {
		const next = [...categories];
		const mainPoints = [...next[categoryIndex]![sentiment]];
		const subPoints = [...mainPoints[mainPointIndex]!.sub_points];
		const target = subPointIndex + dir;
		if (target < 0 || target >= subPoints.length) return;
		const [item] = subPoints.splice(subPointIndex, 1);
		subPoints.splice(target, 0, item!);
		mainPoints[mainPointIndex] = { ...mainPoints[mainPointIndex]!, sub_points: subPoints };
		next[categoryIndex] = { ...next[categoryIndex]!, [sentiment]: mainPoints };
		onChange(next);
	}
</script>

<div class="criteria-editor">
	{#if categories.length === 0}
		<p class="editor-empty">
			No assignment-specific criteria yet — add your first category below. General categories
			apply automatically to every assignment.
		</p>
	{/if}

	{#each categories as category, categoryIndex (category.key)}
		<section class="category-card">
			<div class="category-head">
				<input
					class="input key-input"
					aria-label="Category key"
					value={category.key}
					oninput={(e) =>
						renameCategoryKey(
							categoryIndex,
							(e.currentTarget as HTMLInputElement).value,
						)}
				/>
				<input
					class="input title-input"
					aria-label="Category title"
					value={category.title}
					oninput={(e) => {
						const next = [...categories];
						next[categoryIndex] = {
							...next[categoryIndex]!,
							title: (e.currentTarget as HTMLInputElement).value,
						};
						onChange(next);
					}}
				/>
				<label class="check-label">
					<input
						type="checkbox"
						checked={category.additional_notes}
						onchange={(e) => {
							const next = [...categories];
							next[categoryIndex] = {
								...next[categoryIndex]!,
								additional_notes: (e.currentTarget as HTMLInputElement).checked,
							};
							onChange(next);
						}}
					/>
					Notes
				</label>
				<div class="icon-group">
					<Button
						type="button"
						variant="ghost"
						size="icon"
						class="h-6 w-6"
						aria-label="Move category up"
						disabled={categoryIndex === 0}
						onclick={() => moveCategory(categoryIndex, -1)}
					>
						<ChevronUp size={14} />
					</Button>
					<Button
						type="button"
						variant="ghost"
						size="icon"
						class="h-6 w-6"
						aria-label="Move category down"
						disabled={categoryIndex === categories.length - 1}
						onclick={() => moveCategory(categoryIndex, 1)}
					>
						<ChevronDown size={14} />
					</Button>
					<Button
						type="button"
						variant="ghost"
						size="icon"
						class="h-6 w-6 text-destructive hover:text-destructive"
						aria-label="Remove category"
						onclick={() => removeCategory(categoryIndex)}
					>
						<Trash2 size={14} />
					</Button>
				</div>
			</div>

			{#each SENTIMENTS as sentiment (sentiment)}
				<div class="sentiment-block">
					<h4 class="sentiment-title">{sentiment}</h4>
					{#each category[sentiment] as mainPoint, mainPointIndex (mainPointIndex)}
						<div class="main-point">
							<input
								class="input mp-input"
								aria-label="Main point heading"
								placeholder="Main point heading"
								value={mainPoint.main_point}
								oninput={(e) => {
									const next = [...categories];
									const mainPoints = [...next[categoryIndex]![sentiment]];
									mainPoints[mainPointIndex] = {
										...mainPoints[mainPointIndex]!,
										main_point: (e.currentTarget as HTMLInputElement).value,
									};
									next[categoryIndex] = {
										...next[categoryIndex]!,
										[sentiment]: mainPoints,
									};
									onChange(next);
								}}
							/>
							<div class="icon-group">
								<Button
									type="button"
									variant="ghost"
									size="icon"
									class="h-6 w-6"
									aria-label="Move main point up"
									disabled={mainPointIndex === 0}
									onclick={() =>
										moveMainPoint(categoryIndex, sentiment, mainPointIndex, -1)}
								>
									<ChevronUp size={13} />
								</Button>
								<Button
									type="button"
									variant="ghost"
									size="icon"
									class="h-6 w-6"
									aria-label="Move main point down"
									disabled={mainPointIndex === category[sentiment].length - 1}
									onclick={() =>
										moveMainPoint(categoryIndex, sentiment, mainPointIndex, 1)}
								>
									<ChevronDown size={13} />
								</Button>
								<Button
									type="button"
									variant="ghost"
									size="icon"
									class="h-6 w-6 text-destructive hover:text-destructive"
									aria-label="Remove main point"
									onclick={() =>
										removeMainPoint(categoryIndex, sentiment, mainPointIndex)}
								>
									<Trash2 size={13} />
								</Button>
							</div>

							<div class="sub-points">
								{#each mainPoint.sub_points as subPoint, subPointIndex (subPointIndex)}
									<div class="sub-point">
										<input
											class="input sp-input"
											aria-label="Sub-point text"
											placeholder="Sub-point text"
											value={subPoint.text}
											oninput={(e) => {
												const next = [...categories];
												const mainPoints = [
													...next[categoryIndex]![sentiment],
												];
												const subPoints = [
													...mainPoints[mainPointIndex]!.sub_points,
												];
												subPoints[subPointIndex] = {
													...subPoints[subPointIndex]!,
													text: (e.currentTarget as HTMLInputElement)
														.value,
												};
												mainPoints[mainPointIndex] = {
													...mainPoints[mainPointIndex]!,
													sub_points: subPoints,
												};
												next[categoryIndex] = {
													...next[categoryIndex]!,
													[sentiment]: mainPoints,
												};
												onChange(next);
											}}
										/>
										<label class="check-label">
											<input
												type="checkbox"
												checked={subPoint.comment}
												onchange={(e) => {
													const next = [...categories];
													const mainPoints = [
														...next[categoryIndex]![sentiment],
													];
													const subPoints = [
														...mainPoints[mainPointIndex]!.sub_points,
													];
													subPoints[subPointIndex] = {
														...subPoints[subPointIndex]!,
														comment: (
															e.currentTarget as HTMLInputElement
														).checked,
													};
													mainPoints[mainPointIndex] = {
														...mainPoints[mainPointIndex]!,
														sub_points: subPoints,
													};
													next[categoryIndex] = {
														...next[categoryIndex]!,
														[sentiment]: mainPoints,
													};
													onChange(next);
												}}
											/>
											Comment
										</label>
										<label class="check-label">
											<input
												type="checkbox"
												checked={subPoint.point_deduction}
												onchange={(e) => {
													const next = [...categories];
													const mainPoints = [
														...next[categoryIndex]![sentiment],
													];
													const subPoints = [
														...mainPoints[mainPointIndex]!.sub_points,
													];
													subPoints[subPointIndex] = {
														...subPoints[subPointIndex]!,
														point_deduction: (
															e.currentTarget as HTMLInputElement
														).checked,
													};
													mainPoints[mainPointIndex] = {
														...mainPoints[mainPointIndex]!,
														sub_points: subPoints,
													};
													next[categoryIndex] = {
														...next[categoryIndex]!,
														[sentiment]: mainPoints,
													};
													onChange(next);
												}}
											/>
											Deduction
										</label>
										<div class="icon-group">
											<Button
												type="button"
												variant="ghost"
												size="icon"
												class="h-6 w-6"
												aria-label="Move sub-point up"
												disabled={subPointIndex === 0}
												onclick={() =>
													moveSubPoint(
														categoryIndex,
														sentiment,
														mainPointIndex,
														subPointIndex,
														-1,
													)}
											>
												<ChevronUp size={12} />
											</Button>
											<Button
												type="button"
												variant="ghost"
												size="icon"
												class="h-6 w-6"
												aria-label="Move sub-point down"
												disabled={subPointIndex ===
													mainPoint.sub_points.length - 1}
												onclick={() =>
													moveSubPoint(
														categoryIndex,
														sentiment,
														mainPointIndex,
														subPointIndex,
														1,
													)}
											>
												<ChevronDown size={12} />
											</Button>
											<Button
												type="button"
												variant="ghost"
												size="icon"
												class="h-6 w-6 text-destructive hover:text-destructive"
												aria-label="Remove sub-point"
												onclick={() =>
													removeSubPoint(
														categoryIndex,
														sentiment,
														mainPointIndex,
														subPointIndex,
													)}
											>
												<Trash2 size={12} />
											</Button>
										</div>
									</div>
								{/each}
								<Button
									type="button"
									variant="outline"
									size="xs"
									onclick={() =>
										addSubPoint(categoryIndex, sentiment, mainPointIndex)}
								>
									<Plus size={12} />
									Add sub-point
								</Button>
							</div>
						</div>
					{/each}
					<Button
						type="button"
						variant="outline"
						size="xs"
						onclick={() => addMainPoint(categoryIndex, sentiment)}
					>
						<Plus size={12} />
						Add {sentiment} main point
					</Button>
				</div>
			{/each}
		</section>
	{/each}

	<div class="editor-actions">
		<Button type="button" variant="outline" size="sm" onclick={addCategory}>
			<Plus size={14} />
			Add category
		</Button>
	</div>
</div>

<style>
	.criteria-editor {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}
	.editor-empty {
		margin: 0;
		padding: 16px;
		border: 1px dashed var(--border);
		border-radius: var(--radius-md);
		color: var(--muted-foreground);
		font-size: 13px;
	}
	.category-card {
		display: flex;
		flex-direction: column;
		gap: 12px;
		padding: 14px;
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: var(--card);
	}
	.category-head {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}
	.key-input {
		width: 190px;
		font-family: var(--font-mono);
		font-size: 12px;
	}
	.title-input {
		flex: 1;
		min-width: 200px;
		font-weight: 600;
	}
	.check-label {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-size: 12px;
		color: var(--muted-foreground);
		cursor: pointer;
	}
	.sentiment-block {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding-left: 8px;
		border-left: 2px solid var(--border);
	}
	.sentiment-title {
		margin: 0;
		font-size: 11px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--muted-foreground);
	}
	.main-point {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 8px;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: color-mix(in oklch, var(--fg) 2%, transparent);
	}
	.mp-input {
		font-weight: 500;
	}
	.sub-points {
		display: flex;
		flex-direction: column;
		gap: 6px;
		margin-left: 10px;
	}
	.sub-point {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}
	.sp-input {
		flex: 1;
		min-width: 180px;
	}
	.icon-group {
		display: inline-flex;
		align-items: center;
		gap: 2px;
	}
	.editor-actions {
		display: flex;
		align-items: center;
		gap: 10px;
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
