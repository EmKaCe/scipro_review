<script lang="ts">
	import type { GradeDimension, GradingInputs, GradeResult } from "$lib/types/grading.js";
	import type { MergedRubric } from "$lib/types/criteria.js";
	import type { CategorySelections } from "$lib/types/session.js";
	import GradingSidebar from "$lib/components/grading-sidebar.svelte";
	import RubricCategory from "$lib/components/rubric-category.svelte";
	import CopilotPanel from "./copilot-panel.svelte";
	import PlagiarismTab from "./plagiarism-tab.svelte";
	import { plagiarismStore } from "$lib/services/plagiarism-store.svelte.js";
	import ShieldCheck from "@lucide/svelte/icons/shield-check";
	import { findCategoryEntry, rubricSentimentCounts } from "$lib/types/criteria.js";
	import { SvelteSet } from "svelte/reactivity";

	type Tab = "rubric" | "grading" | "plagiarism" | "copilot";

	interface Props {
		/** Currently active tab. */
		activeTab: Tab;
		/** Callback when a tab is selected. */
		onTabChange: (tab: Tab) => void;
		/** Grading dimension definitions. */
		dimensions: readonly GradeDimension[];
		/** Current grading inputs. */
		grading: GradingInputs;
		/** Computed grade result. */
		gradeResult: GradeResult | null;
		/** Total deduction points. */
		totalDeductions: number;
		/** Callback when a dimension score changes. */
		onUpdateDimension: (key: string, value: number) => void;
		/** Merged rubric with categories. */
		rubric: MergedRubric | null;
		/** Current category selections (bindable — checkbox toggles update it). */
		categorySelections: Record<string, CategorySelections>;
		/** Current submission id — plagiarism badge/pairs are scoped to it. */
		studentId: string;
		/** Assignment the submission belongs to. */
		assignmentId: string;
		/** Whether grading is read-only. */
		disabled?: boolean;
		/** Hide the component's own tab bar (the parent renders it — mobile). */
		hideTabBar?: boolean;
	}

	let {
		activeTab,
		onTabChange,
		dimensions,
		grading,
		gradeResult,
		totalDeductions,
		onUpdateDimension,
		rubric,
		categorySelections = $bindable(),
		studentId,
		assignmentId,
		disabled = false,
		hideTabBar = false,
	}: Props = $props();

	let gradePct = $derived(gradeResult?.percentage ?? 0);
	let expandedCategories = $state<Record<string, boolean>>({});

	/** Unreviewed pairs involving this submission — tab badge (P3-1). */
	let unreviewed = $derived(plagiarismStore.unreviewedCount(studentId));

	/** Live sentiment counts of checked rubric items (P3-2). */
	let sentiment = $derived(rubricSentimentCounts(rubric, categorySelections));

	function handleToggle(categoryKey: string) {
		expandedCategories = {
			...expandedCategories,
			[categoryKey]: !expandedCategories[categoryKey],
		};
	}

	/** Empty per-category selection state (SvelteSet + empty maps). */
	function emptySelections(): CategorySelections {
		return {
			checked_items: new SvelteSet<string>(),
			notes: "",
			comments: {},
			deductions: {},
		};
	}

	/**
	 * Toggle a rubric checkbox (key = sub-point text). Updates the owning
	 * category's `checked_items` immutably — this drives the live sentiment
	 * counts (P3-2) in the tab header.
	 */
	function handleToggleCheckbox(key: string, checked: boolean) {
		const entry = findCategoryEntry(rubric, key);
		if (!entry) return;
		const current = categorySelections[entry.key] ?? emptySelections();
		const nextItems = new SvelteSet(current.checked_items);
		if (checked) {
			nextItems.add(key);
		} else {
			nextItems.delete(key);
		}
		categorySelections = {
			...categorySelections,
			[entry.key]: { ...current, checked_items: nextItems },
		};
	}

	/**
	 * Update an inline comment for a sub-point (key = sub-point text),
	 * writing into the owning category's `comments` map immutably.
	 */
	function handleUpdateComment(key: string, value: string) {
		const entry = findCategoryEntry(rubric, key);
		if (!entry) return;
		const current = categorySelections[entry.key] ?? emptySelections();
		categorySelections = {
			...categorySelections,
			[entry.key]: { ...current, comments: { ...current.comments, [key]: value } },
		};
	}

	/**
	 * Update a point deduction for a sub-point (key = sub-point text),
	 * writing into the owning category's `deductions` map immutably.
	 */
	function handleUpdateDeduction(key: string, value: number) {
		const entry = findCategoryEntry(rubric, key);
		if (!entry) return;
		const current = categorySelections[entry.key] ?? emptySelections();
		categorySelections = {
			...categorySelections,
			[entry.key]: { ...current, deductions: { ...current.deductions, [key]: value } },
		};
	}

	/**
	 * Update a category's additional notes (key = category key — the
	 * RubricCategory call site binds `entry.key` before forwarding).
	 */
	function handleUpdateNotes(categoryKey: string, value: string) {
		const current = categorySelections[categoryKey] ?? emptySelections();
		categorySelections = {
			...categorySelections,
			[categoryKey]: { ...current, notes: value },
		};
	}
