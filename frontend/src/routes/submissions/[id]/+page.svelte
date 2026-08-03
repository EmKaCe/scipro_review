<script lang="ts">
	import { submissionsStore } from "$lib/services/submissions-store.js";
	import { plagiarismStore } from "$lib/services/plagiarism-store.svelte.js";
	import { autofixStore } from "$lib/services/autofix-store.svelte.js";
	import { headerConfig } from "$lib/stores/header.svelte.js";
	import { addToast } from "$lib/stores/toast.svelte.js";
	import { page } from "$app/state";
	import { base } from "$app/paths";
	import type { SubmissionDetail } from "$lib/types/submissions.js";
	import type { GradingConfig, GradingInputs, GradeResult } from "$lib/types/grading.js";
	import type { MergedRubric } from "$lib/types/criteria.js";
	import type { CategorySelections } from "$lib/types/session.js";
	import { defaultGradingInputs } from "$lib/types/grading.js";
	import { calculateGrade } from "$lib/services/grade-calculator.js";
	import { getCriteriaForAssignment } from "$lib/services/criteria-loader.js";
	import {
		feedbackToSelections,
		selectionsToFeedback,
	} from "$lib/services/grading-persistence.js";
	import { rubricSentimentCounts } from "$lib/types/criteria.js";
	import ExecutionOutput from "$lib/components/submissions/execution-output.svelte";
	import ReferenceComparison from "$lib/components/submissions/reference-comparison.svelte";
	import RightPanelTabs from "$lib/components/submissions/right-panel-tabs.svelte";
	import MenuButton from "$lib/components/ui/menu-button.svelte";
	import SkeletonPulse from "$lib/components/ui/skeleton-pulse.svelte";
	import * as yaml from "js-yaml";
	import AlertTriangle from "@lucide/svelte/icons/alert-triangle";
	import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
	import RefreshCw from "@lucide/svelte/icons/refresh-cw";
	import WandSparkles from "@lucide/svelte/icons/wand-sparkles";
	import FileText from "@lucide/svelte/icons/file-text";
	import PanelRightClose from "@lucide/svelte/icons/panel-right-close";
	import PanelRightOpen from "@lucide/svelte/icons/panel-right-open";
	import Files from "@lucide/svelte/icons/files";
	import ListChecks from "@lucide/svelte/icons/list-checks";
	import Gauge from "@lucide/svelte/icons/gauge";
	import ShieldCheck from "@lucide/svelte/icons/shield-check";
	import Sparkles from "@lucide/svelte/icons/sparkles";
	import Download from "@lucide/svelte/icons/download";
	import Save from "@lucide/svelte/icons/save";
	import X from "@lucide/svelte/icons/x";

	/** Desktop right-panel tabs (mockup: Rubric | Grading | Plagiarism | Copilot). */
	type Tab = "rubric" | "grading" | "plagiarism" | "copilot";
	/** Mobile tabs (mockup: Cells | Rubric | Grade | Plagiarism | Copilot). */
	type MobileTab = "cells" | Tab;

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
		headerConfig.onexportclick = () => handleExport("student");
		headerConfig.exportMenuItems = [
			{
				id: "teacher",
				label: "Export teacher YAML",
				description: "Full record + plagiarism audit (-teacher)",
				onclick: () => handleExport("teacher"),
			},
		];
		headerConfig.showImport = true;
		headerConfig.onimportclick = () => importInput?.click();
		return () => {
			headerConfig.headerState = "dashboard";
			headerConfig.showBack = false;
			headerConfig.breadcrumb = undefined;
			headerConfig.showSave = false;
			headerConfig.onsaveclick = undefined;
			headerConfig.showExport = false;
			headerConfig.onexportclick = undefined;
			headerConfig.exportMenuItems = undefined;
			headerConfig.showImport = false;
			headerConfig.onimportclick = undefined;
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
	/** Hidden file input backing the header Import button (teacher YAML, 3i). */
	let importInput: HTMLInputElement | undefined = $state(undefined);

	// -----------------------------------------------------------------------
	// Mobile state (P3-6): 5-tab bar + bottom bar
	// -----------------------------------------------------------------------
	let mobileTab = $state<MobileTab>("cells");

	// -----------------------------------------------------------------------
	// Export guard (P3-1): unreviewed plagiarism pairs block Save/Export
	// -----------------------------------------------------------------------
	let exportGuardOpen = $state(false);
	/** The action being guarded: "Export YAML" | "Save Grade". */
	let exportGuardAction = $state("Export YAML");
	/** Pending action to run after "Export anyway" resolved the guard. */
	let pendingAction: "save" | "export" | null = $state(null);
	/** Export kind requested when the guard opened ("export" pending action). */
	let pendingExportKind: "student" | "teacher" = $state("student");

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
			// Real data: submissionsStore.select() fetches the detail from the
			// API and caches it (Phase 3b data layer).
			const sub = await submissionsStore.select(id);
			submission = sub;
			autofixStore.reset();

			// Load the plagiarism comparison for this assignment (badge +
			// tab data; 404 means no check yet — the tab offers a run).
			plagiarismStore.load(sub.assignmentId).catch(() => {
				// surfaced inside the Plagiarism tab / guard modal
			});

			// Load grading config from static YAML
			const resp = await fetch(`${base}/data/grading_config.yaml`);
			if (resp.ok) {
				const text = await resp.text();
				const parsed = yaml.load(text) as GradingConfig;
				if (parsed && parsed.dimensions) {
					gradingConfig = parsed;
				}
			}

			// Restore dimension sliders from the persisted record (defaults
			// for dimensions that were never saved).
			const saved = sub.grading;
			gradingInputs = { ...defaultGradingInputs(), ...(saved?.dimensions ?? {}) };

			// Load rubric for this assignment
			const mergedRubric = await getCriteriaForAssignment(sub.assignmentId);
			rubric = mergedRubric;

			// Restore per-category selections from the persisted feedback
			// block (record -> rubric -> selections ordering).
			if (mergedRubric && mergedRubric.categories.length > 0) {
				categorySelections = feedbackToSelections(
					saved?.feedback,
					mergedRubric.categories.map((c) => c.key),
				);
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

	function handleMobileTabChange(tab: MobileTab) {
		mobileTab = tab;
	}

	/**
	 * Update a dimension slider value immutably (key = dimension id).
	 */
	function handleUpdateDimension(key: string, value: number) {
		gradingInputs = { ...gradingInputs, [key as keyof GradingInputs]: value };
	}

	/** Unreviewed pairs involving the current submission (guard trigger). */
	let unreviewedCount = $derived(
		submission ? plagiarismStore.unreviewedCount(submission.studentId) : 0,
	);

	/** Counts by status for the guard modal ("2 unreviewed · 1 accepted …"). */
	let guardCounts = $derived.by(() => {
		if (!submission) return "";
		const u = plagiarismStore.countByStatus("unreviewed", submission.studentId);
		const a = plagiarismStore.countByStatus("accepted", submission.studentId);
		const d = plagiarismStore.countByStatus("dismissed", submission.studentId);
		const i = plagiarismStore.countByStatus("ignored", submission.studentId);
		const parts = [`${u} unreviewed`, `${a} accepted`, `${d} dismissed`, `${i} ignored`];
		return parts.filter((p) => !p.startsWith("0 ")).join(" · ");
	});

	/**
	 * P3-1 export guard: while unreviewed pairs exist for this submission,
	 * Save Grade / Export YAML open the guard modal. "Export anyway" marks
	 * all remaining unreviewed pairs as ignored and then proceeds.
	 */
	function guardExport(action: "Export YAML" | "Save Grade", proceed: () => void) {
		if (unreviewedCount === 0 || !submission) {
			proceed();
			return;
		}
		exportGuardAction = action;
		pendingAction = action === "Save Grade" ? "save" : "export";
		exportGuardOpen = true;
	}

	function handleGuardGoReview() {
		exportGuardOpen = false;
		pendingAction = null;
		activeTab = "plagiarism";
		mobileTab = "plagiarism";
	}

	async function handleGuardProceed() {
		exportGuardOpen = false;
		const action = pendingAction;
		const kind = pendingExportKind;
		pendingAction = null;
		try {
			// Mark all remaining unreviewed pairs as ignored (persisted).
			if (submission) {
				await plagiarismStore.ignoreAllUnreviewed(submission.assignmentId);
			}
		} catch {
			addToast("error", "Could not mark plagiarism pairs as ignored", 4000);
			return;
		}
		if (action === "save") {
			await doSaveGrade();
		} else if (action === "export") {
			await doExport(kind);
		}
	}

	async function doSaveGrade() {
		if (!submission) return;
		try {
			const record = await submissionsStore.saveGrading(submission.id, {
				dimensions: { ...gradingInputs },
				feedback: selectionsToFeedback(categorySelections),
			});
			// Keep local state fresh: autofix existingNotes must reflect the merge.
			submission = {
				...submission,
				grading: (record as { grading?: SubmissionDetail["grading"] }).grading,
			};
			addToast("success", `Grade saved for ${submission.studentId}`, 3000);
		} catch (e) {
			addToast("error", e instanceof Error ? e.message : "Failed to save grade", 4000);
		}
	}

	function handleSaveGrade() {
		guardExport("Save Grade", () => void doSaveGrade());
	}

	async function doExport(kind: "student" | "teacher" = "student") {
		if (!submission) return;
		try {
			const { fileName, content } = await submissionsStore.export(submission.id, kind);
			// Client-side download of the grading YAML document.
			const blob = new Blob([content], { type: "text/yaml;charset=utf-8" });
			const url = URL.createObjectURL(blob);
			const link = document.createElement("a");
			link.href = url;
			link.download = fileName;
			link.click();
			URL.revokeObjectURL(url);
			addToast("success", `Exported ${fileName}`, 3000);
		} catch (e) {
			addToast("error", e instanceof Error ? e.message : "Failed to export", 4000);
		}
	}

	/**
	 * Export entry points (split button): primary click = student copy
	 * (default); the caret menu offers the teacher YAML variant. Both pass
	 * through the same P3-1 guard.
	 */
	function handleExport(kind: "student" | "teacher") {
		pendingExportKind = kind;
		guardExport("Export YAML", () => void doExport(kind));
	}

	/**
	 * Teacher-YAML import (3i): the header Import button opens a hidden file
	 * picker; the chosen `*-teacher.yaml` is imported through the store and
	 * applied to the page state (status/teacherGrade/grading), then the
	 * plagiarism pairs are reloaded (review statuses may have changed).
	 */
	async function handleImportFile(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = "";
		if (!file || !submission) return;
		try {
			const record = await submissionsStore.importTeacherYaml(
				submission.id,
				await file.text(),
			);
			submission = {
				...submission,
				status: record.status,
				teacherGrade: record.teacherGrade,
				grading: (record as { grading?: SubmissionDetail["grading"] }).grading,
			};
			// Badges/statuses may have changed — refresh the assignment's pairs.
			await plagiarismStore.load(submission.assignmentId);
			addToast("success", `Imported ${file.name}`, 3500);
		} catch (err) {
			addToast("error", err instanceof Error ? err.message : "Import failed", 5000);
		}
	}

	function handleSuggestGrade() {
		activeTab = "copilot";
		mobileTab = "copilot";
	}

	function handleDraftNotes() {
		activeTab = "copilot";
		mobileTab = "copilot";
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
	{@const rightTab: Tab = mobileTab === "cells" ? "rubric" : mobileTab}
	{@const sent = rubricSentimentCounts(rubric, categorySelections)}
	{@const mobUnreviewed = plagiarismStore.unreviewedCount(submission.studentId)}
	<div
		class="review-layout"
		class:is-dragging={isDragging}
		class:right-collapsed={rightPanelCollapsed}
		class:is-mobile={isMobile}
		bind:this={containerRef}
	>
		<!-- Mobile tab bar (P3-6): Cells | Rubric | Grade | Plagiarism | Copilot.
		     Icons hidden <420px via CSS so labels fit. -->
		{#if isMobile}
			<div class="mob-tab-bar">
				<button
					class="mob-tab"
					class:active={mobileTab === "cells"}
					onclick={() => handleMobileTabChange("cells")}
				>
					<Files size={12} />
					Cells
				</button>
				<button
					class="mob-tab"
					class:active={mobileTab === "rubric"}
					onclick={() => handleMobileTabChange("rubric")}
				>
					<ListChecks size={12} />
					Rubric
					<span class="tab-sent" title="Flagged rubric items by sentiment">
						<span class="sent-item sent-pos"
							><span class="sent-num">{sent.positive}</span></span
						>
						<span class="sent-item sent-neu"
							><span class="sent-num">{sent.neutral}</span></span
						>
						<span class="sent-item sent-neg"
							><span class="sent-num">{sent.negative}</span></span
						>
					</span>
				</button>
				<button
					class="mob-tab"
					class:active={mobileTab === "grading"}
					onclick={() => handleMobileTabChange("grading")}
				>
					<Gauge size={12} />
					Grade
					{#if gradeResult}
						<span class="tab-badge">{gradeResult.percentage.toFixed(0)}%</span>
					{/if}
				</button>
				<button
					class="mob-tab"
					class:active={mobileTab === "plagiarism"}
					onclick={() => handleMobileTabChange("plagiarism")}
				>
					<ShieldCheck size={12} />
					Plagiarism
					{#if mobUnreviewed > 0}
						<span class="tab-badge tab-badge-warn">{mobUnreviewed}</span>
					{/if}
				</button>
				<button
					class="mob-tab"
					class:active={mobileTab === "copilot"}
					onclick={() => handleMobileTabChange("copilot")}
				>
					<Sparkles size={12} />
					Copilot
				</button>
			</div>
		{/if}

		<!-- Left Panel: Cells (hidden on mobile while another tab is active) -->
		{#if !isMobile || mobileTab === "cells"}
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

						<!-- Collapse/expand right panel toggle (desktop only) -->
						{#if !isMobile}
							<button
								onclick={toggleRightPanel}
								class="toggle-panel-btn"
								aria-label={rightPanelCollapsed ? "Show panel" : "Hide panel"}
								title={rightPanelCollapsed
									? "Show grading panel"
									: "Hide grading panel"}
							>
								{#if rightPanelCollapsed}
									<PanelRightOpen size={16} />
								{:else}
									<PanelRightClose size={16} />
								{/if}
							</button>
						{/if}
					</div>
				</div>

				<!-- Reference comparison -->
				<ReferenceComparison
					submissionCells={cells}
					referenceCells={submission.referenceCells}
				/>

				<!-- Cell execution output -->
				<ExecutionOutput
					{cells}
					submissionId={submission.studentId}
					assignmentId={submission.assignmentId}
					existingNotes={submission.grading?.notes ?? ""}
				/>
			</div>
		{/if}

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

		<!-- Right Panel: Tabs (hidden when collapsed, or on mobile while the
		     Cells tab is active) -->
		{#if showRightPanel && (!isMobile || mobileTab !== "cells")}
			<aside class="right-panel">
				{#if gradingConfig}
					<RightPanelTabs
						activeTab={isMobile ? rightTab : activeTab}
						onTabChange={handleTabChange}
						dimensions={gradingConfig.dimensions}
						grading={gradingInputs}
						{gradeResult}
						{totalDeductions}
						onUpdateDimension={handleUpdateDimension}
						{rubric}
						sentimentCounts={sent}
						{categorySelections}
						onSelectionsChange={(next) => (categorySelections = next)}
						studentId={submission.studentId}
						assignmentId={submission.assignmentId}
						hideTabBar={isMobile}
					/>
				{/if}
			</aside>
		{/if}

		<!-- Mobile bottom bar (P3-6): grade mini + Export/Save — the ONLY
		     action location on mobile (header actions are hidden <sm). -->
		{#if isMobile}
			<div class="mob-bottom-bar">
				<div class="mob-bottom-grade-mini">
					<span>Grade:</span>
					<span class="mini-score"
						>{gradeResult ? gradeResult.percentage.toFixed(1) : "—"}</span
					>
					<span>/ 100</span>
					{#if gradeResult}
						<span class="mini-letter"
							>{gradeResult.grade.toFixed(1)} {gradeResult.label}</span
						>
					{/if}
				</div>
				<div class="mob-bottom-actions">
					{#snippet exportIcon()}
						<Download size={11} />
					{/snippet}
					<MenuButton
						label="Export"
						primaryOnClick={() => handleExport("student")}
						items={[
							{
								id: "teacher",
								label: "Export teacher YAML",
								description: "Full record + plagiarism audit (-teacher)",
								onclick: () => handleExport("teacher"),
							},
						]}
						icon={exportIcon}
						groupClass="mob-btn mob-btn-outline"
						variantClass="gap-1 px-2 py-0 text-xs font-medium"
					/>
					<button class="mob-btn mob-btn-primary" onclick={handleSaveGrade}>
						<Save size={11} />
						Save Grade
					</button>
				</div>
			</div>
		{/if}
	</div>

	<!-- Export guard modal (P3-1): unreviewed plagiarism pairs block
	     Save Grade / Export YAML until resolved or explicitly overridden. -->
	{#if exportGuardOpen}
		<div class="guard-modal" role="presentation">
			<div
				class="guard-modal-card"
				role="dialog"
				aria-modal="true"
				aria-label="Unreviewed plagiarism detections"
			>
				<div class="guard-modal-head">
					<TriangleAlert size={16} style="color: var(--destructive); flex-shrink: 0" />
					<h3>Unreviewed plagiarism detections</h3>
					<button
						class="guard-modal-close"
						aria-label="Close"
						onclick={() => (exportGuardOpen = false)}
					>
						<X size={14} />
					</button>
				</div>
				<p class="guard-modal-text">
					<strong>{unreviewedCount}</strong> potential plagiarism detection{unreviewedCount !==
					1
						? "s"
						: ""} ha{unreviewedCount !== 1 ? "ve" : "s"} not been reviewed yet.
					<strong>{exportGuardAction}</strong> anyway?
				</p>
				<p class="guard-counts">{guardCounts}</p>
				<div class="guard-modal-actions">
					<button class="btn-guard btn-guard-ghost" onclick={handleGuardGoReview}>
						Go to review
					</button>
					<button class="btn-guard btn-guard-primary" onclick={handleGuardProceed}>
						{exportGuardAction === "Save Grade" ? "Save anyway" : "Export anyway"}
					</button>
				</div>
			</div>
		</div>
	{/if}
{/if}

<!-- Hidden file picker for the header Import button (3i teacher YAML). -->
<input
	type="file"
	accept=".yaml,.yml,text/yaml"
	hidden
	bind:this={importInput}
	onchange={handleImportFile}
/>

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
			flex: 1 1 auto;
		}
		.review-layout.is-mobile .left-panel {
			border-right: none;
			flex: 1 1 auto !important;
		}
		/* Tighter submission header on mobile */
		.review-layout.is-mobile .left-panel > div:first-child {
			flex-wrap: wrap;
			gap: 8px;
			padding: 10px 12px;
		}
	}

	/* ── Mobile tab bar (P3-6) ── */
	.mob-tab-bar {
		display: flex;
		flex-shrink: 0;
		border-bottom: 1px solid var(--border);
		background: var(--card);
	}
	.mob-tab {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 5px;
		padding: 8px 3px;
		font-size: 11px;
		font-weight: 500;
		color: var(--muted-foreground);
		background: none;
		border: none;
		border-bottom: 2px solid transparent;
		cursor: pointer;
		white-space: nowrap;
		min-width: 0;
	}
	.mob-tab.active {
		color: var(--primary);
		font-weight: 600;
		border-bottom-color: var(--primary);
	}
	.mob-tab .tab-badge {
		font-size: 9px;
		padding: 0 4px;
		border-radius: 999px;
		background: color-mix(in oklch, var(--accent) 60%, transparent);
		color: var(--accent-foreground);
		font-weight: 700;
		font-variant-numeric: tabular-nums;
	}
	.mob-tab .tab-badge-warn {
		background: color-mix(in oklch, var(--destructive) 14%, transparent);
		color: var(--destructive);
		border: 1px solid color-mix(in oklch, var(--destructive) 30%, transparent);
	}
	.mob-tab .tab-sent {
		display: inline-flex;
		align-items: center;
		gap: 4px;
	}
	.mob-tab .sent-item {
		display: inline-flex;
		align-items: center;
	}
	.mob-tab .sent-num {
		font-size: 9px;
		font-weight: 700;
		font-variant-numeric: tabular-nums;
		line-height: 1;
	}
	.mob-tab .sent-pos .sent-num {
		color: var(--success);
	}
	.mob-tab .sent-neu .sent-num {
		color: var(--muted-foreground);
	}
	.mob-tab .sent-neg .sent-num {
		color: var(--destructive);
	}
	/* Icons hidden <420px so labels fit (P3-6). Lucide icons render <svg>
	   via components, so the selector needs :global for the analyzer. */
	@media (max-width: 420px) {
		.mob-tab {
			font-size: 10px;
			padding: 8px 2px;
			gap: 2px;
		}
		:global(.mob-tab svg) {
			display: none;
		}
	}

	/* ── Mobile bottom bar (P3-6) ── */
	.mob-bottom-bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		flex-shrink: 0;
		padding: 8px 12px;
		border-top: 1px solid var(--border);
		background: var(--card);
	}
	.mob-bottom-grade-mini {
		display: flex;
		align-items: baseline;
		gap: 4px;
		font-size: 11px;
		color: var(--muted-foreground);
		white-space: nowrap;
	}
	.mob-bottom-grade-mini .mini-score {
		font-size: 14px;
		font-weight: 700;
		color: var(--fg);
		font-variant-numeric: tabular-nums;
	}
	.mob-bottom-grade-mini .mini-letter {
		font-size: 11px;
		font-weight: 600;
		color: var(--fg);
	}
	.mob-bottom-actions {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.mob-btn {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		padding: 6px 12px;
		border-radius: var(--radius-md);
		font-size: 12px;
		font-weight: 500;
		cursor: pointer;
		white-space: nowrap;
		transition:
			background 0.15s,
			border-color 0.15s,
			opacity 0.15s;
	}
	/* Applied via MenuButton groupClass (component prop — analyzer can't see it). */
	:global(.mob-btn-outline) {
		background: transparent;
		border: 1px solid var(--border);
		color: var(--fg);
	}
	:global(.mob-btn-outline:hover) {
		background: color-mix(in oklch, var(--fg) 4%, transparent);
		border-color: var(--muted);
	}
	.mob-btn-primary {
		background: var(--accent);
		border: 1px solid var(--accent);
		color: var(--accent-on);
	}
	.mob-btn-primary:hover {
		background: var(--accent-hover);
		border-color: var(--accent-hover);
	}

	/* ── Export guard modal (P3-1) ── */
	.guard-modal {
		position: fixed;
		inset: 0;
		background: color-mix(in oklch, var(--bg) 55%, transparent);
		backdrop-filter: blur(2px);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 60;
		padding: 20px;
	}
	.guard-modal-card {
		width: 420px;
		max-width: calc(100vw - 40px);
		background: var(--card);
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		box-shadow: 0 16px 48px rgb(0 0 0 / 0.18);
		padding: 18px;
	}
	.guard-modal-head {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.guard-modal-head h3 {
		flex: 1;
		font-size: 14px;
		font-weight: 600;
		color: var(--fg);
	}
	.guard-modal-close {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 24px;
		height: 24px;
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: transparent;
		color: var(--muted-foreground);
		cursor: pointer;
	}
	.guard-modal-close:hover {
		background: var(--muted);
		color: var(--fg);
	}
	.guard-modal-text {
		margin-top: 12px;
		font-size: 13px;
		line-height: 1.5;
		color: var(--muted-foreground);
	}
	.guard-modal-text strong {
		color: var(--fg);
	}
	.guard-counts {
		margin-top: 8px;
		font-size: 12px;
		color: var(--muted-foreground);
		font-variant-numeric: tabular-nums;
	}
	.guard-modal-actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		margin-top: 16px;
	}
	.btn-guard {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		padding: 6px 14px;
		border-radius: var(--radius-md);
		font-size: 12px;
		font-weight: 500;
		cursor: pointer;
		transition:
			background 0.15s,
			border-color 0.15s;
	}
	.btn-guard-ghost {
		background: transparent;
		border: 1px solid var(--border);
		color: var(--fg);
	}
	.btn-guard-ghost:hover {
		background: color-mix(in oklch, var(--fg) 4%, transparent);
		border-color: var(--muted);
	}
	.btn-guard-primary {
		background: var(--accent);
		border: 1px solid var(--accent);
		color: var(--accent-on);
	}
	.btn-guard-primary:hover {
		background: var(--accent-hover);
		border-color: var(--accent-hover);
	}
</style>
