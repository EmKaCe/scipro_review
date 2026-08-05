<script lang="ts">
	/**
	 * @file Visual criteria editor — category / main-point / sub-point CRUD.
	 *
	 * Edits ONE assignment's own criteria file (never general.yaml). Loads
	 * from the API via the parent page, saves through PUT
	 * /api/assignments/[id]/criteria, and clears the rubric cache on success
	 * so review pages pick up the change immediately.
	 */
	import ChevronDown from "@lucide/svelte/icons/chevron-down";
	import ChevronUp from "@lucide/svelte/icons/chevron-up";
	import Plus from "@lucide/svelte/icons/plus";
	import Trash2 from "@lucide/svelte/icons/trash-2";

	import { saveCriteria } from "$lib/services/submissions-api.js";
	import { clearCache } from "$lib/services/criteria-loader.js";
	import { addToast } from "$lib/stores/toast.svelte.js";
	import type { CriteriaFile } from "$lib/types/criteria.js";

	// -----------------------------------------------------------------------
	// Editable shapes (Category is readonly — the editor works on mutable copies)
	// -----------------------------------------------------------------------

	interface EditableSubPoint {
		text: string;
		comment: boolean;
		point_deduction: boolean;
	}

	interface EditableMainPoint {
		main_point: string;
		sub_points: EditableSubPoint[];
	}

	interface EditableCategory {
		key: string;
		title: string;
		additional_notes: boolean;
		positive: EditableMainPoint[];
		neutral: EditableMainPoint[];
		negative: EditableMainPoint[];
	}

	interface Props {
		assignmentId: string;
		/** Existing criteria, or null when the assignment has no own file yet. */
		initial: CriteriaFile | null;
	}

	let { assignmentId, initial }: Props = $props();

	const SENTIMENTS = ["positive", "neutral", "negative"] as const;
	type Sentiment = (typeof SENTIMENTS)[number];

	// -----------------------------------------------------------------------
	// State
	// -----------------------------------------------------------------------

	let categories = $state<EditableCategory[]>([]);
	let busy = $state(false);
	let error = $state<string | null>(null);

	function emptySubPoint(): EditableSubPoint {
		return { text: "", comment: false, point_deduction: false };
	}

	function emptyMainPoint(): EditableMainPoint {
		return { main_point: "", sub_points: [] };
	}

	function emptyCategory(): EditableCategory {
		return {
			key: nextKey("new_category"),
			title: "New Category",
			additional_notes: true,
			positive: [],
			neutral: [],
			negative: [],
		};
	}

	function fromServer(categories: CriteriaFile["categories"]): EditableCategory[] {
		return Object.entries(categories).map(([key, category]) => ({
			key,
			title: category.title,
			additional_notes: category.additional_notes,
			positive: (category.positive ?? []).map(toEditableMainPoint),
			neutral: (category.neutral ?? []).map(toEditableMainPoint),
			negative: (category.negative ?? []).map(toEditableMainPoint),
		}));
	}

	function toEditableMainPoint(mp: {
		main_point: string;
		sub_points: readonly { text: string; comment?: boolean; point_deduction?: boolean }[];
	}): EditableMainPoint {
		return {
			main_point: mp.main_point,
			sub_points: mp.sub_points.map((sp) => ({
				text: sp.text,
				comment: sp.comment ?? false,
				point_deduction: sp.point_deduction ?? false,
			})),
		};
	}

	/** Next unique "new_category" key, e.g. new_category_2 when taken. */
	function nextKey(base: string): string {
		const taken = new Set(categories.map((c) => c.key));
		if (!taken.has(base)) return base;
		let i = 2;
		while (taken.has(`${base}_${i}`)) i++;
		return `${base}_${i}`;
	}

	// Rebuild the server shape from editor state (only truthy flags emitted).
	function toServerCategories(): Record<string, unknown> {
		const out: Record<string, unknown> = {};
		for (const category of categories) {
			out[category.key] = {
				title: category.title,
				additional_notes: category.additional_notes,
				positive: category.positive.map((mp) => toServerMainPoint(mp)),
				neutral: category.neutral.map((mp) => toServerMainPoint(mp)),
				negative: category.negative.map((mp) => toServerMainPoint(mp)),
			};
		}
		return out;
	}

	function toServerMainPoint(mp: EditableMainPoint): Record<string, unknown> {
		return {
			main_point: mp.main_point,
			sub_points: mp.sub_points.map((sp) => {
				const item: Record<string, unknown> = { text: sp.text };
				if (sp.comment) item.comment = true;
				if (sp.point_deduction) item.point_deduction = true;
				return item;
			}),
		};
	}

	// -----------------------------------------------------------------------
	// Category CRUD
	// -----------------------------------------------------------------------

	function addCategory() {
		categories = [...categories, emptyCategory()];
	}

	function removeCategory(index: number) {
		categories = categories.filter((_, i) => i !== index);
	}

	function moveCategory(index: number, dir: -1 | 1) {
		const target = index + dir;
		if (target < 0 || target >= categories.length) return;
		const next = [...categories];
		const [item] = next.splice(index, 1);
		next.splice(target, 0, item!);
		categories = next;
	}

	function renameCategoryKey(index: number, value: string) {
		const next = categories.map((c, i) => (i === index ? { ...c, key: value.trim() } : c));
		categories = next;
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
		categories = next;
	}

	function removeMainPoint(categoryIndex: number, sentiment: Sentiment, index: number) {
		const next = [...categories];
		next[categoryIndex] = {
			...next[categoryIndex]!,
			[sentiment]: next[categoryIndex]![sentiment].filter((_, i) => i !== index),
		};
		categories = next;
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
		categories = next;
	}

	function addSubPoint(categoryIndex: number, sentiment: Sentiment, mainPointIndex: number) {
		const next = [...categories];
		const mainPoints = [...next[categoryIndex]![sentiment]];
		mainPoints[mainPointIndex] = {
			...mainPoints[mainPointIndex]!,
			sub_points: [...mainPoints[mainPointIndex]!.sub_points, emptySubPoint()],
		};
		next[categoryIndex] = { ...next[categoryIndex]!, [sentiment]: mainPoints };
		categories = next;
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
		categories = next;
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
		categories = next;
	}

	// -----------------------------------------------------------------------
	// Validation + save
	// -----------------------------------------------------------------------

	let validationError = $state<string | null>(null);

	function validate(): string | null {
		if (categories.length === 0) return "Add at least one category before saving.";
		for (const category of categories) {
			if (!category.key) return "Every category needs a key.";
			if (!/^[a-z0-9_]+$/.test(category.key)) {
				return `Category key "${category.key}" must be snake_case (lowercase letters, digits, underscores).`;
			}
			if (!category.title.trim()) return `Category "${category.key}" needs a title.`;
			for (const sentiment of SENTIMENTS) {
				for (const [mpi, mp] of category[sentiment].entries()) {
					// main_point MAY be "" — the schema uses it for ungrouped
					// items (see criteria-schema.md). Only sub-points require text.
					for (const [spi, sp] of mp.sub_points.entries()) {
						if (!sp.text.trim()) {
							return `Category "${category.key}" has an empty sub-point (${sentiment}[${mpi + 1}][${spi + 1}]).`;
						}
					}
				}
			}
		}
		return null;
	}

	async function handleSave() {
		if (busy) return;
		validationError = null;
		error = null;

		const problem = validate();
		if (problem) {
			validationError = problem;
			return;
		}

		busy = true;
		try {
			const response = await saveCriteria(assignmentId, toServerCategories());
			clearCache();
			categories = fromServer(response.content.categories);
			addToast("success", `Criteria saved for ${assignmentId}`, 3000);
		} catch (e) {
			error = e instanceof Error ? e.message : "Failed to save criteria";
		} finally {
			busy = false;
		}
	}

	// Initialize from the loaded criteria (the parent passes it once on mount).
	$effect(() => {
		if (initial) categories = fromServer(initial.categories);
	});
