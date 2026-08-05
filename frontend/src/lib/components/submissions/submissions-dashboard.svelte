<script lang="ts">
	import { base } from "$app/paths";
	import type { SubmissionMeta } from "$lib/types/submissions.js";
	import { plagiarismStore } from "$lib/services/plagiarism-store.svelte.js";
	import { statusConfig } from "$lib/components/submissions/status-config.js";
	import ArrowRight from "@lucide/svelte/icons/arrow-right";
	import Search from "@lucide/svelte/icons/search";
	import Upload from "@lucide/svelte/icons/upload";
	import ShieldCheck from "@lucide/svelte/icons/shield-check";
	import SortArrow from "$lib/components/submissions/sort-arrow.svelte";
	import PlagiarismModal from "$lib/components/submissions/plagiarism-modal.svelte";

	interface Props {
		submissions: readonly SubmissionMeta[];
		searchQuery: string;
		statusFilter: string;
		/** Active assignment — plagiarism results are scoped to it. */
		assignmentId: string;
		onSearchChange: (q: string) => void;
		onStatusFilterChange: (f: string) => void;
		/** Archive (soft-hide) or restore a submission. */
		onArchive: (id: string, action: "archive" | "restore") => void;
		/** Permanently delete a submission (caller confirms first). */
		onDelete: (id: string) => void;
	}

	let {
		submissions,
		searchQuery,
		statusFilter,
		assignmentId,
		onSearchChange,
		onStatusFilterChange,
		onArchive,
		onDelete,
	}: Props = $props();

	// ── Plagiarism modal + badge (P3-1) ──
	let plagiarismModalOpen = $state(false);

	// Load the cached plagiarism result whenever the assignment changes
	// (404 → store stays empty; the modal offers "Run check").
	$effect(() => {
		plagiarismStore.load(assignmentId).catch(() => {
			// 404 and network errors are surfaced inside the modal; the
			// dashboard badge just stays hidden.
		});
	});

	/** Unreviewed pairs across the assignment — badge count. */
	let unreviewed = $derived(plagiarismStore.unreviewedCount());

	// ── Filtered list ──
	let filtered = $derived(
		submissions.filter((s) => {
			// Archived rows are hidden unless the "Archived" filter is active.
			if (s.status === "archived" && statusFilter !== "archived") return false;
			if (statusFilter !== "all" && s.status !== statusFilter) return false;
			if (searchQuery && !s.studentId.toLowerCase().includes(searchQuery.toLowerCase()))
				return false;
			return true;
		}),
	);

	// ── Sort state ──
	type SortKey = "studentId" | "status" | "cellSummary" | "preEvalGrade" | "teacherGrade";
	let sortKey = $state<SortKey>("studentId");
	let sortAsc = $state(true);

	/** Extract the sortable value for the current sort key (same type for both rows). */
	function sortValue(s: SubmissionMeta): string | number {
		switch (sortKey) {
			case "status":
				return s.status;
			case "cellSummary":
				return s.cellSummary ?? "";
			case "preEvalGrade":
				return s.preEvalGrade ?? -1;
			case "teacherGrade":
				return s.teacherGrade ?? -1;
			default:
				return s.studentId;
		}
	}

	/** Compare two sort values: numbers numerically, strings lexically. */
	function compareValues(x: string | number, y: string | number): number {
		if (typeof x === "number" && typeof y === "number") return x - y;
		return String(x).localeCompare(String(y));
	}

	let sorted = $derived.by(() => {
		const arr = [...filtered];
		arr.sort((a, b) => {
			const cmp = compareValues(sortValue(a), sortValue(b));
			return sortAsc ? cmp : -cmp;
		});
		return arr;
	});

	function toggleSort(key: SortKey) {
		if (sortKey === key) {
			sortAsc = !sortAsc;
		} else {
			sortKey = key;
			sortAsc = true;
		}
	}

	// sortArrow replaced by SortArrow component

	// ── Status display config: shared module (page header chip uses it too) ──

	function gradeDisplay(meta: SubmissionMeta): string {
		if (meta.teacherGrade != null) return meta.teacherGrade.toFixed(1);
		if (meta.preEvalGrade != null) return `(${meta.preEvalGrade.toFixed(1)})`;
		return "—";
	}
</script>

