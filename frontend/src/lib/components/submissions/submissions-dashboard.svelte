<script lang="ts">
	import { base } from "$app/paths";
	import type { SubmissionMeta } from "$lib/types/submissions.js";
	import { submissionsStore } from "$lib/services/submissions-store.js";
	import {
		markRunFinished,
		markRunStarted,
		runRegistry,
		setRunSummary,
	} from "$lib/services/run-state.svelte.js";
	import { filterSubmissions } from "$lib/services/submission-filters.js";
	import { addToast } from "$lib/stores/toast.svelte.js";
	import { plagiarismStore } from "$lib/services/plagiarism-store.svelte.js";
	import {
		ApiError,
		fetchPreEvalStatus,
		preEvaluateSubmissions,
		type PreEvalProgress,
	} from "$lib/services/submissions-api.js";
	import { statusConfig } from "$lib/components/submissions/status-config.js";
	import { Checkbox } from "$lib/components/ui/checkbox/index.js";
	import { buttonVariants } from "$lib/components/ui/button/button-variants.js";
	import { cn } from "$lib/utils.js";
	import ArrowRight from "@lucide/svelte/icons/arrow-right";
	import Search from "@lucide/svelte/icons/search";
	import Upload from "@lucide/svelte/icons/upload";
	import ShieldCheck from "@lucide/svelte/icons/shield-check";
	import Sparkles from "@lucide/svelte/icons/sparkles";
	import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
	import CircleCheck from "@lucide/svelte/icons/circle-check";
	import Loader from "@lucide/svelte/icons/loader";
	import type { Snippet } from "svelte";
	import SortArrow from "$lib/components/submissions/sort-arrow.svelte";
	import PlagiarismModal from "$lib/components/submissions/plagiarism-modal.svelte";

	interface Props {
		submissions: readonly SubmissionMeta[];
		searchQuery: string;
		statusFilter: string;
		/** Confidence filter: "all" | "needs_review" | "review_optional" | "high_confidence". */
		confidenceFilter: string;
		/** Active assignment — plagiarism results are scoped to it. */
		assignmentId: string;
		onSearchChange: (q: string) => void;
		onStatusFilterChange: (f: string) => void;
		onConfidenceFilterChange: (f: string) => void;
		/** Set of currently selected submission ids (bulk bar drives actions). */
		selectedIds: ReadonlySet<string>;
		/** Toggle a single row's selection. */
		onToggleSelect: (id: string) => void;
		/** Add a contiguous range of ids (shift-click on an unselected row). */
		onSelectRange: (ids: string[]) => void;
		/** Remove a contiguous range of ids (shift-click on a selected row). */
		onDeselectRange: (ids: string[]) => void;
		/** Replace the selection with all currently visible ids. */
		onSelectAllVisible: (ids: string[]) => void;
		/** Clear the selection. */
		onClearSelection: () => void;
		/** Extra actions rendered in the toolbar (right side, after Plagiarism). */
		toolbarActions?: Snippet;
	}

	let {
		submissions,
		searchQuery,
		statusFilter,
		confidenceFilter,
		assignmentId,
		onSearchChange,
		onStatusFilterChange,
		onConfidenceFilterChange,
		selectedIds,
		onToggleSelect,
		onSelectRange,
		onDeselectRange,
		onSelectAllVisible,
		onClearSelection,
		toolbarActions,
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

	// ── Filtered list (canonical rules live in submission-filters.ts) ──
	let filtered = $derived(
		filterSubmissions(submissions, { statusFilter, confidenceFilter, searchQuery }),
	);

	// ── Sort state ──
	type SortKey = "studentId" | "status" | "cellSummary" | "teacherGrade";
	let sortKey = $state<SortKey>("studentId");
	let sortAsc = $state(true);

	/** Extract the sortable value for the current sort key (same type for both rows). */
	function sortValue(s: SubmissionMeta): string | number {
		switch (sortKey) {
			case "status":
				return s.status;
			case "cellSummary":
				return s.cellSummary ?? "";
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

	// ── Selection (bulk bar) ──
	let lastClickedId = $state<string | null>(null);

	/** Ids of the currently visible (filtered + sorted) rows. */
	let visibleIds = $derived(sorted.map((s) => s.id));

	/** Every visible row is selected (header checkbox fully checked). */
	let allVisibleSelected = $derived(
		visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id)),
	);

	/** At least one visible row is selected (header checkbox indeterminate). */
	let headerIndeterminate = $derived(
		visibleIds.some((id) => selectedIds.has(id)) && !allVisibleSelected,
	);

	/** Header checkbox click: select all visible, or clear when all selected. */
	function handleSelectAllClick() {
		if (allVisibleSelected) {
			onClearSelection();
		} else {
			onSelectAllVisible(visibleIds);
		}
	}

	function handleRowCheckboxClick(e: MouseEvent, id: string) {
		if (e.shiftKey && lastClickedId && lastClickedId !== id) {
			// Shift-click extends the selection over the contiguous range
			// (anchor -> target). Clicking a selected row de-selects the
			// range instead.
			const start = sorted.findIndex((s) => s.id === lastClickedId);
			const end = sorted.findIndex((s) => s.id === id);
			if (start !== -1 && end !== -1) {
				const [lo, hi] = start < end ? [start, end] : [end, start];
				const range = sorted.slice(lo, hi + 1).map((s) => s.id);
				if (selectedIds.has(id)) {
					onDeselectRange(range);
				} else {
					onSelectRange(range);
				}
			}
		} else {
			onToggleSelect(id);
		}
		lastClickedId = id;
	}

	// sortArrow replaced by SortArrow component

	// ── Status display config: shared module (page header chip uses it too) ──

	function gradeDisplay(meta: SubmissionMeta): string {
		if (meta.teacherGrade != null) return meta.teacherGrade.toFixed(1);
		return "—";
	}

	// ── Pre-evaluate All ──
	/** Live run record from the status endpoint (null until first fetch). */
	let preEvalStatus = $state<PreEvalProgress | null>(null);
	/** Whether the previous poll observed a running run (drives row refresh). */
	let preEvalWasRunning = $state(false);

	/** At least one executed/error row — the batch pre-evaluation target set. */
	let canPreEvaluateAll = $derived(
		submissions.some((s) => s.status === "executed" || s.status === "error"),
	);

	/**
	 * True while a pre-evaluation run is starting or in flight. The shared
	 * registry is armed by the POST handler (markRunStarted) and only cleared
	 * by it (markRunFinished) — an idle status observation (running:false,
	 * total:0 before the run registers) never disarms the polling loop mid-run.
	 * A status observation with running:true also keeps it armed.
	 */
	let preEvalRunning = $derived(runRegistry.preEval.running || (preEvalStatus?.running ?? false));

	let preEvalDone = $derived(preEvalStatus?.done ?? 0);
	let preEvalTotal = $derived(preEvalStatus?.total ?? runRegistry.preEval.targetCount);

	/**
	 * Monotonic id of the newest status request. Responses from superseded
	 * requests (e.g. the mount fetch still in flight when a run starts) are
	 * dropped so a stale observation can't reset run-tracking state.
	 */
	let statusRequestSeq = 0;

	async function refreshPreEvalStatus() {
		const seq = ++statusRequestSeq;
		try {
			const status = await fetchPreEvalStatus();
			if (seq !== statusRequestSeq) return; // superseded — ignore
			const wasRunning = preEvalWasRunning;
			preEvalStatus = status;
			preEvalWasRunning = status.running;
			// A run that was observed in flight finished: the route flipped
			// rows to "pre-evaluated" — refresh the list. The POST handler
			// refreshes directly too; this covers the reload-mid-run case.
			if (!status.running && status.total > 0 && wasRunning) {
				void submissionsStore.refresh();
			}
		} catch {
			// Keep the last good status; the next poll tick retries.
		}
	}

	// Poll every 2s while a run is active (same cadence as the batch
	// process loop). Stops automatically once running flips to false.
	$effect(() => {
		if (!preEvalRunning) return;
		void refreshPreEvalStatus();
		const timer = setInterval(() => {
			void refreshPreEvalStatus();
		}, 2000);
		return () => clearInterval(timer);
	});

	// Restore the running state after a page reload mid-run: one status
	// fetch on mount re-arms the polling loop when a run is still in flight.
	$effect(() => {
		void refreshPreEvalStatus();
	});

	async function handlePreEvaluateAll() {
		if (preEvalRunning) return;
		preEvalStatus = null;
		// Arm the shared registry so the page's progress bar, log live mode,
		// polling/stopwatch effects and Reset-disable all light up for this
		// dashboard-started run (BUG-006/BUG-008), and the store's list loop
		// stays alive (BUG-020).
		const total = submissions.filter(
			(s) => s.status === "executed" || s.status === "error",
		).length;
		markRunStarted("preEval", total);
		try {
			const summary = await preEvaluateSubmissions(assignmentId);
			addToast(
				"success",
				`Pre-evaluated ${summary.succeeded} of ${summary.submitted} submission(s)${
					summary.failed > 0 ? `, ${summary.failed} failed` : ""
				}`,
				5000,
			);
			// Record the run's tallies so the page's log-panel banner shows
			// them (BUG-007 — the POST handler is the only writer).
			setRunSummary("preEval", summary);
			// The route runs the whole batch before responding and flips the
			// target rows to "pre-evaluated" — refresh the list directly so
			// the table shows the new statuses immediately (a fast run can
			// finish before the first status poll ever observes running:true).
			await submissionsStore.refresh();
		} catch (e) {
			if (e instanceof ApiError && e.status === 409) {
				addToast("error", "A pre-evaluation run is already in progress", 4000);
			} else {
				addToast("error", e instanceof Error ? e.message : "Pre-evaluation failed", 5000);
			}
		} finally {
			// Only the POST handler finishes the run (markRunFinished keeps the
			// summary): an idle status observation (running:false, total:0
			// before the run registers) must never disarm the polling loops.
			markRunFinished("preEval");
		}
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
				aria-label="Search submissions"
				value={searchQuery}
				oninput={(e) => onSearchChange(e.currentTarget.value)}
			/>
		</div>
		<select
			class="filter-select"
			aria-label="Filter by status"
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
		<select
			class="filter-select"
			aria-label="Filter by confidence"
			value={confidenceFilter}
			onchange={(e) => onConfidenceFilterChange(e.currentTarget.value)}
		>
			<option value="all">Confidence: All</option>
			<option value="needs_review">Needs Review</option>
			<option value="review_optional">Review Optional</option>
			<option value="high_confidence">High Confidence</option>
		</select>
		<div class="toolbar-actions">
			<button
				class={cn(buttonVariants({ variant: "outline", size: "sm" }), "gap-1.5")}
				title="Review plagiarism detections for this assignment"
				onclick={() => (plagiarismModalOpen = true)}
			>
				<ShieldCheck size={14} />
				Plagiarism
				{#if unreviewed > 0}
					<span class="plagiarism-count-badge">{unreviewed}</span>
				{/if}
			</button>
			<button
				class={cn(buttonVariants({ variant: "outline", size: "sm" }), "gap-1.5")}
				title="Pre-evaluate all executed/error submissions (one KI call per submission)"
				onclick={handlePreEvaluateAll}
				disabled={!canPreEvaluateAll || preEvalRunning}
			>
				<Sparkles size={14} />
				{#if preEvalRunning}
					Pre-evaluating… {preEvalDone}/{preEvalTotal}
				{:else}
					Pre-evaluate All
				{/if}
			</button>
			{#if toolbarActions}
				{@render toolbarActions()}
			{/if}
		</div>
	</div>

	<!-- Table -->
	<div class="table-scroll">
		<table class="submissions-table" aria-label="Submissions table" role="grid">
			<thead>
				<tr aria-rowindex={1}>
					<th class="col-select" role="columnheader" aria-label="Select all submissions">
						<Checkbox
							checked={allVisibleSelected}
							indeterminate={headerIndeterminate}
							onclick={handleSelectAllClick}
							aria-label="Select all visible submissions"
						/>
					</th>
					<th
						class="col-id"
						role="columnheader"
						aria-sort={sortKey === "studentId"
							? sortAsc
								? "ascending"
								: "descending"
							: "none"}
						onclick={() => toggleSort("studentId")}
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
						role="columnheader"
						aria-sort={sortKey === "status"
							? sortAsc
								? "ascending"
								: "descending"
							: "none"}
						onclick={() => toggleSort("status")}
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
						role="columnheader"
						aria-sort={sortKey === "cellSummary"
							? sortAsc
								? "ascending"
								: "descending"
							: "none"}
						onclick={() => toggleSort("cellSummary")}
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
					<th class="col-preeval" role="columnheader"> Pre-Eval </th>
					<th
						class="col-grade"
						role="columnheader"
						aria-sort={sortKey === "teacherGrade"
							? sortAsc
								? "ascending"
								: "descending"
							: "none"}
						onclick={() => toggleSort("teacherGrade")}
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
					<th class="col-actions" role="columnheader"></th>
				</tr>
			</thead>
			<tbody>
				{#each sorted as sub, i (sub.id)}
					{@const cfg = statusConfig[sub.status] ?? statusConfig.pending}
					{@const StatusIcon = cfg.icon}
					<tr aria-rowindex={i + 2}>
						<td class="col-select">
							<Checkbox
								checked={selectedIds.has(sub.id)}
								onclick={(e) => handleRowCheckboxClick(e, sub.id)}
								aria-label={`Select ${sub.studentId}`}
							/>
						</td>
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
						<td class="col-cells cell-muted">
							{sub.cellSummary ?? "—"}
							{#if sub.autofixAvailable}
								<span
									class="autofix-badge"
									title="A verified auto-fix is available — open the submission to compare"
								>
									<Sparkles size={11} />
									Auto-fix available
								</span>
							{/if}
							{#if sub.overTickCategories && sub.overTickCategories.length > 0}
								<span
									class="over-tick-badge"
									title={`Pipeline checked more items than the cohort norm in ${sub.overTickCategories
										.map((c) => c.categoryKey)
										.join(", ")} — open the submission to review the extras`}
								>
									<TriangleAlert size={11} />
									Over-tick
								</span>
							{/if}
						</td>
						<td class="col-preeval cell-muted">
							{#if preEvalRunning && (sub.status === "executed" || sub.status === "error")}
								<span
									class="preeval-chip preeval-running"
									title="Pre-evaluation in progress"
								>
									<Loader size={11} class="spin" />
								</span>
							{:else if sub.status === "pre-evaluated"}
								<span class="preeval-chip preeval-done" title="Pre-evaluated">
									<CircleCheck size={11} />
								</span>
							{:else}
								<span class="preeval-chip preeval-empty">—</span>
							{/if}
						</td>
						<td class="col-grade cell-bold">{gradeDisplay(sub)}</td>
						<td class="col-actions">
							<a
								href="{base}/submissions/{sub.id}"
								class={cn(
									buttonVariants({ variant: "outline", size: "sm" }),
									"gap-1",
								)}
								title="Open submission"
							>
								Open <ArrowRight size={14} />
							</a>
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
	.search-input:focus-visible {
		outline: 2px solid var(--ring);
		outline-offset: 2px;
		border-radius: 4px;
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
	.plagiarism-count-badge {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 17px;
		height: 17px;
		padding: 0 5px;
		border-radius: 999px;
		background: var(--destructive);
		color: var(--destructive-foreground);
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

	/* ── Column widths (percent columns sum to ~80%; select/actions are fixed) ── */
	.col-select {
		width: 44px;
		text-align: center;
	}
	.col-id {
		width: 16%;
	}
	.col-status {
		width: 15%;
	}
	.col-cells {
		width: 17%;
	}
	.col-preeval {
		width: 15%;
	}
	.col-grade {
		width: 14%;
	}
	.col-actions {
		width: 120px;
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
	/* Verified auto-fix affordance (3c.3): points the teacher at the
	   original↔fixed toggle without hiding the original error summary. */
	.autofix-badge {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		margin-left: 6px;
		padding: 1px 7px;
		border-radius: 999px;
		font-size: 10px;
		font-weight: 600;
		line-height: 1.4;
		background: color-mix(in oklch, var(--warning) 18%, transparent);
		color: var(--warning);
		border: 1px solid color-mix(in oklch, var(--warning) 40%, transparent);
		white-space: nowrap;
	}
	/* Over-tick guard (review-diff workflow): advisory badge on rows where
	   the pipeline checked more items than the cohort norm tolerates. */
	.over-tick-badge {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		margin-left: 6px;
		padding: 1px 7px;
		border-radius: 999px;
		font-size: 10px;
		font-weight: 600;
		line-height: 1.4;
		background: color-mix(in oklch, var(--destructive) 10%, transparent);
		color: var(--destructive);
		border: 1px solid color-mix(in oklch, var(--destructive) 35%, transparent);
		white-space: nowrap;
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

	/* ── Pre-Eval column chip ── */
	.preeval-chip {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-size: 11px;
		font-weight: 500;
		line-height: 1.4;
		white-space: nowrap;
	}
	.preeval-done {
		color: var(--success);
	}
	.preeval-running {
		color: var(--info);
	}
	.preeval-empty {
		color: var(--muted-foreground);
	}
	/* Lucide icons render <svg> via components — :global for the analyzer. */
	:global(.spin) {
		animation: spin 0.9s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
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
