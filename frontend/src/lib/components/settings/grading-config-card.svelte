<script lang="ts">
	/**
	 * @file Settings card — edit the APPLICATION-level grading configuration
	 * (data/grading_config.yaml): global dimensions (title / max_points /
	 * weight) and grade boundaries. Saves via PUT /api/config/grading, which
	 * validates (server/grading-validation.ts), no-op guards, and writes
	 * atomically — mirroring the ExecutionAiCard + P7 write discipline.
	 *
	 * Scope per the app-vs-assignment separation: this is the GLOBAL grading
	 * config shared across assignments. Per-assignment criteria and scoring
	 * live in the assignment editor, NOT here.
	 */
	import Loader from "@lucide/svelte/icons/loader";
	import Plus from "@lucide/svelte/icons/plus";
	import Save from "@lucide/svelte/icons/save";
	import Trash2 from "@lucide/svelte/icons/trash-2";
	import Info from "@lucide/svelte/icons/info";
	import { addToast } from "$lib/stores/toast.svelte.js";
	import { fetchGradingConfig, saveGradingConfig } from "$lib/services/grading-config.js";
	import { parseDimensionKey } from "$lib/types/grading.js";

	interface EditableDimension {
		key: string;
		title: string;
		maxPoints: number;
		weight: number;
	}

	interface EditableBoundary {
		minPercentage: number;
		grade: number;
		label: string;
		usEquiv: string;
	}

	interface GradingDraft {
		dimensions: EditableDimension[];
		grade_boundaries: EditableBoundary[];
	}

	let loading = $state(true);
	let saving = $state(false);
	let form = $state<GradingDraft | null>(null);
	let loadError = $state<string | null>(null);
	let validationError = $state<string | null>(null);
	let savedAt = $state<string | null>(null);

	$effect(() => {
		void (async () => {
			try {
				const config = await fetchGradingConfig();
				form = {
					dimensions: config.dimensions.map((d) => ({
						key: d.key,
						title: d.title,
						maxPoints: d.max_points,
						weight: d.weight,
					})),
					grade_boundaries: config.grade_boundaries.map((b) => ({
						minPercentage: b.min_percentage,
						grade: b.grade,
						label: b.label,
						usEquiv: b.us_equiv,
					})),
				};
				loadError = null;
			} catch (e) {
				loadError = e instanceof Error ? e.message : "Failed to load grading config";
			} finally {
				loading = false;
			}
		})();
	});

	/** Client-side pre-save validation (the server runs the authoritative
	 * validateGradingConfig guard too). Returns an error message or null. */
	function validateDraft(draft: GradingDraft): string | null {
		if (draft.dimensions.length === 0) {
			return "Add at least one dimension.";
		}
		for (const dim of draft.dimensions) {
			if (dim.key.trim() === "") return "Every dimension needs a key.";
			if (dim.title.trim() === "") return `Dimension '${dim.key}' needs a title.`;
			if (!Number.isFinite(dim.maxPoints) || dim.maxPoints <= 0)
				return `Dimension '${dim.key}' needs a positive max points value.`;
			if (!Number.isFinite(dim.weight) || dim.weight <= 0)
				return `Dimension '${dim.key}' needs a positive weight.`;
		}
		if (draft.grade_boundaries.length === 0) {
			return "Add at least one grade boundary.";
		}
		for (const b of draft.grade_boundaries) {
			if (!Number.isFinite(b.minPercentage) || b.minPercentage < 0 || b.minPercentage > 100)
				return "Each grade boundary needs a min percentage in 0–100.";
			if (!Number.isFinite(b.grade)) return "Each grade boundary needs a grade.";
			if (b.label.trim() === "") return "Each grade boundary needs a label.";
			if (b.usEquiv.trim() === "") return "Each grade boundary needs a US equivalent.";
		}
		return null;
	}

	function addDimension() {
		if (!form) return;
		form = {
			...form,
			dimensions: [...form.dimensions, { key: "", title: "", maxPoints: 1, weight: 1 }],
		};
	}

	function removeDimension(index: number) {
		if (!form) return;
		form = {
			...form,
			dimensions: form.dimensions.filter((_, i) => i !== index),
		};
	}

	function addBoundary() {
		if (!form) return;
		form = {
			...form,
			grade_boundaries: [
				...form.grade_boundaries,
				{ minPercentage: 0, grade: 5, label: "", usEquiv: "" },
			],
		};
	}

	function removeBoundary(index: number) {
		if (!form) return;
		form = {
			...form,
			grade_boundaries: form.grade_boundaries.filter((_, i) => i !== index),
		};
	}

	async function handleSave() {
		if (!form || saving) return;
		const err = validateDraft(form);
		validationError = err;
		if (err) {
			addToast("error", err, 4000);
			return;
		}
		saving = true;
		try {
			const saved = await saveGradingConfig({
				dimensions: form.dimensions.map((d) => ({
					key: parseDimensionKey(d.key),
					title: d.title,
					max_points: d.maxPoints,
					weight: d.weight,
				})),
				grade_boundaries: form.grade_boundaries.map((b) => ({
					min_percentage: b.minPercentage,
					grade: b.grade,
					label: b.label,
					us_equiv: b.usEquiv,
				})),
			});
			// Re-normalize the draft from the saved (sorted) response.
			form = {
				dimensions: saved.dimensions.map((d) => ({
					key: d.key,
					title: d.title,
					maxPoints: d.max_points,
					weight: d.weight,
				})),
				grade_boundaries: saved.grade_boundaries.map((b) => ({
					minPercentage: b.min_percentage,
					grade: b.grade,
					label: b.label,
					usEquiv: b.us_equiv,
				})),
			};
			validationError = null;
			savedAt = new Date().toLocaleTimeString();
			addToast("success", "Grading config saved", 3000);
		} catch (e) {
			addToast(
				"error",
				e instanceof Error ? e.message : "Failed to save grading config",
				4000,
			);
		} finally {
			saving = false;
		}
	}
