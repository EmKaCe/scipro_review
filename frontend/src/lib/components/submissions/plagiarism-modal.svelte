<script lang="ts">
	/**
	 * Plagiarism overview modal (P3-1). 760px card, overview-only: severity,
	 * notebook/cell overlap, matched-cell COUNT and shared-import chips per
	 * pair. No accordions, no per-cell lists — the full details live in the
	 * per-submission Plagiarism tab.
	 *
	 * Data comes from the shared plagiarismStore (loaded by the dashboard
	 * on assignment change). "Re-run check" calls POST /api/plagiarism/check.
	 */
	import { plagiarismStore } from "$lib/services/plagiarism-store.svelte.js";
	import {
		pairReviewStatus,
		pairSeverity,
		type PairSeverity,
	} from "$lib/services/submissions-api.js";
	import ShieldCheck from "@lucide/svelte/icons/shield-check";
	import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
	import Info from "@lucide/svelte/icons/info";
	import Play from "@lucide/svelte/icons/play";
	import X from "@lucide/svelte/icons/x";
	import LoaderCircle from "@lucide/svelte/icons/loader-circle";
	import { Button } from "$lib/components/ui/button/index.js";
	import { Tooltip, TooltipTrigger, TooltipContent } from "$lib/components/ui/tooltip/index.js";

	interface Props {
		/** Assignment the modal reports on. */
		assignmentId: string;
		/** Close the modal. */
		onClose: () => void;
	}

	let { assignmentId, onClose }: Props = $props();

	// Derived from the shared store (reactive).
	let result = $derived(plagiarismStore.result);
	let isChecking = $derived(plagiarismStore.isChecking);
	let error = $derived(plagiarismStore.error);

	/** "soil_contamination · checked 2 Aug 2026, 14:32" — mockup meta line. */
	let checkedLabel = $derived.by(() => {
		if (!result) return assignmentId;
		const date = new Date(result.generatedAt);
		const formatted = Number.isNaN(date.getTime())
			? result.generatedAt
			: new Intl.DateTimeFormat("en-GB", {
					day: "numeric",
					month: "short",
					year: "numeric",
					hour: "2-digit",
					minute: "2-digit",
				}).format(date);
		return `${assignmentId} · checked ${formatted}`;
	});

	/** Unreviewed pairs across the whole assignment (dashboard badge). */
	let unreviewed = $derived(plagiarismStore.unreviewedCount());

	function sevLabel(sev: PairSeverity): string {
		return sev === "high"
			? "High"
			: sev === "medium"
				? "Medium"
				: sev === "low"
					? "Low"
					: "Info";
	}

	async function handleRun() {
		try {
			await plagiarismStore.run(assignmentId);
		} catch {
			// error is surfaced reactively from the store
		}
	}

	function handleOverlayClick(e: MouseEvent) {
		if (e.target === e.currentTarget) onClose();
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === "Escape") onClose();
	}
</script>

<svelte:window onkeydown={handleKeydown} />

