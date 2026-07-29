<script lang="ts">
	import type { GradeDimension, GradingInputs, GradeResult } from "$lib/types/grading.js";
	import type { MergedRubric } from "$lib/types/criteria.js";
	import type { CategorySelections } from "$lib/types/session.js";
	import GradingSidebar from "$lib/components/grading-sidebar.svelte";
	import RubricCategory from "$lib/components/rubric-category.svelte";
	import CopilotPanel from "./copilot-panel.svelte";

	type Tab = "rubric" | "grading" | "copilot";

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
		/** Current category selections. */
		categorySelections: Record<string, CategorySelections>;
		/** Whether grading is read-only. */
		disabled?: boolean;
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
		categorySelections,
		disabled = false,
	}: Props = $props();

	let gradePct = $derived(gradeResult?.percentage ?? 0);
	let expandedCategories = $state<Record<string, boolean>>({});

	function handleToggle(categoryKey: string) {
		expandedCategories = {
			...expandedCategories,
			[categoryKey]: !expandedCategories[categoryKey],
		};
	}

	function handleToggleCheckbox(_key: string, _checked: boolean) {
		// Phase 2 stub
	}

	function handleUpdateComment(_key: string, _value: string) {
		// Phase 2 stub
	}

	function handleUpdateDeduction(_key: string, _value: number) {
		// Phase 2 stub
	}

	function handleUpdateNotes(_value: string) {
		// Phase 2 stub
	}
</script>

<div class="right-panel-tabs">
	<div class="tab-bar">
		<button
			class="tab"
			class:active={activeTab === "rubric"}
			onclick={() => onTabChange("rubric")}
		>
			Rubric
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
			class:active={activeTab === "copilot"}
			onclick={() => onTabChange("copilot")}
		>
			Copilot
		</button>
	</div>

	<div class="tab-content">
		{#if activeTab === "rubric"}
			<div class="rubric-scroll">
				{#if rubric && rubric.categories.length > 0}
					{#each rubric.categories as entry (entry.key)}
					{@const expanded = expandedCategories[entry.key] ?? false}
					<RubricCategory
						{entry}
						selections={categorySelections[entry.key] ?? { checked_items: new Set(), comments: {}, deductions: {}, notes: "" }}
						{expanded}
						onToggle={() => handleToggle(entry.key)}
						onToggleCheckbox={handleToggleCheckbox}
						onUpdateComment={handleUpdateComment}
						onUpdateDeduction={handleUpdateDeduction}
						onUpdateNotes={handleUpdateNotes}
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
		transition: color 0.15s, background 0.15s;
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
