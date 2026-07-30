<script lang="ts">
	import { getSubmission } from "$lib/services/submissions-store.js";
	import { headerConfig } from "$lib/stores/header.svelte.js";
	import { page } from "$app/state";
	import { base } from "$app/paths";
	import type { SubmissionDetail } from "$lib/types/submissions.js";
	import type { GradingConfig, GradingInputs, GradeResult } from "$lib/types/grading.js";
	import type { MergedRubric } from "$lib/types/criteria.js";
	import type { CategorySelections } from "$lib/types/session.js";
	import { defaultGradingInputs } from "$lib/types/grading.js";
	import { calculateGrade } from "$lib/services/grade-calculator.js";
	import { getCriteriaForAssignment } from "$lib/services/criteria-loader.js";
	import ExecutionOutput from "$lib/components/submissions/execution-output.svelte";
	import ReferenceComparison from "$lib/components/submissions/reference-comparison.svelte";
	import RightPanelTabs from "$lib/components/submissions/right-panel-tabs.svelte";
	import SkeletonPulse from "$lib/components/ui/skeleton-pulse.svelte";
	import * as yaml from "js-yaml";
	import AlertTriangle from "@lucide/svelte/icons/alert-triangle";
	import RefreshCw from "@lucide/svelte/icons/refresh-cw";
	import WandSparkles from "@lucide/svelte/icons/wand-sparkles";
	import FileText from "@lucide/svelte/icons/file-text";
	import PanelRightClose from "@lucide/svelte/icons/panel-right-close";
	import PanelRightOpen from "@lucide/svelte/icons/panel-right-open";

	type Tab = "rubric" | "grading" | "copilot";

	// -----------------------------------------------------------------------
	// Header config
	// -----------------------------------------------------------------------
	$effect(() => {
		const sub = submission;
		headerConfig.headerState = "submission";
		headerConfig.showBack = true;
		headerConfig.breadcrumb = sub ? `Submission: ${sub.studentId}` : "Submission";
		headerConfig.showSave = true;
		headerConfig.onsaveclick = handleSaveGrade;
		headerConfig.showExport = true;
		headerConfig.onexportclick = handleExportYaml;
		headerConfig.showImport = false;
		return () => {
			headerConfig.headerState = "dashboard";
			headerConfig.showBack = false;
			headerConfig.breadcrumb = undefined;
			headerConfig.showSave = false;
			headerConfig.onsaveclick = undefined;
			headerConfig.showExport = false;
			headerConfig.onexportclick = undefined;
		};
	});

	// -----------------------------------------------------------------------
	// State
	// -----------------------------------------------------------------------
	let submission = $state<SubmissionDetail | null>(null);
	let isLoading = $state(true);
	let error = $state<string | null>(null);
	let gradingConfig = $state<GradingConfig | null>(null);
	let gradingInputs = $state<GradingInputs>(defaultGradingInputs());
	let rubric = $state<MergedRubric | null>(null);
	let categorySelections = $state<Record<string, CategorySelections>>({});
	let activeTab = $state<Tab>("rubric");

	// -----------------------------------------------------------------------
	// Resizable divider + collapsible right panel
	// -----------------------------------------------------------------------
	/** Left panel width in pixels. Default: 66% of the container. */
	let leftPanelWidth = $state<number | null>(null);
	let isDragging = $state(false);
	let rightPanelCollapsed = $state(false);
	let containerRef: HTMLDivElement | undefined = $state(undefined);

	// Clamp values: right panel min 300px, max 50% of container
	const RIGHT_MIN = 300;
	const RIGHT_MAX_FRAC = 0.5;

	function getContainerWidth(): number {
		return containerRef?.clientWidth ?? 1200;
	}

	function getLeftPct(): number {
		if (rightPanelCollapsed) return 100;
		if (leftPanelWidth === null) return 66;
		const cw = getContainerWidth();
		if (cw <= 0) return 66;
		return (leftPanelWidth / cw) * 100;
	}

	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	function getRightPct() {
		if (rightPanelCollapsed) return 0;
		return 100 - getLeftPct();
	}

	function handleDividerPointerDown(e: PointerEvent) {
		if (rightPanelCollapsed) return;
		isDragging = true;
		// Capture pointer so we get events even outside the element
		(e.target as HTMLElement).setPointerCapture(e.pointerId);
	}

	function handleDividerPointerMove(e: PointerEvent) {
		if (!isDragging || !containerRef || rightPanelCollapsed) return;
		const rect = containerRef.getBoundingClientRect();
		const cw = rect.width;
		if (cw <= 0) return;
		// x relative to container
		let x = e.clientX - rect.left;
		// Clamp: right panel min RIGHT_MIN, max 50%
		const rightMax = cw * RIGHT_MAX_FRAC;
		const leftMax = cw - RIGHT_MIN;
		const leftMin = cw - rightMax;
		x = Math.max(leftMin, Math.min(leftMax, x));
		leftPanelWidth = x;
	}

	function handleDividerPointerUp() {
		isDragging = false;
	}

	function toggleRightPanel() {
		rightPanelCollapsed = !rightPanelCollapsed;
	}

	// Reset on mobile — no custom resize below 768px
	let isMobile = $state(false);
	$effect(() => {
		if (typeof window === "undefined") return;
		const mq = window.matchMedia("(max-width: 767px)");
		function handler(e: MediaQueryListEvent | MediaQueryList) {
			isMobile = e.matches;
			if (e.matches) {
				rightPanelCollapsed = false;
				leftPanelWidth = null;
			}
		}
		handler(mq);
		mq.addEventListener("change", handler as (e: MediaQueryListEvent) => void);
		return () => mq.removeEventListener("change", handler as (e: MediaQueryListEvent) => void);
	});

	// -----------------------------------------------------------------------
	// Derived
	// -----------------------------------------------------------------------
	let gradeResult = $derived<GradeResult | null>(
		gradingConfig ? calculateGrade(gradingInputs, gradingConfig, 0) : null,
	);
	let totalDeductions = $derived(0);

	// -----------------------------------------------------------------------
	// Data loading
	// -----------------------------------------------------------------------
	$effect(() => {
		const id = page.params.id;
		if (!id) return;
		loadData(id);
	});

	async function loadData(id: string) {
		isLoading = true;
		error = null;
		try {
			// Phase 2 stub: simulate async load

			const sub = getSubmission(id);
			if (!sub) {
				error = `Submission "${id}" not found`;
				return;
			}
			submission = sub;

			// Load grading config from static YAML
			const resp = await fetch(`${base}/data/grading_config.yaml`);
			if (resp.ok) {
				const text = await resp.text();
				const parsed = yaml.load(text) as GradingConfig;
				if (parsed && parsed.dimensions) {
					gradingConfig = parsed;
				}
			}

			// Load rubric for this assignment
			const mergedRubric = await getCriteriaForAssignment(sub.assignmentId);
			rubric = mergedRubric;

			// Build stub category selections from rubric
			if (mergedRubric && mergedRubric.categories.length > 0) {
				const selections: Record<string, CategorySelections> = {};
				for (const entry of mergedRubric.categories) {
					selections[entry.key] = {
						checked_items: new Set(),
						notes: "",
						comments: {},
						deductions: {},
					};
				}
				categorySelections = selections;
			}
		} catch (e) {
			error = e instanceof Error ? e.message : "Failed to load submission";
		} finally {
			isLoading = false;
		}
	}

	// -----------------------------------------------------------------------
	// Handlers
	// -----------------------------------------------------------------------
	function handleTabChange(tab: Tab) {
		activeTab = tab;
	}

	// Phase 2 stub handlers (no-op — real functionality in Phase 3)
	function handleUpdateDimension(_key: string, _value: number) {
		/* Phase 3 */
	}

	function handleSaveGrade() {
		activeTab = "grading";
	}

	function handleExportYaml() {
		activeTab = "copilot";
	}

	function handleSuggestGrade() {
		activeTab = "copilot";
	}

	function handleDraftNotes() {
		activeTab = "copilot";
	}
