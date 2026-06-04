<script lang="ts">
	import { reviewStore } from "$lib/stores/review.svelte.js";
	import { settings } from "$lib/stores/settings.svelte.js";
	import { addToast } from "$lib/stores/toast.svelte.js";
	import { headerConfig } from "$lib/stores/header.svelte.js";
	import { goto } from "$app/navigation";
	import { base } from "$app/paths";
	import { page } from "$app/state";
	import type { CategoryKey } from "$lib/types/criteria.js";
	import RubricCategory from "$lib/components/rubric-category.svelte";
	import GradingSidebar from "$lib/components/grading-sidebar.svelte";
	import QuickNav from "$lib/components/quick-nav.svelte";
	import ReviewFooter from "$lib/components/review-footer.svelte";
	import CategorySkeleton from "$lib/components/skeleton/category-skeleton.svelte";
	import SidebarSkeleton from "$lib/components/skeleton/sidebar-skeleton.svelte";
	import ImportDialog from "$lib/components/import-dialog.svelte";
	import Pencil from "@lucide/svelte/icons/pencil";
	import FileText from "@lucide/svelte/icons/file-text";
	import Download from "@lucide/svelte/icons/download";

	// Configure header for this page
	let showImportDialog = $state(false);

	$effect(() => {
		headerConfig.showBack = true;
		headerConfig.breadcrumb = "Review";
		headerConfig.showImport = true;
		headerConfig.showSave = true;
		headerConfig.onsaveclick = saveReview;
		headerConfig.onimportclick = () => (showImportDialog = true);
		return () => {
			headerConfig.showBack = false;
			headerConfig.breadcrumb = undefined;
			headerConfig.showImport = false;
			headerConfig.showSave = false;
			headerConfig.onsaveclick = undefined;
			headerConfig.onimportclick = undefined;
		};
	});

	// Initialize store on mount if not already loaded (handles direct navigation)
	$effect(() => {
		if (assignments.length === 0 && !isLoading) {
			reviewStore.init();
		}
	});

	// Load assignment criteria on direct navigation / refresh
	$effect(() => {
		const id = page.params.id;
		if (id && !rubric && !isLoading && assignments.length > 0) {
			reviewStore.setAssignment(id);
		}
	});

	// Reactive references to store state
	let rubric = $derived(reviewStore.rubric);
	let categories = $derived(rubric?.categories ?? []);
	let assignments = $derived(reviewStore.assignments);
	let gradingConfig = $derived(reviewStore.grading_config);
	let categorySelections = $derived(reviewStore.category_selections);
	let grading = $derived(reviewStore.grading);
	let gradeResult = $derived(reviewStore.grade_result);
	let totalDeductions = $derived(reviewStore.totalDeductions);
	let progress = $derived(reviewStore.category_progress);
	let progressPercentage = $derived(reviewStore.progress_percentage);
	let isLoading = $derived(reviewStore.is_loading);
	let isReadOnly = $derived(reviewStore.is_read_only);
	let canUndo = $derived(reviewStore.can_undo);
	let canRedo = $derived(reviewStore.can_redo);
	let mode = $derived(reviewStore.mode);

	// Track expanded state per category
	let expandedCategories = $state<Record<string, boolean>>({});

	// Initialize expanded state when rubric loads
	$effect(() => {
		if (categories.length > 0 && Object.keys(expandedCategories).length === 0) {
			const expanded: Record<string, boolean> = {};
			for (const entry of categories) {
				expanded[entry.key] = true;
			}
			expandedCategories = expanded;
		}
	});

	// Active category for scroll-spy
	let activeCategoryId = $state<string | null>(null);

	// Teacher mode reactive wrapper
	let teacherMode = $derived(mode === "teacher");

	function toggleCategoryExpanded(key: string) {
		expandedCategories[key] = !(expandedCategories[key] ?? true);
	}

	function toggleAllCategories() {
		const allExpanded = Object.values(expandedCategories).every((v) => v);
		const newState: Record<string, boolean> = {};
		for (const entry of categories) {
			newState[entry.key] = !allExpanded;
		}
		expandedCategories = newState;
	}

	function handleToggleCheckbox(
		categoryKey: CategoryKey,
		subPointText: string,
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		_checked: boolean,
	) {
		reviewStore.toggleCheckbox(categoryKey, subPointText);
	}

	function handleUpdateComment(categoryKey: CategoryKey, subPointText: string, value: string) {
		reviewStore.setComment(categoryKey, subPointText, value);
	}

	function handleUpdateDeduction(categoryKey: CategoryKey, subPointText: string, value: number) {
		reviewStore.setDeduction(categoryKey, subPointText, value);
	}

	function handleUpdateNotes(categoryKey: CategoryKey, value: string) {
		reviewStore.setNotes(categoryKey, value);
	}

	function handleUpdateDimension(key: string, value: number) {
		reviewStore.setGradingInput(key, value);
	}

	async function saveReview() {
		await reviewStore.save();
	}

	async function handleGenerateEvaluation() {
		reviewStore.generateText();
		await reviewStore.forceAutoSave();
		goto(`${base}/review/${page.params.id}/evaluation`);
	}

	async function handleImport(file: File) {
		try {
			const text = await file.text();
			await reviewStore.importReview(text, file.name);
			const importedGrading = reviewStore.grading;
			const hasGradingValues = Object.values(importedGrading).some((v) => v > 0);
			let readOnly = false;
			let forcedReadOnly = false;
			if (settings.mode === "teacher") {
				readOnly = false;
			} else if (settings.mode === "student" && hasGradingValues) {
				readOnly = true;
				forcedReadOnly = true;
			}
			reviewStore.is_read_only = readOnly;
			reviewStore.is_forced_read_only = forcedReadOnly;
			// Sync store mode with user settings so grading controls work correctly
			reviewStore.mode = settings.mode;
			showImportDialog = false;
		} catch (error) {
			console.error("[Review] Import failed:", error);
			addToast("error", "Failed to import review");
		}
	}

	// Scroll-spy with IntersectionObserver
	let observer: IntersectionObserver | null = null;

	$effect(() => {
		if (isLoading || categories.length === 0) return;

		observer?.disconnect();

		observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (entry.isIntersecting) {
						const catKey = entry.target.id.replace("category-", "");
						if (catKey !== activeCategoryId) {
							activeCategoryId = catKey;
						}
					}
				}
			},
			{
				rootMargin: "-80px 0px -70% 0px",
				threshold: 0,
			},
		);

		for (const entry of categories) {
			const el = document.getElementById(`category-${entry.key}`);
			if (el) observer?.observe(el);
		}

		return () => {
			observer?.disconnect();
		};
	});

	// Keyboard shortcuts
	$effect(() => {
		function handleKeydown(e: KeyboardEvent) {
			const target = e.target as HTMLElement;
			if (
				target.tagName === "INPUT" ||
				target.tagName === "TEXTAREA" ||
				target.isContentEditable
			) {
				return;
			}
			if ((e.ctrlKey || e.metaKey) && e.key === "s") {
				e.preventDefault();
				saveReview();
			}
			if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) {
				e.preventDefault();
				if (canUndo) reviewStore.undo();
			}
			if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "z" || e.key === "Z")) {
				e.preventDefault();
				if (canRedo) reviewStore.redo();
			}
		}

		document.addEventListener("keydown", handleKeydown);
		return () => document.removeEventListener("keydown", handleKeydown);
	});

	// Navigation handler
	function scrollToCategory(key: string) {
		const el = document.getElementById(`category-${key}`);
		if (el) {
			el.scrollIntoView({ behavior: "smooth", block: "start" });
			activeCategoryId = key;
		}
	}
