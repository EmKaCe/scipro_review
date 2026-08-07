<script lang="ts">
	import type { ReviewMetaFull } from "$lib/services/db.js";
	import type { Assignment } from "$lib/types/assignments.js";
	import { SvelteSet } from "svelte/reactivity";
	import ReviewsTable from "$lib/components/reviews-table.svelte";
	import EmptyState from "$lib/components/ui/empty-state.svelte";
	import ChevronDown from "@lucide/svelte/icons/chevron-down";
	import Search from "@lucide/svelte/icons/search";
	import Trash2 from "@lucide/svelte/icons/trash-2";
	import Inbox from "@lucide/svelte/icons/inbox";
	import { Tooltip, TooltipTrigger, TooltipContent } from "$lib/components/ui/tooltip/index.js";

	/** Props for the saved reviews list with search, filter, and bulk actions. */
	interface Props {
		/** All saved reviews to display. */
		reviews: ReviewMetaFull[];
		/** Available assignments for resolving human-readable titles. */
		assignments: readonly Assignment[];
		/** Callback invoked when a review is opened for editing. */
		onOpen: (id: string) => void;
		/** Callback invoked when a single review is deleted. */
		onDelete: (id: string) => void;
		/** Callback invoked when multiple reviews are bulk-deleted. */
		onBulkDelete: (ids: string[]) => void;
	}

	let {
		reviews,
		assignments: assignmentRegistry,
		onOpen,
		onDelete,
		onBulkDelete,
	}: Props = $props();

	/** Map of assignment ID → human-readable title for display. */
	let assignmentTitles = $derived(new Map(assignmentRegistry.map((a) => [a.id, a.title])));

	let searchQuery = $state("");
	let filterSemester = $state("");
	let filterAssignment = $state("");
	let sortColumn = $state<string | null>(null);
	let sortDirection = $state<"asc" | "desc">("asc");
	let selectedRows = new SvelteSet<string>();
	let isCollapsed = $state(false);

	let filteredReviews = $derived.by(() => {
		let result = reviews.filter((r) => {
			const matchSemester = !filterSemester || r.semester === filterSemester;
			const matchAssignment = !filterAssignment || r.assignment_id === filterAssignment;
			const matchSearch =
				!searchQuery ||
				r.student_id.toLowerCase().includes(searchQuery.toLowerCase()) ||
				r.assignment_id.toLowerCase().includes(searchQuery.toLowerCase());
			return matchSemester && matchAssignment && matchSearch;
		});

		if (sortColumn) {
			const col = sortColumn;
			result = [...result].sort((a, b) => {
				const aVal = a[col as keyof ReviewMetaFull];
				const bVal = b[col as keyof ReviewMetaFull];

				if (typeof aVal === "string" && typeof bVal === "string") {
					const cmp = aVal.toLowerCase().localeCompare(bVal.toLowerCase());
					return sortDirection === "asc" ? cmp : -cmp;
				}

				if (typeof aVal === "number" && typeof bVal === "number") {
					return sortDirection === "asc" ? aVal - bVal : bVal - aVal;
				}

				return 0;
			});
		}

		return result;
	});

	// Clear hidden selections when filters change
	$effect(() => {
		// Track filter changes reactively
		void searchQuery;
		void filterSemester;
		void filterAssignment;
		for (const id of selectedRows) {
			if (!filteredReviews.some((r) => r.id === id)) {
				selectedRows.delete(id);
			}
		}
	});

	let semesters = $derived([...new Set(reviews.map((r) => r.semester))].sort().reverse());

	let assignments = $derived([...new Set(reviews.map((r) => r.assignment_id))].sort());

	let selectedCount = $derived(
		[...selectedRows].filter((id) => filteredReviews.some((r) => r.id === id)).length,
	);

	function handleSort(column: string) {
		if (sortColumn === column) {
			sortDirection = sortDirection === "asc" ? "desc" : "asc";
		} else {
			sortColumn = column;
			sortDirection = "asc";
		}
	}

	function handleToggleRow(id: string) {
		if (selectedRows.has(id)) {
			selectedRows.delete(id);
		} else {
			selectedRows.add(id);
		}
	}

	function handleToggleAll(checked: boolean) {
		if (checked) {
			filteredReviews.forEach((r) => selectedRows.add(r.id));
		} else {
			filteredReviews.forEach((r) => selectedRows.delete(r.id));
		}
	}

	function handleBulkDelete() {
		const ids = [...selectedRows].filter((id) => reviews.some((r) => r.id === id));
		onBulkDelete(ids);
		selectedRows.clear();
	}