</script>

<div class="overflow-hidden rounded-[var(--radius)] border border-border bg-card shadow-sm">
	<div class="p-5 pb-3">
		<h2 class="text-base font-semibold tracking-tight">Grading</h2>
		<p class="mt-1 text-sm text-muted-foreground">
			Global grading dimensions and grade boundaries. Saved to data/grading_config.yaml on the
			server.
		</p>
	</div>

	{#if loading}
		<div class="flex items-center gap-2 px-5 pb-5 text-sm text-muted-foreground">
			<Loader size={14} class="animate-spin" /> Loading grading config…
		</div>
	{:else if loadError || !form}
		<div class="px-5 pb-5">
			<p class="text-sm text-error">{loadError ?? "Grading config unavailable"}</p>
		</div>
	{:else}
		<div class="space-y-5 px-5 pb-5">
			<!-- Dimensions -->
			<div>
				<h3
					class="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase"
				>
					Dimensions
				</h3>
				{#each form.dimensions as dim, index (dim.key || index)}
					<div
						class="mb-2 rounded-[var(--radius)] border border-border bg-background p-3"
					>
						<div class="grid grid-cols-1 gap-3 sm:grid-cols-12">
							<label class="block sm:col-span-3">
								<span class="mb-1 block text-xs text-muted-foreground">Key</span>
								<input
									type="text"
									placeholder="snake_case"
									class="h-9 w-full rounded-[var(--radius)] border border-border bg-muted px-2 font-mono text-sm text-foreground"
									bind:value={dim.key}
								/>
							</label>
							<label class="block sm:col-span-5">
								<span class="mb-1 block text-xs text-muted-foreground">Title</span>
								<input
									type="text"
									class="h-9 w-full rounded-[var(--radius)] border border-border bg-background px-2 text-sm text-foreground"
									bind:value={dim.title}
								/>
							</label>
							<label class="block sm:col-span-2">
								<span class="mb-1 block text-xs text-muted-foreground"
									>Max points</span
								>
								<input
									type="number"
									min="0.5"
									step="0.5"
									class="h-9 w-full rounded-[var(--radius)] border border-border bg-background px-2 text-sm text-foreground"
									bind:value={dim.maxPoints}
								/>
							</label>
							<label class="block sm:col-span-1">
								<span class="mb-1 block text-xs text-muted-foreground">Weight</span>
								<input
									type="number"
									min="0.1"
									step="0.1"
									class="h-9 w-full rounded-[var(--radius)] border border-border bg-background px-2 text-sm text-foreground"
									bind:value={dim.weight}
								/>
							</label>
							<div class="flex items-end justify-end sm:col-span-1">
								<button
									type="button"
									aria-label="Remove dimension {dim.key || index}"
									onclick={() => removeDimension(index)}
									class="flex h-9 w-9 items-center justify-center rounded-[var(--radius)] text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
								>
									<Trash2 size={15} />
								</button>
							</div>
						</div>
					</div>
				{/each}
				<button
					type="button"
					onclick={addDimension}
					class="flex h-9 items-center gap-2 rounded-[var(--radius)] border border-border px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted"
				>
					<Plus size={14} /> Add dimension
				</button>
			</div>

			<!-- Grade boundaries -->
			<div>
				<h3
					class="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase"
				>
					Grade boundaries
				</h3>
				{#each form.grade_boundaries as boundary, index (index)}
					<div
						class="mb-2 rounded-[var(--radius)] border border-border bg-background p-3"
					>
						<div class="grid grid-cols-2 gap-3 sm:grid-cols-10">
							<label class="block sm:col-span-2">
								<span class="mb-1 block text-xs text-muted-foreground">Min %</span>
								<input
									type="number"
									min="0"
									max="100"
									step="1"
									class="h-9 w-full rounded-[var(--radius)] border border-border bg-background px-2 text-sm text-foreground"
									bind:value={boundary.minPercentage}
								/>
							</label>
							<label class="block sm:col-span-2">
								<span class="mb-1 block text-xs text-muted-foreground">Grade</span>
								<input
									type="number"
									min="1"
									max="5"
									step="0.1"
									class="h-9 w-full rounded-[var(--radius)] border border-border bg-background px-2 text-sm text-foreground"
									bind:value={boundary.grade}
								/>
							</label>
							<label class="block sm:col-span-3">
								<span class="mb-1 block text-xs text-muted-foreground">Label</span>
								<input
									type="text"
									class="h-9 w-full rounded-[var(--radius)] border border-border bg-background px-2 text-sm text-foreground"
									bind:value={boundary.label}
								/>
							</label>
							<label class="block sm:col-span-2">
								<span class="mb-1 block text-xs text-muted-foreground"
									>US equiv.</span
								>
								<input
									type="text"
									class="h-9 w-full rounded-[var(--radius)] border border-border bg-background px-2 text-sm text-foreground"
									bind:value={boundary.usEquiv}
								/>
							</label>
							<div class="flex items-end justify-end sm:col-span-1">
								<button
									type="button"
									aria-label="Remove boundary {index}"
									onclick={() => removeBoundary(index)}
									class="flex h-9 w-9 items-center justify-center rounded-[var(--radius)] text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
								>
									<Trash2 size={15} />
								</button>
							</div>
						</div>
					</div>
				{/each}
				<button
					type="button"
					onclick={addBoundary}
					class="flex h-9 items-center gap-2 rounded-[var(--radius)] border border-border px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted"
				>
					<Plus size={14} /> Add boundary
				</button>
			</div>

			<!-- Info: scope + reload semantics -->
			<div
				class="flex items-start gap-2 rounded-[var(--radius)] border border-border bg-muted/50 p-3 text-xs text-muted-foreground"
			>
				<Info size={14} class="mt-0.5 shrink-0" />
				<p>
					Application-level config shared across all assignments — saved atomically to
					data/grading_config.yaml and read fresh by grading pages on load. Changing
					weights or boundaries affects future computations; already-stored grades are not
					recomputed. Per-assignment criteria &amp; scoring live in the assignment editor,
					not here.
				</p>
			</div>

			{#if savedAt}
				<p class="text-xs text-muted-foreground">Saved at {savedAt}.</p>
			{/if}

			<div class="flex justify-end">
				<button
					onclick={handleSave}
					disabled={saving}
					class="flex h-9 items-center gap-2 rounded-[var(--radius)] bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity disabled:opacity-50"
				>
					{#if saving}
						<Loader size={14} class="animate-spin" />
						Saving…
					{:else}
						<Save size={14} />
						Save grading config
					{/if}
				</button>
			</div>
		</div>
	{/if}
</div>
