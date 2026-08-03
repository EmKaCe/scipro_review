<script lang="ts">
	/**
	 * Test harness for right-panel-tabs.svelte: binds the component's
	 * `categorySelections` prop to local state and exports it, so tests can
	 * assert that rubric comment/deduction/notes edits flow back through the
	 * bindable prop (Phase 3f A4).
	 */
	import RightPanelTabs from "$lib/components/submissions/right-panel-tabs.svelte";
	import type { ComponentProps } from "svelte";
	import type { CategorySelections } from "$lib/types/session.js";

	/** RightPanelTabs props minus the bindable `categorySelections` (owned here). */
	type PanelProps = Omit<ComponentProps<typeof RightPanelTabs>, "categorySelections">;

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
	bind:categorySelections
	{studentId}
	{assignmentId}
	{disabled}
	{hideTabBar}
/>