</script>

<svelte:head>
	<title>SciPro Review — {submission?.studentId ?? "Submission"}</title>
</svelte:head>

<!-- Loading state -->
{#if isLoading}
	<div
		class="review-layout"
		style="display:flex;flex-direction:row;flex:1;min-height:0;max-height:calc(100vh - 56px);"
	>
		<!-- Left panel skeleton -->
		<div class="flex flex-1 flex-col overflow-hidden" style="flex:2 1 0">
			<!-- Submission header -->
			<div class="flex items-center gap-3 border-b border-border px-6 py-4 md:px-10 lg:px-8">
				<SkeletonPulse class="h-5 w-28" />
				<SkeletonPulse class="h-5 w-20 rounded-full" />
				<div class="ml-auto flex items-center gap-2">
					<SkeletonPulse class="h-7 w-[70px] rounded-[var(--radius)]" />
					<SkeletonPulse class="h-7 w-[90px] rounded-[var(--radius)]" />
					<SkeletonPulse class="h-7 w-7 rounded-[var(--radius)]" />
				</div>
			</div>
			<!-- Reference comparison skeleton -->
			<div
				class="flex items-center gap-2 border-b border-border px-6 py-2.5 md:px-10 lg:px-8"
			>
				<SkeletonPulse class="h-3 w-4" />
				<SkeletonPulse class="h-3 w-36" />
				<div class="ml-auto flex items-center gap-4">
					<SkeletonPulse class="h-3 w-28" />
				</div>
			</div>
			<!-- Cell cards skeleton -->
			<div class="flex-1 space-y-3 overflow-y-auto p-4">
				{#each [1, 2, 3, 4] as _i (_i)}
					<div class="overflow-hidden rounded-[var(--radius)] border border-border">
						<div
							class="flex items-center gap-4 border-b border-border px-3 py-1.5"
							style="background:oklch(0.985 0.002 247.8)"
						>
							<SkeletonPulse class="h-3 w-16" />
							<SkeletonPulse class="ml-auto h-4 w-28 rounded-full" />
						</div>
						<div class="p-3">
							<SkeletonPulse
								class="h-12 w-full"
								style="background:oklch(0.148 0.004 228.8)"
							/>
						</div>
					</div>
				{/each}
			</div>
		</div>

		<!-- Divider skeleton -->
		<div class="w-[6px] shrink-0">
			<div
				class="mx-auto mt-[50vh] h-8 w-[2px] rounded-full"
				style="background:var(--border)"
			></div>
		</div>

		<!-- Right panel skeleton -->
		<div class="flex flex-1 flex-col" style="flex:1 1 0;min-width:300px;max-width:50%">
			<!-- Tab bar -->
			<div class="flex border-b border-border px-3 py-2.5">
				<SkeletonPulse class="mr-6 h-4 w-14" />
				<SkeletonPulse class="mr-6 h-4 w-16" />
				<SkeletonPulse class="h-4 w-16" />
			</div>
			<!-- Tab content -->
			<div class="flex-1 space-y-2 overflow-y-auto p-3">
				{#each [1, 2, 3] as _j (_j)}
					<div class="overflow-hidden rounded-[var(--radius)] border border-border">
						<div
							class="flex items-center justify-between border-b border-border px-3 py-2.5"
						>
							<SkeletonPulse class="h-4 w-32" />
							<SkeletonPulse class="h-4 w-4" />
						</div>
						<div class="space-y-2 p-3">
							<SkeletonPulse class="h-3 w-full" />
							<SkeletonPulse class="h-3 w-3/4" />
							<SkeletonPulse class="h-3 w-1/2" />
						</div>
					</div>
				{/each}
			</div>
		</div>
	</div>

	<!-- Error state -->
{:else if error}
	<div class="flex items-center justify-center px-6 py-20 md:px-10 lg:px-16 xl:px-24">
		<div class="max-w-md text-center">
			<AlertTriangle size={40} class="mx-auto text-destructive" />
			<h2 class="mt-4 text-lg font-semibold text-foreground">Something went wrong</h2>
			<p class="mt-2 text-sm text-muted-foreground">{error}</p>
			<div class="mt-6 flex items-center justify-center gap-3">
				<button
					onclick={() => page.params.id && loadData(page.params.id)}
					class="inline-flex items-center gap-2 rounded-[var(--radius)] bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
				>
					<RefreshCw size={14} />
					Try again
				</button>
				<a
					href="{base}/submissions"
					class="inline-flex items-center gap-1 rounded-[var(--radius)] border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-black/5 dark:hover:bg-white/10"
				>
					Go to Dashboard
				</a>
			</div>
		</div>
	</div>

	<!-- Content state -->
{:else if submission}
	{@const cells = submission.cells}

	<!--
		Two-panel layout with resizable divider.
		On mobile (<768px): stacks vertically, no divider.
		Uses flex — handles the divider as a sibling between panels
		without the grid child-counting issue.
	-->
	{@const showDivider = !isMobile && !rightPanelCollapsed}
	{@const showRightPanel = !rightPanelCollapsed}
	{@const leftStyle = rightPanelCollapsed
		? "flex: 1 1 100%"
		: isMobile
			? "flex: 1 1 auto"
			: leftPanelWidth !== null
				? `flex: 0 0 ${leftPanelWidth}px`
				: "flex: 2 1 0"}
	<div
		class="review-layout"
		class:is-dragging={isDragging}
		class:right-collapsed={rightPanelCollapsed}
		class:is-mobile={isMobile}
		bind:this={containerRef}
	>
		<!-- Left Panel: Cells -->
		<div class="left-panel" style={leftStyle}>
			<!-- Submission header -->
			<div
				class="flex items-center gap-3 border-b border-border bg-card px-6 py-4 md:px-10 lg:px-8"
			>
				<h1 class="text-lg font-semibold text-foreground">{submission.studentId}</h1>
				<span
					class="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
				>
					Executed
				</span>
				<div class="ml-auto flex items-center gap-2">
					<button
						onclick={handleSuggestGrade}
						class="inline-flex items-center gap-1.5 rounded-[var(--radius)] border border-border px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-black/5 dark:hover:bg-white/10"
					>
						<WandSparkles size={14} />
						Suggest
					</button>
					<button
						onclick={handleDraftNotes}
						class="inline-flex items-center gap-1.5 rounded-[var(--radius)] border border-border px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-black/5 dark:hover:bg-white/10"
					>
						<FileText size={14} />
						Draft Notes
					</button>

					<!-- Collapse/expand right panel toggle -->
					<button
						onclick={toggleRightPanel}
						class="toggle-panel-btn"
						aria-label={rightPanelCollapsed ? "Show panel" : "Hide panel"}
						title={rightPanelCollapsed ? "Show grading panel" : "Hide grading panel"}
					>
						{#if rightPanelCollapsed}
							<PanelRightOpen size={16} />
						{:else}
							<PanelRightClose size={16} />
						{/if}
					</button>
				</div>
			</div>

			<!-- Reference comparison -->
			<ReferenceComparison
				submissionCells={cells}
				referenceCells={submission.referenceCells}
			/>

			<!-- Cell execution output -->
			<ExecutionOutput {cells} />
		</div>

		<!-- Resizable divider (hidden on mobile or when right panel is collapsed) -->
		{#if showDivider}
			<button
				type="button"
				class="panel-divider"
				onpointerdown={handleDividerPointerDown}
				onpointermove={handleDividerPointerMove}
				onpointerup={handleDividerPointerUp}
				onpointercancel={handleDividerPointerUp}
				aria-label="Resize panels"
				ondblclick={() => {
					leftPanelWidth = null;
				}}
				onkeydown={(e) => {
					if (e.key === "ArrowLeft") {
						const cw = getContainerWidth();
						leftPanelWidth = Math.max(cw * 0.5, (leftPanelWidth ?? cw * 0.66) - 20);
					} else if (e.key === "ArrowRight") {
						const cw = getContainerWidth();
						leftPanelWidth = Math.min(
							cw - RIGHT_MIN,
							(leftPanelWidth ?? cw * 0.66) + 20,
						);
					}
				}}
			></button>
		{/if}

		<!-- Right Panel: Tabs (hidden when collapsed) -->
		{#if showRightPanel}
			<aside class="right-panel">
				{#if gradingConfig}
					<RightPanelTabs
						{activeTab}
						onTabChange={handleTabChange}
						dimensions={gradingConfig.dimensions}
						grading={gradingInputs}
						{gradeResult}
						{totalDeductions}
						onUpdateDimension={handleUpdateDimension}
						{rubric}
						{categorySelections}
					/>
				{/if}
			</aside>
		{/if}
	</div>
{/if}

<style>
	/* ── Review layout (two-panel) ── */
	.review-layout {
		display: flex;
		flex-direction: row;
		flex: 1;
		min-height: 0;
		max-height: calc(100vh - 56px);
		position: relative;
		user-select: none;
	}
	.review-layout.is-dragging {
		cursor: col-resize;
	}
	/* .review-layout.right-collapsed — left panel takes full width via inline style */
	.review-layout.is-mobile {
		flex-direction: column;
	}

	/* ── Left panel ── */
	.left-panel {
		min-width: 0;
		overflow-y: auto;
		background: var(--bg);
		border-right: 1px solid var(--border);
		/* flex value set via inline style */
	}
	.review-layout.right-collapsed .left-panel {
		border-right: none;
	}

	/* ── Panel divider (draggable) ── */
	.panel-divider {
		position: relative;
		width: 6px;
		margin-left: -3px;
		cursor: col-resize;
		background: transparent;
		z-index: 10;
		flex-shrink: 0;
		transition: background 0.1s;
		border: none;
		padding: 0;
	}
	.panel-divider:hover,
	.review-layout.is-dragging .panel-divider {
		background: var(--accent);
		opacity: 0.3;
	}
	.panel-divider::after {
		content: "";
		position: absolute;
		top: 50%;
		left: 50%;
		transform: translate(-50%, -50%);
		width: 2px;
		height: 32px;
		border-radius: 2px;
		background: var(--border);
		transition:
			background 0.1s,
			height 0.1s;
	}
	.panel-divider:hover::after,
	.review-layout.is-dragging .panel-divider::after {
		background: var(--accent);
		height: 48px;
		opacity: 0.8;
	}
	/* Focus ring for keyboard users */
	.panel-divider:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -1px;
	}

	/* ── Right panel ── */
	.right-panel {
		display: flex;
		flex-direction: column;
		overflow: hidden;
		background: var(--bg);
		flex: 1 1 0;
		min-width: 300px;
		max-width: 50%;
	}

	/* ── Collapse toggle button ── */
	.toggle-panel-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		border-radius: var(--radius);
		color: var(--muted-foreground);
		background: transparent;
		border: 1px solid var(--border);
		cursor: pointer;
		transition:
			background 0.15s,
			color 0.15s,
			border-color 0.15s;
		margin-left: 4px;
	}
	.toggle-panel-btn:hover {
		background: var(--muted-bg);
		color: var(--fg);
		border-color: var(--muted);
	}

	/* ── Mobile overrides ── */
	@media (max-width: 767px) {
		.review-layout.is-mobile {
			max-height: calc(100vh - 56px);
		}
		.review-layout.is-mobile .right-panel {
			min-width: unset;
			max-width: none;
			width: 100%;
			border-top: 1px solid var(--border);
			flex: 1 1 40%;
		}
		.review-layout.is-mobile .left-panel {
			border-right: none;
			flex: 1 1 60% !important;
		}
		/* Tighter submission header on mobile */
		.review-layout.is-mobile .left-panel > div:first-child {
			flex-wrap: wrap;
			gap: 8px;
			padding: 10px 12px;
		}
	}
</style>