</script>

<div class="right-panel-tabs">
	{#if !hideTabBar}
		<div class="tab-bar">
			<button
				class="tab"
				class:active={activeTab === "rubric"}
				onclick={() => onTabChange("rubric")}
			>
				Rubric
				<!-- Sentiment counts: positive / neutral / negative items flagged
			     (checked) for this submission — live from checkbox state (P3-2). -->
				<span class="tab-sent" title="Flagged rubric items by sentiment">
					<span class="sent-item sent-pos"
						><span class="sent-num">{sentiment.positive}</span></span
					>
					<span class="sent-item sent-neu"
						><span class="sent-num">{sentiment.neutral}</span></span
					>
					<span class="sent-item sent-neg"
						><span class="sent-num">{sentiment.negative}</span></span
					>
				</span>
			</button>
			<button
				class="tab"
				class:active={activeTab === "grading"}
				onclick={() => onTabChange("grading")}
			>
				Grading
				{#if gradeResult}
					<span class="tab-badge">{gradePct.toFixed(0)}%</span>
				{/if}
			</button>
			<button
				class="tab"
				class:active={activeTab === "plagiarism"}
				onclick={() => onTabChange("plagiarism")}
			>
				<ShieldCheck size={12} />
				Plagiarism
				{#if unreviewed > 0}
					<span class="tab-badge tab-badge-warn">{unreviewed}</span>
				{/if}
			</button>
			<button
				class="tab"
				class:active={activeTab === "copilot"}
				onclick={() => onTabChange("copilot")}
			>
				Copilot
			</button>
		</div>
	{/if}

	<div class="tab-content">
		{#if activeTab === "rubric"}
			<div class="rubric-scroll">
				{#if rubric && rubric.categories.length > 0}
					{#each rubric.categories as entry (entry.key)}
						{@const expanded = expandedCategories[entry.key] ?? false}
						<RubricCategory
							{entry}
							selections={categorySelections[entry.key] ?? emptySelections()}
							{expanded}
							onToggle={() => handleToggle(entry.key)}
							onToggleCheckbox={handleToggleCheckbox}
							onUpdateComment={handleUpdateComment}
							onUpdateDeduction={handleUpdateDeduction}
							onUpdateNotes={(v) => handleUpdateNotes(entry.key, v)}
							{disabled}
						/>
					{/each}
				{:else}
					<p class="empty-rubric">No rubric loaded for this assignment.</p>
				{/if}
			</div>
		{:else if activeTab === "grading"}
			<div class="grading-wrapper">
				<GradingSidebar
					{dimensions}
					{grading}
					{gradeResult}
					{totalDeductions}
					{disabled}
					{onUpdateDimension}
				/>
			</div>
		{:else if activeTab === "plagiarism"}
			<PlagiarismTab {studentId} {assignmentId} />
		{:else if activeTab === "copilot"}
			<CopilotPanel />
		{/if}
	</div>
</div>

<style>
	.right-panel-tabs {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
		overflow: hidden;
	}
	.tab-bar {
		display: flex;
		border-bottom: 1px solid var(--border);
		flex-shrink: 0;
		background: var(--card);
	}
	.tab {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		padding: 10px 8px;
		font-size: 13px;
		font-weight: 500;
		color: var(--muted-foreground);
		background: none;
		border: none;
		cursor: pointer;
		transition:
			color 0.15s,
			background 0.15s;
		position: relative;
	}
	.tab:hover {
		color: var(--foreground);
		background: var(--muted);
	}
	.tab.active {
		color: var(--primary);
		font-weight: 600;
	}
	.tab.active::after {
		content: "";
		position: absolute;
		bottom: -1px;
		left: 0;
		right: 0;
		height: 2px;
		background: var(--primary);
	}
	.tab-badge {
		font-size: 10px;
		padding: 1px 5px;
		border-radius: 999px;
		background: color-mix(in oklch, var(--accent) 60%, transparent);
		color: var(--accent-foreground);
		font-weight: 600;
	}
	/* Plagiarism badge: destructive tint (unreviewed count, P3-1). */
	.tab-badge-warn {
		background: color-mix(in oklch, var(--destructive) 14%, transparent);
		color: var(--destructive);
		border: 1px solid color-mix(in oklch, var(--destructive) 30%, transparent);
	}
	/* Sentiment counts in the Rubric tab header (P3-2). */
	.tab-sent {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		margin-left: 2px;
	}
	.sent-item {
		display: inline-flex;
		align-items: center;
		gap: 3px;
	}
	.sent-num {
		font-size: 10px;
		font-weight: 700;
		font-variant-numeric: tabular-nums;
		line-height: 1;
	}
	.sent-pos .sent-num {
		color: var(--success);
	}
	.sent-neu .sent-num {
		color: var(--muted-foreground);
	}
	.sent-neg .sent-num {
		color: var(--destructive);
	}
	.tab-content {
		flex: 1;
		overflow-y: auto;
	}
	.rubric-scroll {
		padding: 4px;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.empty-rubric {
		text-align: center;
		padding: 40px 16px;
		color: var(--muted-foreground);
		font-size: 13px;
	}
	.grading-wrapper {
		padding: 12px;
	}
</style>