<div class="dashboard-table-container">
	<!-- Toolbar: search + filter + plagiarism -->
	<div class="table-toolbar">
		<div class="search-row">
			<Search size={14} class="search-icon" />
			<input
				type="text"
				class="search-input"
				placeholder="Search by student ID..."
				value={searchQuery}
				oninput={(e) => onSearchChange(e.currentTarget.value)}
			/>
		</div>
		<select
			class="filter-select"
			value={statusFilter}
			onchange={(e) => onStatusFilterChange(e.currentTarget.value)}
		>
			<option value="all">Status: All</option>
			<option value="pending">Pending</option>
			<option value="executing">Executing</option>
			<option value="executed">Executed</option>
			<option value="error">Error</option>
			<option value="pre-evaluated">Pre-evaluated</option>
			<option value="graded">Graded</option>
			<option value="archived">Archived</option>
		</select>
		<div class="toolbar-actions">
			<button class="btn-plagiarism" onclick={() => (plagiarismModalOpen = true)}>
				<ShieldCheck size={13} />
				Plagiarism
				{#if unreviewed > 0}
					<span class="plagiarism-count-badge">{unreviewed}</span>
				{/if}
			</button>
		</div>
	</div>

	<!-- Table -->
	<div class="table-scroll">
		<table class="submissions-table">
			<thead>
				<tr>
					<th
						class="col-id"
						onclick={() => toggleSort("studentId")}
						role="button"
						tabindex="0"
						onkeydown={(e) => e.key === "Enter" && toggleSort("studentId")}
					>
						Student
						<SortArrow
							currentKey={sortKey}
							targetKey="studentId"
							ascending={sortAsc}
							size={10}
							class="sort-arrow-icon"
						/>
					</th>
					<th
						class="col-status"
						onclick={() => toggleSort("status")}
						role="button"
						tabindex="0"
						onkeydown={(e) => e.key === "Enter" && toggleSort("status")}
					>
						Status
						<SortArrow
							currentKey={sortKey}
							targetKey="status"
							ascending={sortAsc}
							size={10}
							class="sort-arrow-icon"
						/>
					</th>
					<th
						class="col-cells"
						onclick={() => toggleSort("cellSummary")}
						role="button"
						tabindex="0"
						onkeydown={(e) => e.key === "Enter" && toggleSort("cellSummary")}
					>
						Cells <SortArrow
							currentKey={sortKey}
							targetKey="cellSummary"
							ascending={sortAsc}
							size={10}
							class="sort-arrow-icon"
						/>
					</th>
					<th
						class="col-preeval"
						onclick={() => toggleSort("preEvalGrade")}
						role="button"
						tabindex="0"
						onkeydown={(e) => e.key === "Enter" && toggleSort("preEvalGrade")}
					>
						Pre-Eval <SortArrow
							currentKey={sortKey}
							targetKey="preEvalGrade"
							ascending={sortAsc}
							size={10}
							class="sort-arrow-icon"
						/>
					</th>
					<th
						class="col-grade"
						onclick={() => toggleSort("teacherGrade")}
						role="button"
						tabindex="0"
						onkeydown={(e) => e.key === "Enter" && toggleSort("teacherGrade")}
					>
						Grade <SortArrow
							currentKey={sortKey}
							targetKey="teacherGrade"
							ascending={sortAsc}
							size={10}
							class="sort-arrow-icon"
						/>
					</th>
					<th class="col-actions"></th>
				</tr>
			</thead>
			<tbody>
				{#each sorted as sub (sub.id)}
					{@const cfg = statusConfig[sub.status] ?? statusConfig.pending}
					{@const StatusIcon = cfg.icon}
					<tr>
						<td class="col-id">
							<a href="{base}/submissions/{sub.id}" class="student-link"
								>{sub.studentId}</a
							>
						</td>
						<td class="col-status">
							<span class="status-badge status-{sub.status}" title={sub.error ?? ""}>
								<StatusIcon size={11} />
								{cfg.label}
							</span>
						</td>
						<td class="col-cells cell-muted">{sub.cellSummary ?? "—"}</td>
						<td class="col-preeval cell-muted"
							>{sub.preEvalGrade != null ? sub.preEvalGrade.toFixed(1) : "—"}</td
						>
						<td class="col-grade cell-bold">{gradeDisplay(sub)}</td>
						<td class="col-actions">
							<a href="{base}/submissions/{sub.id}" class="btn-open">
								Open <ArrowRight size={12} />
							</a>
							{#if sub.status === "archived"}
								<button
									class="btn-row-action"
									title="Restore to the active batch"
									onclick={() => onArchive(sub.id, "restore")}
								>
									Restore
								</button>
								<button
									class="btn-row-action btn-row-danger"
									title="Permanently delete"
									onclick={() => onDelete(sub.id)}
								>
									Delete
								</button>
							{:else}
								<button
									class="btn-row-action"
									title="Archive (hidden from the active batch, restorable)"
									onclick={() => onArchive(sub.id, "archive")}
								>
									Archive
								</button>
							{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>

	<!-- Empty state: no matching submissions -->
	{#if sorted.length === 0}
		<div class="empty-row">
			<div class="empty-inner">
				<Upload size={20} class="empty-icon" />
				<div class="empty-text">
					<p>No submissions match your filters.</p>
					<p class="empty-hint">
						Drop .ipynb files in the upload zone above to get started.
					</p>
				</div>
			</div>
		</div>
	{/if}

	<!-- Footer -->
	<div class="table-footer">
		<span>{sorted.length} submission{sorted.length !== 1 ? "s" : ""}</span>
	</div>
</div>

<!-- Plagiarism overview modal (P3-1) -->
{#if plagiarismModalOpen}
	<PlagiarismModal {assignmentId} onClose={() => (plagiarismModalOpen = false)} />
{/if}

<style>
	/* ── Container ── */
	.dashboard-table-container {
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		overflow: hidden;
		background: var(--card);
	}

	/* ── Toolbar ── */
	.table-toolbar {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 8px 14px;
		border-bottom: 1px solid var(--border);
		background: var(--bg);
	}
	.search-row {
		display: flex;
		align-items: center;
		gap: 6px;
		flex: 0 0 260px;
		background: var(--bg);
		border: 1px solid var(--input);
		border-radius: var(--radius-md);
		padding: 4px 8px;
	}
	:global(.search-icon) {
		color: var(--muted-foreground);
		flex-shrink: 0;
	}
	.search-input {
		flex: 1;
		border: none;
		background: none;
		outline: none;
		font-size: 13px;
		color: var(--fg);
		padding: 3px 0;
	}
	.search-input::placeholder {
		color: var(--muted-foreground);
	}
	.filter-select {
		padding: 6px 32px 6px 10px;
		border: 1px solid var(--input);
		border-radius: var(--radius-md);
		background: var(--bg);
		color: var(--fg);
		font-size: 13px;
		appearance: none;
		cursor: pointer;
		min-width: 140px;
		background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23666' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E");
		background-repeat: no-repeat;
		background-position: right 8px center;
	}
	.filter-select:focus {
		outline: none;
		border-color: var(--accent);
		box-shadow: 0 0 0 2px var(--accent-soft);
	}

	/* ── Toolbar actions (plagiarism button, P3-1) ── */
	.toolbar-actions {
		margin-left: auto;
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.btn-plagiarism {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		height: 30px;
		padding: 0 12px;
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: transparent;
		color: var(--fg);
		font-size: 12px;
		font-weight: 500;
		cursor: pointer;
		white-space: nowrap;
		transition:
			background 0.15s,
			border-color 0.15s;
	}
	.btn-plagiarism:hover {
		background: color-mix(in oklch, var(--fg) 4%, transparent);
		border-color: var(--muted);
	}
	.plagiarism-count-badge {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 17px;
		height: 17px;
		padding: 0 5px;
		border-radius: 999px;
		background: var(--destructive);
		color: var(--destructive-foreground, white);
		font-size: 10px;
		font-weight: 700;
		line-height: 1;
		font-variant-numeric: tabular-nums;
	}

	/* ── Table ── */
	.table-scroll {
		overflow-x: auto;
	}
	.submissions-table {
		width: 100%;
		border-collapse: collapse;
		table-layout: fixed;
	}
	.submissions-table th {
		text-align: left;
		padding: 10px 14px;
		font-size: 12px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--muted-foreground);
		border-bottom: 1px solid var(--border);
		background: color-mix(in oklch, var(--bg) 98%, var(--fg));
		cursor: pointer;
		user-select: none;
		white-space: nowrap;
		transition: color 0.15s;
	}
	.submissions-table th:hover {
		color: var(--fg);
	}
	.sort-arrow-icon {
		margin-left: 4px;
		color: var(--muted-foreground);
	}
	.submissions-table td {
		padding: 10px 14px;
		font-size: 13px;
		border-bottom: 1px solid var(--border);
		vertical-align: middle;
	}
	.submissions-table tbody tr:last-child td {
		border-bottom: none;
	}
	.submissions-table tbody tr {
		transition: background 0.1s;
	}
	.submissions-table tbody tr:hover {
		background: color-mix(in oklch, var(--accent) 2%, var(--bg));
	}

	/* ── Column widths ── */
	.col-id {
		width: 13%;
	}
	.col-status {
		width: 14%;
	}
	.col-cells {
		width: 15%;
	}
	.col-preeval {
		width: 13%;
	}
	.col-grade {
		width: 12%;
	}
	.col-actions {
		width: 10%;
		text-align: right;
		white-space: nowrap;
	}

	/* ── Cell text helpers ── */
	.cell-muted {
		color: var(--muted-foreground);
		font-variant-numeric: tabular-nums;
	}
	.cell-bold {
		font-weight: 600;
		color: var(--fg);
		font-variant-numeric: tabular-nums;
	}

	/* ── Status badges (matches OD mockup) ── */
	.status-badge {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		padding: 2px 9px;
		border-radius: 999px;
		font-size: 11px;
		font-weight: 500;
		line-height: 1.4;
		border: 1px solid transparent;
	}
	.status-pending {
		background: color-mix(in oklch, var(--muted) 10%, transparent);
		color: var(--muted-foreground);
		border-color: color-mix(in oklch, var(--muted) 15%, transparent);
	}
	.status-executing {
		background: color-mix(in oklch, var(--info) 12%, transparent);
		color: var(--info);
		border-color: color-mix(in oklch, var(--info) 20%, transparent);
	}
	.status-executed {
		background: color-mix(in oklch, var(--success) 12%, transparent);
		color: var(--success);
		border-color: color-mix(in oklch, var(--success) 20%, transparent);
	}
	.status-error {
		background: color-mix(in oklch, var(--error) 12%, transparent);
		color: var(--error);
		border-color: color-mix(in oklch, var(--error) 20%, transparent);
	}
	.status-pre-evaluated {
		background: color-mix(in oklch, var(--info) 12%, transparent);
		color: var(--info);
		border-color: color-mix(in oklch, var(--info) 20%, transparent);
	}
	.status-graded {
		background: var(--accent);
		color: var(--accent-on);
		border-color: var(--accent);
	}

	/* ── Student link ── */
	.student-link {
		color: var(--fg);
		font-weight: 500;
		text-decoration: none;
	}
	.student-link:hover {
		color: var(--primary);
	}

	/* ── Open button ── */
	.btn-open {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 4px 12px;
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		font-size: 12px;
		font-weight: 500;
		color: var(--fg);
		background: transparent;
		cursor: pointer;
		text-decoration: none;
		transition:
			background 0.15s,
			border-color 0.15s;
	}
	.btn-open:hover {
		background: var(--accent);
		border-color: var(--accent);
		color: var(--accent-on);
	}

	/* ── Row action buttons (Archive / Restore / Delete) ── */
	.btn-row-action {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		margin-left: 6px;
		padding: 4px 10px;
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		font-size: 12px;
		font-weight: 500;
		color: var(--fg);
		background: transparent;
		cursor: pointer;
		transition:
			background 0.15s,
			border-color 0.15s;
	}
	.btn-row-action:hover {
		background: var(--accent);
		border-color: var(--accent);
		color: var(--accent-on);
	}
	.btn-row-danger {
		color: var(--error);
		border-color: color-mix(in oklch, var(--error) 30%, transparent);
	}
	.btn-row-danger:hover {
		background: var(--error);
		border-color: var(--error);
		color: #fff;
	}

	/* ── Empty row ── */
	.empty-row {
		padding: 48px 16px;
		color: var(--muted-foreground);
		font-size: 13px;
	}
	.empty-inner {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 12px;
	}
	.empty-icon {
		color: var(--muted-foreground);
		opacity: 0.35;
		flex-shrink: 0;
	}
	.empty-text {
		text-align: left;
	}
	.empty-hint {
		font-size: 11px;
		margin-top: 2px;
	}

	/* ── Footer ── */
	.table-footer {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		padding: 10px 14px;
		border-top: 1px solid var(--border);
		font-size: 12px;
		color: var(--muted-foreground);
	}

	/* ── Responsive ── */
	@media (max-width: 900px) {
		.table-toolbar {
			flex-direction: column;
			align-items: stretch;
		}
		.search-row {
			flex: 1;
			min-width: 0;
		}
		.col-preeval,
		.col-grade {
			display: none;
		}
	}
</style>