</script>

<div class="criteria-editor">
	{#if validationError}
		<p class="editor-error" role="alert">{validationError}</p>
	{/if}
	{#if error}
		<p class="editor-error" role="alert">{error}</p>
	{/if}

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
						categories = next;
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
							categories = next;
						}}
					/>
					Notes
				</label>
				<div class="icon-group">
					<button
						type="button"
						class="icon-btn"
						aria-label="Move category up"
						disabled={categoryIndex === 0}
						onclick={() => moveCategory(categoryIndex, -1)}
					>
						<ChevronUp size={14} />
					</button>
					<button
						type="button"
						class="icon-btn"
						aria-label="Move category down"
						disabled={categoryIndex === categories.length - 1}
						onclick={() => moveCategory(categoryIndex, 1)}
					>
						<ChevronDown size={14} />
					</button>
					<button
						type="button"
						class="icon-btn icon-danger"
						aria-label="Remove category"
						onclick={() => removeCategory(categoryIndex)}
					>
						<Trash2 size={14} />
					</button>
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
									categories = next;
								}}
							/>
							<div class="icon-group">
								<button
									type="button"
									class="icon-btn"
									aria-label="Move main point up"
									disabled={mainPointIndex === 0}
									onclick={() =>
										moveMainPoint(categoryIndex, sentiment, mainPointIndex, -1)}
								>
									<ChevronUp size={13} />
								</button>
								<button
									type="button"
									class="icon-btn"
									aria-label="Move main point down"
									disabled={mainPointIndex === category[sentiment].length - 1}
									onclick={() =>
										moveMainPoint(categoryIndex, sentiment, mainPointIndex, 1)}
								>
									<ChevronDown size={13} />
								</button>
								<button
									type="button"
									class="icon-btn icon-danger"
									aria-label="Remove main point"
									onclick={() =>
										removeMainPoint(categoryIndex, sentiment, mainPointIndex)}
								>
									<Trash2 size={13} />
								</button>
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
												categories = next;
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
													categories = next;
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
													categories = next;
												}}
											/>
											Deduction
										</label>
										<div class="icon-group">
											<button
												type="button"
												class="icon-btn"
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
											</button>
											<button
												type="button"
												class="icon-btn"
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
											</button>
											<button
												type="button"
												class="icon-btn icon-danger"
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
											</button>
										</div>
									</div>
								{/each}
								<button
									type="button"
									class="btn-outline btn-xs"
									onclick={() =>
										addSubPoint(categoryIndex, sentiment, mainPointIndex)}
								>
									<Plus size={12} />
									Add sub-point
								</button>
							</div>
						</div>
					{/each}
					<button
						type="button"
						class="btn-outline btn-xs"
						onclick={() => addMainPoint(categoryIndex, sentiment)}
					>
						<Plus size={12} />
						Add {sentiment} main point
					</button>
				</div>
			{/each}
		</section>
	{/each}

	<div class="editor-actions">
		<button type="button" class="btn-outline" onclick={addCategory}>
			<Plus size={14} />
			Add category
		</button>
		<button type="button" class="btn-primary" disabled={busy} onclick={handleSave}>
			{busy ? "Saving…" : "Save criteria"}
		</button>
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
	.editor-error {
		margin: 0;
		padding: 9px 11px;
		border: 1px solid color-mix(in oklch, var(--destructive) 35%, transparent);
		border-radius: var(--radius-md);
		background: color-mix(in oklch, var(--destructive) 8%, transparent);
		color: var(--destructive);
		font-size: 12.5px;
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
	.icon-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 24px;
		height: 24px;
		border: none;
		border-radius: var(--radius);
		background: transparent;
		color: var(--muted-foreground);
		cursor: pointer;
		transition: background 0.15s;
	}
	.icon-btn:hover:not(:disabled) {
		background: color-mix(in oklch, var(--fg) 8%, transparent);
	}
	.icon-btn:disabled {
		opacity: 0.35;
		cursor: default;
	}
	.icon-danger {
		color: var(--destructive);
	}
	.editor-actions {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.btn-xs {
		padding: 4px 9px;
		font-size: 12px;
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
