<script lang="ts" module>
	/** "2 Aug 2026, 14:32" style date for the summary line. */
	function formatChecked(iso: string): string {
		const date = new Date(iso);
		if (Number.isNaN(date.getTime())) return iso;
		return new Intl.DateTimeFormat("en-GB", {
			day: "numeric",
			month: "short",
			year: "numeric",
			hour: "2-digit",
			minute: "2-digit",
		}).format(date);
	}

	/** Human label for a resolved status chip. */
	function statusLabel(status: PairReviewStatus): string {
		switch (status) {
			case "accepted":
				return "Accepted";
			case "dismissed":
				return "Dismissed";
			case "ignored":
				return "Ignored";
			default:
				return "Unreviewed";
		}
	}
</script>

<script lang="ts">
	/**
	 * Plagiarism tab (right panel, per-submission). Shows the flagged pairs
	 * involving this submission with full details (P3-1):
	 *
	 *   - severity badge, partner student, notebook similarity
	 *   - matched cell list (partner's cells, per-cell similarity)
	 *   - shared-import chips
	 *   - resolution actions: Accept (confirmed) / Dismiss (false positive)
	 *     / Ignore (no action) — each pair resolves independently and the
	 *     status persists server-side.
	 *
	 * The badge count on the tab = unreviewed pairs involving THIS student.
	 * No banner in the notebook column — details live here only.
	 */
	import { plagiarismStore } from "$lib/services/plagiarism-store.svelte.js";
	import {
		pairReviewStatus,
		pairSeverity,
		type PairReviewStatus,
		type PairSeverity,
	} from "$lib/services/submissions-api.js";
	import ShieldCheck from "@lucide/svelte/icons/shield-check";
	import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
	import Undo2 from "@lucide/svelte/icons/undo-2";
	import { Button } from "$lib/components/ui/button/index.js";
	import Play from "@lucide/svelte/icons/play";
	import LoaderCircle from "@lucide/svelte/icons/loader-circle";

	interface Props {
		/** Current submission id (the pairs shown involve this student). */
		studentId: string;
		/** Assignment the plagiarism result belongs to. */
		assignmentId: string;
	}

	let { studentId, assignmentId }: Props = $props();

	let pairs = $derived(plagiarismStore.pairsFor(studentId));
	let result = $derived(plagiarismStore.result);
	let isChecking = $derived(plagiarismStore.isChecking);
	let error = $derived(plagiarismStore.error);

	/** "2 potential detections · last checked today 10:42" style summary. */
	let summary = $derived.by(() => {
		const unresolved = pairs.filter((p) => pairReviewStatus(p) === "unreviewed").length;
		const checked =
			result && result.generatedAt ? formatChecked(result.generatedAt) : "not checked yet";
		return unresolved > 0
			? `${unresolved} potential detection${unresolved !== 1 ? "s" : ""} · last checked ${checked}`
			: `No unreviewed detections · last checked ${checked}`;
	});

	/** The OTHER student of a pair (the tab always reports on `studentId`). */
	function partnerOf(pair: { studentA: string; studentB: string }): string {
		return pair.studentA === studentId ? pair.studentB : pair.studentA;
	}

	/** Cell index belonging to the partner's notebook (1-based display). */
	function partnerCellIndex(
		pair: {
			studentA: string;
			studentB: string;
			matchedCells: Array<{ cellIndexA: number; cellIndexB: number }>;
		},
		i: number,
	): number {
		const cell = pair.matchedCells[i]!;
		return (pair.studentA === studentId ? cell.cellIndexB : cell.cellIndexA) + 1;
	}

	function sevLabel(sev: PairSeverity): string {
		return sev === "high"
			? "High"
			: sev === "medium"
				? "Medium"
				: sev === "low"
					? "Low"
					: "Info";
	}

	async function handleResolve(
		pair: { studentA: string; studentB: string },
		status: PairReviewStatus,
	) {
		try {
			await plagiarismStore.setStatus(pair.studentA, pair.studentB, status, assignmentId);
		} catch {
			// error is surfaced reactively from the store
		}
	}

	async function handleRerun() {
		try {
			await plagiarismStore.run(assignmentId);
		} catch {
			// error is surfaced reactively from the store
		}
	}