</script>

<svelte:head>
	<title>SciPro Review — Review</title>
</svelte:head>

{#if isReadOnly}
	<!-- Review sub-header: read-only indicator only -->
	<div
		class="sticky top-14 z-30 border-b border-border bg-background/80 backdrop-blur-md print:hidden"
	>
		<div class="flex items-center gap-2 px-6 py-2 md:px-10 lg:px-16 xl:px-24">
			<span
				class="inline-flex items-center rounded-full border border-warning/20 bg-warning/10 px-2 py-0.5 text-xs font-medium whitespace-nowrap text-warning"
			>
				Read-only
			</span>
			{#if !reviewStore.is_forced_read_only}
				<button
					onclick={() => (reviewStore.is_read_only = false)}
					class="inline-flex items-center gap-1 rounded-[var(--radius)] border border-border px-2 py-0.5 text-xs font-medium text-foreground transition-colors hover:bg-black/5 dark:hover:bg-white/10"
				>
					<Pencil size={14} />
					Edit
				</button>
			{/if}
		</div>
	</div>
{/if}

<div
	class="grid grid-cols-1 gap-6 px-6 py-6 pb-20 md:px-10 lg:grid-cols-[1fr_20rem] lg:px-16 xl:px-24"
>
	<!-- Left Column: Rubric Categories -->
	<div class="space-y-4 lg:pt-4">
		{#if isLoading}
			{#each [0, 1, 2] as _i (_i)}
				<CategorySkeleton />
			{/each}
		{:else if categories.length === 0}
			<div class="py-12 text-center text-muted-foreground">
				<p>No rubric loaded. Start a review from the home page.</p>
			</div>
		{:else}
			{#each categories as entry (entry.key)}
				{@const sel = categorySelections[entry.key]}
				{@const isExpanded = expandedCategories[entry.key] ?? true}
				<RubricCategory
					{entry}
					selections={sel ?? {
						checked_items: new Set(),
						notes: "",
						comments: {},
						deductions: {},
					}}
					expanded={isExpanded}
					disabled={isReadOnly}
					onToggle={() => toggleCategoryExpanded(entry.key)}
					onToggleCheckbox={(key: string, checked: boolean) =>
						handleToggleCheckbox(entry.key, key, checked)}
					onUpdateComment={(key: string, value: string) =>
						handleUpdateComment(entry.key, key, value)}
					onUpdateDeduction={(key: string, value: number) =>
						handleUpdateDeduction(entry.key, key, value)}
					onUpdateNotes={(value: string) => handleUpdateNotes(entry.key, value)}
				/>
			{/each}
		{/if}
	</div>

	<!-- Right Column: Sidebar -->
	<aside
		class="review-page-sidebar space-y-4 lg:sticky lg:top-[6rem] lg:z-20 lg:self-start lg:pt-4"
	>
		{#if isLoading}
			<SidebarSkeleton />
		{:else if gradingConfig}
			{@const hasGradingValues = Object.values(grading).some((v) => v > 0)}
			{#if teacherMode || hasGradingValues}
				<GradingSidebar
					dimensions={gradingConfig.dimensions}
					{grading}
					{gradeResult}
					{totalDeductions}
					{mode}
					disabled={isReadOnly || (!teacherMode && hasGradingValues)}
					onToggleMode={() => {
						reviewStore.mode = mode === "teacher" ? "student" : "teacher";
					}}
					onUpdateDimension={handleUpdateDimension}
				/>
			{/if}
		{/if}

		<!-- Actions Card -->
		{#if !isLoading}
			<div class="space-y-2 rounded-[var(--radius)] border border-border bg-card p-5">
				<button
					class="flex h-9 w-full items-center justify-center gap-2 rounded-[var(--radius)] bg-primary text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
					onclick={handleGenerateEvaluation}
				>
					<FileText size={14} />
					Generate Evaluation
				</button>
				<button
					class="flex h-9 w-full items-center justify-center gap-2 rounded-[var(--radius)] border border-border text-sm font-medium text-foreground transition-colors hover:bg-black/5 dark:hover:bg-white/10"
					onclick={() => reviewStore.exportReview("yaml", settings.reviewerName)}
				>
					<Download size={14} />
					Export YAML
				</button>
				<button
					class="flex h-9 w-full items-center justify-center gap-2 rounded-[var(--radius)] border border-border text-sm font-medium text-foreground transition-colors hover:bg-black/5 dark:hover:bg-white/10"
					onclick={() => reviewStore.exportReview("md", settings.reviewerName)}
				>
					<FileText size={14} />
					Export Markdown
				</button>
			</div>
		{/if}
	</aside>
</div>

<!-- Footer: Quick Nav + Keyboard Shortcuts -->
<ReviewFooter class="print:hidden">
	<QuickNav
		categories={categories.map((e) => ({ key: e.key, title: e.category.title }))}
		activeId={activeCategoryId}
		onNavigate={scrollToCategory}
		onToggleAll={toggleAllCategories}
		allExpanded={Object.values(expandedCategories).every((v) => v)}
		completedCount={progress.filled}
		totalCount={progress.total}
		{progressPercentage}
		showSave={true}
		onSave={saveReview}
		{canUndo}
		{canRedo}
		onUndo={() => reviewStore.undo()}
		onRedo={() => reviewStore.redo()}
	/>
</ReviewFooter>

<ImportDialog
	open={showImportDialog}
	onclose={() => (showImportDialog = false)}
	onimport={handleImport}
/>
