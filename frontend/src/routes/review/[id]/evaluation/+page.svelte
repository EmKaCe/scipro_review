<script lang="ts">
	import { reviewStore } from "$lib/stores/review.svelte.js";
	import { settings } from "$lib/stores/settings.svelte.js";
	import { addToast } from "$lib/stores/toast.svelte.js";
	import { headerConfig } from "$lib/stores/header.svelte.js";
	import { goto } from "$app/navigation";
	import { base } from "$app/paths";
	import { page } from "$app/state";
	import { renderMarkdown } from "$lib/utils/markdown.js";
	import EvaluationMetadata from "$lib/components/evaluation-metadata.svelte";
	import EvaluationActionBar from "$lib/components/evaluation-action-bar.svelte";
	import EvaluationSkeleton from "$lib/components/skeleton/evaluation-skeleton.svelte";
	import EmptyState from "$lib/components/ui/empty-state.svelte";
	import FileText from "@lucide/svelte/icons/file-text";

	// Configure header for this page
	$effect(() => {
		headerConfig.showBack = true;
		headerConfig.breadcrumb = "Evaluation";
		headerConfig.showImport = false;
		headerConfig.onimportclick = undefined;
		return () => {
			headerConfig.showBack = false;
			headerConfig.breadcrumb = undefined;
			headerConfig.showImport = false;
			headerConfig.onimportclick = undefined;
		};
	});

	// Reactive references to store state
	let generatedText = $derived(reviewStore.generated_text);
	let gradeResult = $derived(reviewStore.grade_result);
	let studentId = $derived(reviewStore.student_id);
	let assignmentId = $derived(reviewStore.assignment_id);
	let assignments = $derived(reviewStore.assignments);
	let isLoading = $derived(reviewStore.is_loading);

	// Initialize store on mount if not already loaded (handles direct navigation)
	$effect(() => {
		if (assignments.length === 0 && !isLoading) {
			reviewStore.init();
		}
	});

	// Load assignment criteria on direct navigation / refresh
	// Skip if a session was already restored (student_id is set)
	$effect(() => {
		const id = page.params.id;
		const hasRestoredSession = reviewStore.student_id !== "";
		if (
			id &&
			!reviewStore.rubric &&
			!isLoading &&
			assignments.length > 0 &&
			!hasRestoredSession
		) {
			reviewStore.setAssignment(id);
		}
	});

	// Human-readable assignment title
	let assignmentTitle = $derived.by(() => {
		const assignment = assignments.find((a) => a.id === assignmentId);
		return assignment?.title ?? assignmentId;
	});

	// Determine page state — an imported teacher student-copy has no generated
	// text but may carry feedback notes, so notes alone count as loaded.
	let pageState = $derived<"loading" | "empty" | "loaded">(
		reviewStore.is_loading
			? "loading"
			: generatedText || reviewStore.notes
				? "loaded"
				: "empty",
	);

	// Rendered Markdown HTML — strip YAML frontmatter, render markdown + math
	// via the shared util, wrap sentiments.
	let renderedHtml = $derived.by(() => {
		if (!generatedText) return "";
		// Strip YAML frontmatter (between --- delimiters)
		let text = generatedText.replace(/^---[\s\S]*?---\n*/, "");

		// Markdown + KaTeX math + code highlighting
		let html = renderMarkdown(text);

		// Post-process sentiment markers into styled divs
		html = html.replace(
			/<!-- sentiment:(positive|neutral|negative) -->/g,
			(_match, sentiment) => {
				const cls =
					sentiment === "positive"
						? "sentiment-positive"
						: sentiment === "negative"
							? "sentiment-negative"
							: "sentiment-neutral";
				return `<div class="${cls}">`;
			},
		);
		html = html.replace(/<!-- \/sentiment:(positive|neutral|negative) -->/g, () => "</div>");

		return html;
	});

	// Grade display
	let percentage = $derived(gradeResult?.percentage ?? 0);
	let germanGrade = $derived(gradeResult?.grade?.toFixed(1) ?? "—");
	let usGrade = $derived(gradeResult?.label ?? "—");
	let date = $derived(new Date().toLocaleDateString());

	function handleCopy() {
		if (!generatedText) {
			addToast("warning", "No evaluation text to copy");
			return;
		}
		if (navigator.clipboard) {
			navigator.clipboard.writeText(generatedText).then(() => {
				addToast("success", "Copied to clipboard");
			});
		} else {
			addToast("error", "Clipboard API not available");
		}
	}

	function handleExportYaml() {
		reviewStore.exportReview("yaml", settings.reviewerName);
	}

	function handleExportMarkdown() {
		reviewStore.exportReview("md", settings.reviewerName);
	}

	function handleBack() {
		goto(`${base}/review/${page.params.id}`);
	}

	function handlePrint() {
		window.print();
	}