</script>

<div class="plagiarism-tab">
	<div class="plag-toolbar">
		<h2>Plagiarism</h2>
		<Button variant="ghost" size="xs" onclick={handleRerun} disabled={isChecking}>
			{#if isChecking}
				<LoaderCircle size={11} class="spin" />
			{:else}
				<Play size={11} />
			{/if}
			{isChecking ? "Checking…" : "Re-run check"}
		</Button>
	</div>

	{#if error}
		<div class="plag-error">
			<TriangleAlert size={14} />
			<span>Check failed: {error}</span>
		</div>
	{:else if pairs.length === 0}
		<p class="plag-summary">{summary}</p>
		<div class="plag-empty">
			<ShieldCheck size={20} />
			<p>
				No plagiarism pairs involving this submission.
				{#if !result}
					Run a check first — the dashboard button or "Re-run check" above.
				{/if}
			</p>
		</div>
	{:else}
		<p class="plag-summary">{summary}</p>

		{#each pairs as pair (pair.studentA + pair.studentB)}
			{@const sev = pairSeverity(pair)}
			{@const status = pairReviewStatus(pair)}
			{@const resolved = status !== "unreviewed"}
			<div class="plag-pair" class:plag-pair-resolved={resolved}>
				<div class="plag-pair-head">
					<div class="plag-pair-info">
						<span class="plag-severity {sev}">{sevLabel(sev)}</span>
						<span class="plag-pair-title">{partnerOf(pair)}</span>
						<span class="plag-pair-sim"
							>{Math.round(pair.notebookOverlap * 100)}% notebook similarity ·
							{pair.matchedCells.length} cell{pair.matchedCells.length !== 1
								? "s"
								: ""} matched</span
						>
					</div>
					{#if resolved}
						<span class="plag-resolved-chip chip-{status}">{statusLabel(status)}</span>
						<!-- Undo a resolution: back to unreviewed (PATCH endpoint
						     accepts "unreviewed"; badge + actions return). -->
						<Button
							variant="ghost"
							size="xs"
							class="plag-undo"
							title="Reset to unreviewed"
							onclick={() => handleResolve(pair, "unreviewed")}
						>
							<Undo2 size={11} />
							Undo
						</Button>
					{/if}
				</div>

				{#if pair.details.sharedImports.length > 0}
					<div class="plag-shared">
						{#each pair.details.sharedImports as imp (imp)}
							<span class="chip chip-import">{imp}</span>
						{/each}
						<span class="chip-chip-label">shared imports</span>
					</div>
				{/if}

				{#if pair.matchedCells.length > 0}
					<div class="plag-match-list">
						{#each pair.matchedCells as cell, i (cell.cellIndexA + ":" + cell.cellIndexB)}
							<div class="plag-match-row">
								<span class="plag-match-cell">Cell {partnerCellIndex(pair, i)}</span
								>
								<span class="plag-match-sim"
									>{Math.round(cell.similarity * 100)}%</span
								>
							</div>
						{/each}
					</div>
				{/if}

				{#if !resolved}
					<div class="plag-actions">
						<Button
							variant="default"
							size="xs"
							onclick={() => handleResolve(pair, "accepted")}
						>
							Accept
						</Button>
						<Button
							variant="outline"
							size="xs"
							onclick={() => handleResolve(pair, "dismissed")}
						>
							Dismiss
						</Button>
						<Button
							variant="ghost"
							size="xs"
							onclick={() => handleResolve(pair, "ignored")}
						>
							Ignore
						</Button>
					</div>
				{/if}
			</div>
		{/each}
	{/if}
</div>

<style>
	.plagiarism-tab {
		padding: 12px;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.plag-toolbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}
	.plag-toolbar h2 {
		font-size: 13px;
		font-weight: 600;
		color: var(--fg);
	}
	.plag-summary {
		font-size: 11px;
		color: var(--muted-foreground);
		margin: 0;
	}
	.plag-error {
		display: flex;
		align-items: center;
		gap: 7px;
		padding: 8px 10px;
		border: 1px solid color-mix(in oklch, var(--error) 30%, transparent);
		background: color-mix(in oklch, var(--error) 8%, transparent);
		border-radius: var(--radius-md);
		color: var(--error);
		font-size: 11px;
	}
	.plag-empty {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 8px;
		padding: 28px 12px;
		text-align: center;
		color: var(--muted-foreground);
		font-size: 12px;
	}

	/* ── Pair card ── */
	.plag-pair {
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: var(--bg);
		padding: 10px 12px;
		transition: opacity 0.15s;
	}
	.plag-pair-resolved {
		opacity: 0.6;
	}
	.plag-pair-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}
	.plag-pair-info {
		display: flex;
		align-items: center;
		gap: 7px;
		flex-wrap: wrap;
		min-width: 0;
	}
	.plag-severity {
		display: inline-flex;
		align-items: center;
		padding: 1px 7px;
		border-radius: 999px;
		font-size: 10px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	.plag-severity.high {
		background: color-mix(in oklch, var(--error) 12%, transparent);
		color: var(--error);
		border: 1px solid color-mix(in oklch, var(--error) 25%, transparent);
	}
	.plag-severity.medium {
		background: color-mix(in oklch, var(--warning) 12%, transparent);
		color: var(--warning);
		border: 1px solid color-mix(in oklch, var(--warning) 25%, transparent);
	}
	.plag-severity.low {
		background: color-mix(in oklch, var(--muted) 12%, transparent);
		color: var(--muted-foreground);
		border: 1px solid color-mix(in oklch, var(--muted) 25%, transparent);
	}
	.plag-pair-title {
		font-size: 13px;
		font-weight: 600;
		color: var(--fg);
		font-variant-numeric: tabular-nums;
	}
	.plag-pair-sim {
		font-size: 11px;
		color: var(--muted-foreground);
		font-variant-numeric: tabular-nums;
	}
	.plag-resolved-chip {
		font-size: 10px;
		font-weight: 600;
		padding: 1px 7px;
		border-radius: 999px;
		white-space: nowrap;
	}
	.plag-undo {
		margin-left: auto;
	}
	.chip-accepted {
		background: color-mix(in oklch, var(--success) 12%, transparent);
		color: var(--success);
		border: 1px solid color-mix(in oklch, var(--success) 25%, transparent);
	}
	.chip-dismissed,
	.chip-ignored {
		background: color-mix(in oklch, var(--muted) 12%, transparent);
		color: var(--muted-foreground);
		border: 1px solid color-mix(in oklch, var(--muted) 25%, transparent);
	}

	/* ── Shared imports ── */
	.plag-shared {
		display: flex;
		align-items: center;
		gap: 5px;
		margin-top: 8px;
		flex-wrap: wrap;
	}
	.chip {
		display: inline-block;
		padding: 1px 8px;
		border-radius: 999px;
		border: 1px solid var(--border);
		background: var(--card);
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 10px;
		color: var(--fg);
	}
	.chip-chip-label {
		font-size: 10px;
		color: var(--muted-foreground);
	}

	/* ── Matched cells ── */
	.plag-match-list {
		margin-top: 8px;
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		overflow: hidden;
	}
	.plag-match-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 4px 10px;
		font-size: 11px;
		border-bottom: 1px solid var(--border);
		background: var(--card);
	}
	.plag-match-row:last-child {
		border-bottom: none;
	}
	.plag-match-cell {
		color: var(--fg);
	}
	.plag-match-sim {
		color: var(--muted-foreground);
		font-variant-numeric: tabular-nums;
	}

	/* ── Resolution actions ── */
	.plag-actions {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-top: 10px;
		padding-top: 8px;
		border-top: 1px dashed var(--border);
	}
	.spin {
		animation: spin 0.9s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
</style>
