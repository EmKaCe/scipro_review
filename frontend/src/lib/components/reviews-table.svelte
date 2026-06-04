<script lang="ts">
	import type { ReviewMetaFull } from "$lib/services/db.js";
	import CustomCheckbox from "$lib/components/ui/custom-checkbox.svelte";
	import ProgressBar from "$lib/components/ui/progress-bar.svelte";
	import GradeBadge from "$lib/components/ui/grade-badge.svelte";
	import Trash2 from "@lucide/svelte/icons/trash-2";

	/** Props for the reviews data table with sorting and selection. */
	interface Props {
		/** Reviews to display in the table. */
		reviews: ReviewMetaFull[];
		/** Map of assignment ID → human-readable title for display. */
		assignmentTitles: Map<string, string>;
		/** Set of currently selected row IDs. */
		selectedRows: Set<string>;
		/** Column key currently used for sorting, or null. */
		sortColumn: string | null;
		/** Current sort direction. */
		sortDirection: "asc" | "desc";
		/** Callback to change the sort column and direction. */
		onSort: (column: string) => void;
		/** Callback to toggle a single row's selection. */
		onToggleRow: (id: string) => void;
		/** Callback to toggle all rows' selection. */
		onToggleAll: (checked: boolean) => void;
		/** Callback to open a review for editing. */
		onOpen: (id: string) => void;
		/** Callback to delete a review. */
		onDelete: (id: string) => void;
	}

	let {
		reviews,
		assignmentTitles,
		selectedRows,
		sortColumn,
		sortDirection,
		onSort,
		onToggleRow,
		onToggleAll,
		onOpen,
		onDelete,
	}: Props = $props();

	let allSelected = $derived(reviews.length > 0 && reviews.every((r) => selectedRows.has(r.id)));

	function sortIndicator(column: string): string {
		if (sortColumn !== column) return "↕";
		return sortDirection === "asc" ? "↑" : "↓";
	}

	/** Format an ISO date string for display. */
	function formatDate(iso: string): string {
		try {
			const d = new Date(iso);
			const now = new Date();
			const diffMs = now.getTime() - d.getTime();
			const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
			const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
			if (diffHours < 1) return "just now";
			if (diffHours < 24) return `${diffHours}h ago`;
			if (diffDays < 7) return `${diffDays}d ago`;
			return d.toLocaleDateString();
		} catch {
			return iso;
		}
	}
</script>

<div class="overflow-hidden rounded-[var(--radius)] border border-border">
	<div class="overflow-x-auto">
		<table class="w-full text-left text-sm">
			<thead class="border-b border-border bg-background">
				<tr>
					<th class="w-10 p-2 sm:p-3">
						<CustomCheckbox
							checked={allSelected}
							onchange={() => onToggleAll(!allSelected)}
						/>
					</th>
					{#each [{ key: "student_id", label: "Student ID" }, { key: "assignment_id", label: "Assignment" }, { key: "progress", label: "Progress" }, { key: "grade", label: "Grade" }, { key: "updated_at", label: "Updated" }] as col (col.key)}
						<th
							aria-sort={sortColumn === col.key
								? sortDirection === "asc"
									? "ascending"
									: "descending"
								: "none"}
							class="group cursor-pointer p-2 font-medium text-foreground select-none sm:p-3 {col.key ===
								'assignment_id' || col.key === 'updated_at'
								? 'hidden sm:table-cell'
								: ''}"
						>
							<button class="flex items-center gap-1" onclick={() => onSort(col.key)}>
								{col.label}
								<span
									class="text-muted-foreground transition-colors group-hover:text-foreground"
								>
									{sortIndicator(col.key)}
								</span>
								<span class="sr-only"
									>{sortColumn === col.key
										? sortDirection === "asc"
											? "sorted ascending"
											: "sorted descending"
										: "not sorted"}</span
								>
							</button>
						</th>
					{/each}
					<th class="p-3 font-medium text-foreground">Actions</th>
				</tr>
			</thead>
			<tbody class="divide-y divide-border bg-card">
				{#each reviews as r (r.id)}
					<tr class="transition-colors hover:bg-black/[0.02] dark:hover:bg-white/[0.02]">
						<td class="p-2 sm:p-3">
							<CustomCheckbox
								checked={selectedRows.has(r.id)}
								onchange={() => onToggleRow(r.id)}
							/>
						</td>
						<td class="p-2 font-medium whitespace-nowrap text-foreground sm:p-3"
							>{r.student_id}</td
						>
						<td class="hidden p-3 whitespace-nowrap text-foreground sm:table-cell"
							>{assignmentTitles.get(r.assignment_id) ?? r.assignment_id}</td
						>
						<td class="p-2 sm:p-3">
							<div class="flex items-center gap-2">
								<ProgressBar value={r.progress} />
								<span class="w-8 text-right text-xs text-muted-foreground"
									>{r.progress}%</span
								>
							</div>
						</td>
						<td class="p-2 sm:p-3">
							<GradeBadge grade={r.grade.toFixed(1)} usGrade={r.us_equiv || "—"} />
						</td>
						<td class="hidden p-3 whitespace-nowrap text-muted-foreground sm:table-cell"
							>{formatDate(r.updated_at)}</td
						>
						<td class="p-2 sm:p-3">
							<div class="flex items-center gap-1">
								<button
									class="h-8 min-h-[44px] rounded-[var(--radius)] border border-primary px-2.5 text-xs font-medium text-primary transition-colors hover:bg-primary/5 sm:h-7 sm:min-h-0"
									onclick={() => onOpen(r.id)}
								>
									Open
								</button>
								<button
									class="flex h-8 min-h-[44px] w-8 min-w-[44px] items-center justify-center rounded-[var(--radius)] text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive sm:h-7 sm:min-h-0 sm:w-7 sm:min-w-0"
									onclick={() => onDelete(r.id)}
									aria-label="Delete review"
								>
									<Trash2 size={14} />
								</button>
							</div>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
</div>