</script>

<svelte:head>
	<title>SciPro Review — Evaluation Preview</title>
</svelte:head>

<div class="evaluation-page mx-auto max-w-3xl space-y-8 px-4 py-8">
	{#if pageState === "loading"}
		<EvaluationSkeleton />
	{:else if pageState === "empty"}
		<EmptyState
			title="No evaluation to preview"
			description="Complete at least one category and click 'Generate Evaluation' to create a preview."
		>
			{#snippet icon()}
				<FileText size={48} class="text-muted-foreground" />
			{/snippet}
			{#snippet action()}
				<button
					onclick={handleBack}
					class="h-9 rounded-[var(--radius)] border border-border px-4 text-sm font-medium text-foreground transition-colors hover:bg-black/5 dark:hover:bg-white/10"
				>
					Back to Review
				</button>
			{/snippet}
		</EmptyState>
	{:else}
		<EvaluationMetadata
			class="evaluation-metadata"
			{studentId}
			assignment={assignmentTitle}
			{date}
			{percentage}
			{germanGrade}
			{usGrade}
			showGrading={true}
		/>

		<!-- Rendered Markdown evaluation — content is generated by our own store, not user input -->
		<article class="markdown-body">
			{@html renderedHtml}
		</article>

		<!-- Teacher feedback notes (top-level `notes` in imported evaluations) -->
		{#if reviewStore.notes}
			<div class="notes-section rounded-[var(--radius)] border border-border bg-card p-6">
				<h3 class="mb-3 text-base font-semibold">Notes</h3>
				<p class="notes-body text-sm leading-relaxed whitespace-pre-wrap text-foreground">
					{reviewStore.notes}
				</p>
			</div>
		{/if}

		{#if gradeResult}
			<div
				class="grading-summary mt-8 rounded-[var(--radius)] border border-border bg-card p-6"
			>
				<h3 class="mb-4 text-base font-semibold">Grading Summary</h3>
				<div class="overflow-x-auto">
					<table class="w-full text-sm">
						<thead>
							<tr class="border-b border-border">
								<th class="p-2 text-left font-medium">Dimension</th>
								<th class="p-2 text-right font-medium">Score</th>
								<th class="p-2 text-right font-medium">Max</th>
								<th class="p-2 text-right font-medium">Weight</th>
								<th class="p-2 text-right font-medium">Weighted</th>
							</tr>
						</thead>
						<tbody>
							{#each gradeResult.dimensions as dim (dim.dimension.key)}
								<tr class="border-b border-border">
									<td class="p-2">{dim.dimension.title}</td>
									<td class="p-2 text-right">{dim.score.toFixed(1)}</td>
									<td class="p-2 text-right"
										>{dim.dimension.max_points.toFixed(1)}</td
									>
									<td class="p-2 text-right">{dim.dimension.weight}</td>
									<td class="p-2 text-right"
										>{dim.weighted_score.toFixed(1)}/{dim.weighted_max.toFixed(
											1,
										)}</td
									>
								</tr>
							{/each}
							{#if reviewStore.totalDeductions > 0}
								<tr class="border-b border-border">
									<td class="p-2 font-medium">Total Deductions</td>
									<td class="p-2 text-right text-destructive" colspan="4"
										>−{reviewStore.totalDeductions.toFixed(1)}</td
									>
								</tr>
							{/if}
							<tr class="font-semibold">
								<td class="p-2">Final Result</td>
								<td class="p-2 text-right"
									>{(
										gradeResult.total_weighted - reviewStore.totalDeductions
									).toFixed(1)}</td
								>
								<td class="p-2 text-right"
									>{gradeResult.total_weighted_max.toFixed(1)}</td
								>
								<td class="p-2 text-right"></td>
								<td class="p-2 text-right">{gradeResult.percentage.toFixed(1)}%</td>
							</tr>
						</tbody>
					</table>
				</div>
			</div>
		{/if}

		<EvaluationActionBar
			onCopy={handleCopy}
			onExportYaml={handleExportYaml}
			onExportMarkdown={handleExportMarkdown}
			onBack={handleBack}
			onPrint={handlePrint}
		/>
	{/if}
</div>