{#if result !== null || error !== null}
	<div class="modal-overlay" onclick={handleOverlayClick} role="presentation">
		<div class="modal-card" role="dialog" aria-modal="true" aria-label="Plagiarism check">
			<!-- Header -->
			<div class="modal-card-header with-meta">
				<div class="modal-header-top">
					<div class="modal-header-titles">
						<h3>Plagiarism check</h3>
						<span class="plagiarism-meta-line">{checkedLabel}</span>
					</div>
					<div class="modal-header-controls">
						<Button
							variant="outline"
							size="xs"
							onclick={handleRun}
							disabled={isChecking}
						>
							{#if isChecking}
								<LoaderCircle size={12} class="spin" />
							{:else}
								<Play size={12} />
							{/if}
							{isChecking ? "Checking…" : "Re-run check"}
						</Button>
						<Tooltip>
							<TooltipTrigger
								onclick={onClose}
								class="flex h-7 w-7 items-center justify-center rounded-[var(--radius)] text-muted-foreground transition-colors hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10"
								aria-label="Close"
							>
								<X size={16} />
							</TooltipTrigger>
							<TooltipContent>Close</TooltipContent>
						</Tooltip>
					</div>
				</div>
			</div>

			<!-- Body -->
			<div class="modal-card-body">
				{#if error}
					<div class="modal-error">
						<TriangleAlert size={16} />
						<span>Check failed: {error}</span>
					</div>
				{:else if result === null}
					<!-- Empty state: no check has been run -->
					<div class="modal-empty-state">
						<div class="modal-empty-icon">
							<ShieldCheck size={22} />
						</div>
						<p>No results yet. Run a check for this assignment.</p>
						<Button
							variant="outline"
							size="sm"
							onclick={handleRun}
							disabled={isChecking}
						>
							{#if isChecking}
								<LoaderCircle size={13} class="spin" />
							{:else}
								<Play size={13} />
							{/if}
							{isChecking ? "Checking…" : "Run check"}
						</Button>
					</div>
				{:else if result.pairs.length === 0}
					<!-- Checked, nothing flagged -->
					<div class="modal-empty-state">
						<div class="modal-empty-icon">
							<ShieldCheck size={22} />
						</div>
						<p>No flagged pairs for this assignment.</p>
					</div>
				{:else}
					<div class="modal-plagiarism-results">
						<p class="plagiarism-summary">
							{result.pairs.length} flagged pair{result.pairs.length !== 1 ? "s" : ""} ·
							{result.comparedSubmissions.length} submission{result
								.comparedSubmissions.length !== 1
								? "s"
								: ""} compared
							{#if unreviewed > 0}
								· {unreviewed} unreviewed{/if}
						</p>
						{#each result.pairs as pair (pair.studentA + pair.studentB)}
							{@const sev = pairSeverity(pair)}
							{@const status = pairReviewStatus(pair)}
							<div
								class="plagiarism-pair-card"
								class:pair-resolved={status !== "unreviewed"}
							>
								<div class="pair-card-header">
									<span class="pair-sev-badge badge-severity-{sev}">
										{#if sev === "high"}
											<TriangleAlert size={11} />
										{:else}
											<Info size={11} />
										{/if}
										{sevLabel(sev)}
									</span>
									<span class="pair-pair">
										{pair.studentA}<span class="pair-vs">vs</span
										>{pair.studentB}
									</span>
									<span class="pair-sim"
										>{Math.round(pair.notebookOverlap * 100)}% notebook ·
										{Math.round(pair.cellOverlap * 100)}% cell overlap</span
									>
								</div>
								<div class="pair-brief">
									<span class="pair-brief-count"
										>{pair.matchedCells.length} cell{pair.matchedCells
											.length !== 1
											? "s"
											: ""} matched</span
									>
									{#each pair.details.sharedImports as imp (imp)}
										<span class="chip">{imp}</span>
									{/each}
								</div>
							</div>
						{/each}
					</div>
				{/if}
			</div>
		</div>
	</div>
{/if}

<style>
	/* ── Overlay & card (760px, P3-1) ── */
	.modal-overlay {
		position: fixed;
		inset: 0;
		background: color-mix(in oklch, var(--bg) 55%, transparent);
		backdrop-filter: blur(2px);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 50;
		padding: 20px;
	}
	.modal-card {
		width: 760px;
		max-width: calc(100vw - 40px);
		max-height: min(80vh, 720px);
		display: flex;
		flex-direction: column;
		background: var(--card);
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		box-shadow: 0 16px 48px rgb(0 0 0 / 0.18);
		overflow: hidden;
	}
	.modal-card-header {
		padding: 14px 18px;
		border-bottom: 1px solid var(--border);
		background: var(--bg);
		flex-shrink: 0;
	}
	.modal-header-top {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}
	.modal-header-titles h3 {
		font-size: 15px;
		font-weight: 600;
		color: var(--fg);
	}
	.plagiarism-meta-line {
		display: block;
		margin-top: 2px;
		font-size: 11px;
		color: var(--muted-foreground);
	}
	.modal-header-controls {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-shrink: 0;
	}

	.modal-card-body {
		padding: 16px 18px;
		overflow-y: auto;
		flex: 1;
	}

	.spin {
		animation: spin 0.9s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	/* ── Empty / error states ── */
	.modal-empty-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 10px;
		padding: 44px 16px;
		text-align: center;
		color: var(--muted-foreground);
		font-size: 13px;
	}
	.modal-empty-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 46px;
		height: 46px;
		border-radius: 50%;
		background: color-mix(in oklch, var(--accent) 10%, transparent);
		color: var(--accent);
	}
	.modal-error {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 10px 12px;
		border: 1px solid color-mix(in oklch, var(--error) 30%, transparent);
		background: color-mix(in oklch, var(--error) 8%, transparent);
		border-radius: var(--radius-md);
		color: var(--error);
		font-size: 12px;
	}

	/* ── Results ── */
	.plagiarism-summary {
		font-size: 12px;
		color: var(--muted-foreground);
		margin-bottom: 12px;
	}
	.plagiarism-pair-card {
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		padding: 10px 12px;
		margin-bottom: 10px;
		background: var(--bg);
		transition: opacity 0.15s;
	}
	.plagiarism-pair-card.pair-resolved {
		opacity: 0.55;
	}
	.pair-card-header {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
	}
	.pair-sev-badge {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 1px 8px;
		border-radius: 999px;
		font-size: 10px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	.badge-severity-high {
		background: color-mix(in oklch, var(--error) 12%, transparent);
		color: var(--error);
		border: 1px solid color-mix(in oklch, var(--error) 25%, transparent);
	}
	.badge-severity-medium {
		background: color-mix(in oklch, var(--warning) 12%, transparent);
		color: var(--warning);
		border: 1px solid color-mix(in oklch, var(--warning) 25%, transparent);
	}
	.badge-severity-low,
	.badge-severity-none {
		background: color-mix(in oklch, var(--muted) 12%, transparent);
		color: var(--muted-foreground);
		border: 1px solid color-mix(in oklch, var(--muted) 25%, transparent);
	}
	.pair-pair {
		font-size: 13px;
		font-weight: 600;
		color: var(--fg);
		font-variant-numeric: tabular-nums;
	}
	.pair-vs {
		margin: 0 6px;
		font-size: 10px;
		font-weight: 500;
		text-transform: uppercase;
		color: var(--muted-foreground);
	}
	.pair-sim {
		margin-left: auto;
		font-size: 11px;
		color: var(--muted-foreground);
		font-variant-numeric: tabular-nums;
	}
	.pair-brief {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-top: 8px;
		flex-wrap: wrap;
	}
	.pair-brief-count {
		font-size: 11px;
		color: var(--muted-foreground);
		margin-right: 4px;
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
</style>