</script>

<div>
	<!-- Header -->
	<div class="mb-4 flex items-center gap-3">
		<h2 class="text-lg font-semibold tracking-tight">Saved Reviews</h2>
		<span
			class="inline-flex items-center rounded-full border border-border bg-background px-2.5 py-0.5 text-xs font-medium text-foreground"
		>
			{filteredReviews.length}
		</span>
		<Tooltip>
			<TooltipTrigger
				class="ml-auto flex h-8 w-8 items-center justify-center rounded-[var(--radius)] text-muted-foreground transition-colors hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10"
				aria-label="Toggle section"
				aria-expanded={!isCollapsed}
				aria-controls="saved-reviews-content"
				onclick={() => (isCollapsed = !isCollapsed)}
			>
				<ChevronDown
					size={16}
					class="transition-transform duration-200 {isCollapsed ? 'rotate-180' : ''}"
				/>
			</TooltipTrigger>
			<TooltipContent
				>{isCollapsed ? "Expand saved reviews" : "Collapse saved reviews"}</TooltipContent
			>
		</Tooltip>
	</div>

	{#if !isCollapsed}
		<div id="saved-reviews-content" class="space-y-4">
			<!-- Filter Bar -->
			<div class="flex flex-col gap-3 sm:flex-row">
				<select
					bind:value={filterSemester}
					class="h-9 rounded-[var(--radius)] border border-border bg-background px-3 text-sm text-foreground focus:ring-2 focus:ring-ring focus:outline-none sm:w-36"
				>
					<option value="">All Semesters</option>
					{#each semesters as s (s)}
						<option value={s}>{s}</option>
					{/each}
				</select>
				<select
					bind:value={filterAssignment}
					class="h-9 rounded-[var(--radius)] border border-border bg-background px-3 text-sm text-foreground focus:ring-2 focus:ring-ring focus:outline-none sm:w-56"
				>
					<option value="">All Assignments</option>
					{#each assignments as a (a)}
						<option value={a}>{a}</option>
					{/each}
				</select>
				<div class="relative flex-1">
					<Search
						size={14}
						class="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground"
					/>
					<input
						type="text"
						placeholder="Search..."
						bind:value={searchQuery}
						class="h-9 w-full rounded-[var(--radius)] border border-border bg-background pr-3 pl-9 text-sm text-foreground focus:ring-2 focus:ring-ring focus:outline-none"
					/>
				</div>
			</div>

			<!-- Bulk Actions Bar -->
			{#if selectedCount > 0}
				<div
					class="flex items-center justify-between rounded-[var(--radius)] border border-border bg-background p-3"
				>
					<span class="text-sm"
						>{selectedCount} review{selectedCount !== 1 ? "s" : ""} selected</span
					>
					<button
						onclick={handleBulkDelete}
						class="flex h-8 items-center gap-1.5 rounded-[var(--radius)] bg-destructive px-3 text-sm font-medium text-white transition-opacity hover:opacity-90"
					>
						<Trash2 size={14} />
						Delete selected
					</button>
				</div>
			{/if}

			<!-- Table or Empty State -->
			{#if filteredReviews.length > 0}
				<ReviewsTable
					reviews={filteredReviews}
					{assignmentTitles}
					{selectedRows}
					{sortColumn}
					{sortDirection}
					onSort={handleSort}
					onToggleRow={handleToggleRow}
					onToggleAll={handleToggleAll}
					{onOpen}
					{onDelete}
				/>
			{:else}
				<EmptyState
					title="No saved reviews yet"
					description="Start a new review to see it here."
				>
					{#snippet icon()}
						<Inbox size={40} />
					{/snippet}
				</EmptyState>
			{/if}
		</div>
	{/if}
</div>
