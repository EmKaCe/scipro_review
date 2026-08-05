<script lang="ts">
	/**
	 * Test harness for right-panel-tabs.svelte: owns `categorySelections`
	 * state and wires the component's `onSelectionsChange` callback back into
	 * (the controlled-component pattern the real page uses), so tests can
	 * assert that rubric checkbox/comment/deduction/notes edits flow back up.
	 * Also computes the sentiment counts from local state
	 * and passes them down as the `sentimentCounts` prop.
	 */
	import RightPanelTabs from "$lib/components/submissions/right-panel-tabs.svelte";
	import type { ComponentProps } from "svelte";
	import type { CategorySelections } from "$lib/types/session.js";
	import { rubricSentimentCounts } from "$lib/types/criteria.js";

	/** RightPanelTabs props minus the two owned here. */
	type PanelProps = Omit<
		ComponentProps<typeof RightPanelTabs>,
		"categorySelections" | "sentimentCounts" | "onSelectionsChange"
	>;

	let {
		activeTab,
		onTabChange,
		dimensions,
		grading,
		gradeResult,
		totalDeductions,
		onUpdateDimension,
		rubric,
		studentId,
		assignmentId,
		disabled = false,
		hideTabBar = false,
	}: PanelProps = $props();

	let categorySelections: Record<string, CategorySelections> = $state({});

	let sentimentCounts = $derived(rubricSentimentCounts(rubric, categorySelections));

	function handleSelectionsChange(next: Record<string, CategorySelections>) {
		categorySelections = next;
	}

	export { categorySelections };
</script>

<RightPanelTabs
	{activeTab}
	{onTabChange}
	{dimensions}
	{grading}
	{gradeResult}
	{totalDeductions}
	{onUpdateDimension}
	{rubric}
	{sentimentCounts}
	{categorySelections}
	onSelectionsChange={handleSelectionsChange}
	{studentId}
	{assignmentId}
	{disabled}
	{hideTabBar}
/>
