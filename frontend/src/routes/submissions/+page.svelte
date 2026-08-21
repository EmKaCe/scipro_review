<script lang="ts">
	import { submissionsStore } from "$lib/services/submissions-store.js";
	import {
		markRunFinished,
		markRunStarted,
		runRegistry,
	} from "$lib/services/run-state.svelte.js";
	import { filterSubmissions } from "$lib/services/submission-filters.js";
	import { headerConfig } from "$lib/stores/header.svelte.js";
	import { addToast } from "$lib/stores/toast.svelte.js";
	import { base } from "$app/paths";
	import { slide } from "svelte/transition";
	import { SvelteSet } from "svelte/reactivity";
	import { zipSync, strToU8 } from "fflate";
	import { Button } from "$lib/components/ui/button/index.js";
	import { buttonVariants } from "$lib/components/ui/button/button-variants.js";
	import { cn } from "$lib/utils.js";
	import SkeletonPulse from "$lib/components/ui/skeleton-pulse.svelte";
	import ConfigErrorBanner from "$lib/components/submissions/config-error-banner.svelte";
	import AlertTriangle from "@lucide/svelte/icons/alert-triangle";
	import RefreshCw from "@lucide/svelte/icons/refresh-cw";
	import X from "@lucide/svelte/icons/x";
	import Download from "@lucide/svelte/icons/download";
	import Archive from "@lucide/svelte/icons/archive";
	import ArchiveRestore from "@lucide/svelte/icons/archive-restore";
	import Trash2 from "@lucide/svelte/icons/trash-2";
	import Play from "@lucide/svelte/icons/play";
	import RotateCcw from "@lucide/svelte/icons/rotate-ccw";
	import Eraser from "@lucide/svelte/icons/eraser";
	import Sparkles from "@lucide/svelte/icons/sparkles";
	import ListChecks from "@lucide/svelte/icons/list-checks";
	import HardDriveDownload from "@lucide/svelte/icons/hard-drive-download";
	import FolderCog from "@lucide/svelte/icons/folder-cog";
	import Upload from "@lucide/svelte/icons/upload";
	import ChevronDown from "@lucide/svelte/icons/chevron-down";
	import ChevronUp from "@lucide/svelte/icons/chevron-up";

	import AssignmentSelector from "$lib/components/submissions/assignment-selector.svelte";
	import UploadPanel from "$lib/components/submissions/upload-panel.svelte";
	import MaterialsIndicator from "$lib/components/submissions/materials-indicator.svelte";
	import MaterialsManager from "$lib/components/submissions/materials-manager.svelte";
	import SubmissionsDashboard from "$lib/components/submissions/submissions-dashboard.svelte";
	import MenuButton from "$lib/components/ui/menu-button.svelte";
	import ConfirmationDialog from "$lib/components/confirmation-dialog.svelte";
	import CopilotPanel from "$lib/components/submissions/copilot-panel.svelte";
	import { apiMode } from "$lib/components/submissions/copilot-store.svelte.js";
	import {
		downloadBackup,
		fetchAssignments,
		fetchExecutorLogs,
		fetchMaterials,
		fetchPreEvalLogs,
		fetchPreEvalStatus,
		fetchProcessStatus,
		restoreBackup,
		type ExecutorLogEntry,
		type PreEvalProgress,
		type ProcessProgress,
	} from "$lib/services/submissions-api.js";
	import type { MaterialsStatus, SubmissionUploadResult } from "$lib/services/submissions-api.js";
	import PipelineLogPanel from "$lib/components/submissions/pipeline-log-panel.svelte";
	import PipelineProgressBar from "$lib/components/submissions/pipeline-progress-bar.svelte";

	// -----------------------------------------------------------------------
	// Header config
	// -----------------------------------------------------------------------
	$effect(() => {
		headerConfig.headerState = "dashboard";
		headerConfig.showBack = false;
		headerConfig.showImport = false;
		headerConfig.showSave = false;
		headerConfig.showExport = false;
		return () => {
			headerConfig.headerState = "dashboard";
		};
	});

	// -----------------------------------------------------------------------
	// State
	// -----------------------------------------------------------------------
	// Single source of truth: the store. Any mutation (upload, delete,
	// archive, restore, reset, process) refreshes the store's list, and the
	// table here updates reactively — no manual re-sync after actions.
	let submissions = $derived(submissionsStore.submissions);
	let isLoading = $state(true);
	let error = $state<string | null>(null);
	let selectedAssignment = $state("");
	/** Assignment dropdown options, fed from GET /api/assignments (no hardcoded stub). */
	let assignmentOptions = $state<{ id: string; label: string; disabled?: boolean }[]>([]);
	/** Set when GET /api/assignments fails; the selector then shows the empty placeholder. */
	let assignmentsError = $state<string | null>(null);
	/**
	 * Set when the assignment configuration (assignments list or materials)
	 * fails to load — surfaced as a dismissible banner above the table so a
	 * broken config is never a silent null.
	 */
	let configError = $state<string | null>(null);
	let searchQuery = $state("");
	let statusFilter = $state("all");
	/** Confidence filter: "all" | "needs_review" | "review_optional" | "high_confidence". */
	let confidenceFilter = $state("all");
	let uploadPanelOpen = $state(false);
	/** Materials manager panel visibility (dashboard). */
	let materialsOpen = $state(false);
	/** Assignment copilot panel visibility (teacher build only, collapsible). */
	let copilotOpen = $state(false);
	/** Materials state for the selected assignment (B3 — real API). */
	let materials = $state<MaterialsStatus | null>(null);

	// -----------------------------------------------------------------------
	// Bulk selection (checkboxes + bulk action bar)
	// -----------------------------------------------------------------------
	/** Ids selected in the dashboard table (bulk actions apply to these). */
	let selectedIds = new SvelteSet<string>();
	/** True while a bulk action (archive/delete/export/reset) is running. */
	let bulkBusy = $state(false);
	/** Human label of the running bulk action (progress line). */
	let bulkAction = $state<string | null>(null);
	/** Process start timestamp — drives the elapsed stopwatch in the bar. */
	let processStartedAt = $derived(runRegistry.process.startedAt);
	/** Process target count — drives "N of M done" from live statuses. */
	let processTargetCount = $derived(runRegistry.process.targetCount);
	/** Elapsed seconds while processing (ticks via interval while active). */
	let processElapsed = $state(0);
	/**
	 * Live batch progress from GET /api/submissions/process/status (current
	 * notebook, per-notebook elapsed, done/total, auto-fix counts). Null
	 * until the first poll succeeds — the UI falls back to status-derived
	 * counters.
	 */
	let processStatus = $state<ProcessProgress | null>(null);
	/** Elapsed seconds of the current notebook (ticks with the stopwatch). */
	let processCurrentElapsed = $state(0);
	/** Captured executor pipeline log lines (polls while processing). */
	let logEntries = $state<ExecutorLogEntry[]>([]);
	let logsLoading = $state(false);
	let logsError = $state<string | null>(null);
	/**
	 * Live batch pre-evaluation progress from GET
	 * /api/submissions/pre-evaluate/status. Null until the first poll
	 * succeeds — the run still works, the panel just shows no live counts.
	 */
	let preEvalStatus = $state<PreEvalProgress | null>(null);
	/** Pre-evaluation run start timestamp — drives polling + the live badge. */
	let preEvalStartedAt = $derived(runRegistry.preEval.startedAt);
	/** Pre-evaluation run target count — drives "N of M" from live statuses. */
	let preEvalTargetCount = $derived(runRegistry.preEval.targetCount);
	/** Elapsed seconds while pre-evaluating (ticks via the shared stopwatch). */
	let preEvalElapsed = $state(0);
	/** Bulk delete confirm dialog. */
	let bulkDeleteOpen = $state(false);
	/** Bulk reset confirm dialog. */
	let bulkResetOpen = $state(false);
	/** Pre-evaluation reset confirm dialog. */
	let preEvalResetOpen = $state(false);
	/** True while the pre-evaluation reset POST is in flight. */
	let preEvalResetBusy = $state(false);
	/**
	 * True while a pre-evaluation run is starting or in flight — the reset
	 * must not race the run's writers (the route also refuses with 409). The
	 * shared registry's startedAt is armed by the dashboard's POST handler and
	 * by the reload-mid-run restore, so a dashboard-started run also disables
	 * the Reset button here (BUG-008).
	 */
	let preEvalRunning = $derived(
		runRegistry.preEval.startedAt !== null || (preEvalStatus?.running ?? false),
	);
	/** The assignment has pre-evaluated rows — something to reset. */
	let canResetPreEvaluation = $derived(submissions.some((s) => s.status === "pre-evaluated"));

	/**
	 * Action scope: the selection when rows are selected, otherwise the whole
	 * batch. One bar, one button set — the scope is shown in the label.
	 */
	let scopeIds = $derived(selectedIds.size > 0 ? [...selectedIds] : submissions.map((s) => s.id));
	let scopeList = $derived(submissions.filter((s) => scopeIds.includes(s.id)));

	/** Human scope label for the bar + confirm dialogs. */
	let scopeLabel = $derived(
		selectedIds.size > 0
			? `${selectedIds.size} selected`
			: `All ${submissions.length} submissions`,
	);

	/** Ids visible under the current search/status/confidence filter (bar "Select all in view"). */
	let visibleIds = $derived(
		filterSubmissions(submissions, { statusFilter, confidenceFilter, searchQuery }).map(
			(s) => s.id,
		),
	);

	/** Action eligibility based on the scope rows' statuses. */
	let bulkCanArchive = $derived(scopeList.some((s) => s.status !== "archived"));
	let bulkCanRestore = $derived(scopeList.some((s) => s.status === "archived"));
	let bulkCanProcess = $derived(
		scopeList.some(
			(s) => s.status === "pending" || s.status === "executing" || s.status === "error",
		),
	);
	let bulkCanReset = $derived(
		scopeList.some((s) => s.status === "graded" || s.status === "pre-evaluated"),
	);

	/** Short id preview for the destructive confirm dialogs. */
	let selectionPreview = $derived(
		scopeIds.length <= 5
			? scopeIds.join(", ")
			: `${scopeIds.slice(0, 5).join(", ")} +${scopeIds.length - 5} more`,
	);

	/** Number of the current process batch that has settled (executed/error). */
	let processDone = $derived(
		processStartedAt === null
			? 0
			: submissions.filter((s) => processTargetIds.has(s.id) && s.status !== "executing")
					.length,
	);
	/** Ids targeted by the current process run (settled rows leave the set). */
	const processTargetIds = new SvelteSet<string>();

	// Stopwatch: tick every second while a process or pre-evaluation run is
	// active (each counter only advances while its own run is in flight).
	$effect(() => {
		if (processStartedAt === null && preEvalStartedAt === null) return;
		const tick = () => {
			if (processStartedAt !== null) {
				processElapsed = Math.floor((Date.now() - processStartedAt) / 1000);
			}
			if (preEvalStartedAt !== null) {
				preEvalElapsed = Math.floor((Date.now() - preEvalStartedAt) / 1000);
			}
			processCurrentElapsed =
				processStatus?.currentStartedAt != null
					? Math.floor((Date.now() - processStatus.currentStartedAt) / 1000)
					: 0;
		};
		tick();
		const timer = setInterval(tick, 1000);
		return () => clearInterval(timer);
	});

	// ── Live batch progress + pipeline logs (polls while a run runs) ──
	async function refreshProcessStatus() {
		try {
			processStatus = await fetchProcessStatus();
		} catch {
			// Keep the last good status; the status-derived counters cover us.
		}
	}

	async function refreshPreEvalStatus() {
		try {
			preEvalStatus = await fetchPreEvalStatus();
		} catch {
			// Keep the last good status; the run still progresses server-side.
		}
	}

	/**
	 * Restore in-flight run trackers after a page reload from the unified
	 * GET /api/pipeline/status (one call instead of two). Only re-arms the
	 * stopwatch/polling; the per-run status endpoints still drive the data.
	 */
	async function fetchPipelineStatus(): Promise<void> {
		try {
			const res = await fetch(`${base}/api/pipeline/status`);
			if (!res.ok) return;
			const status = (await res.json()) as {
				process?: ProcessProgress | null;
				preEval?: PreEvalProgress | null;
			};
			const process = status.process;
			if (process?.running && process.startedAt != null) {
				markRunStarted("process", process.total, process.startedAt);
				processElapsed = Math.floor((Date.now() - process.startedAt) / 1000);
			}
			const preEval = status.preEval;
			if (preEval?.running && preEval.startedAt != null) {
				markRunStarted("preEval", preEval.total, preEval.startedAt);
				preEvalElapsed = Math.floor((Date.now() - preEval.startedAt) / 1000);
			}
			// A recovered run means row statuses are changing server-side —
			// refresh the table immediately so it shows the live state, and the
			// polling effect keeps it synced (every 5s) from here on. Skipped
			// when the assignment list hasn't resolved yet — the effect on
			// selectedAssignment loads the table as soon as it is set.
			if ((process?.running || preEval?.running) && selectedAssignment) {
				void loadSubmissions();
			}
		} catch {
			// The per-run status fetches below still restore the tallies; a
			// missing unified endpoint must not break the dashboard.
		}
	}

	/**
	 * Fetch executor + pre-evaluation log lines and merge them into one
	 * timeline (oldest → newest). Each source is fetched independently so a
	 * dead executor never hides pre-eval entries (or vice versa); the error
	 * state is only shown when BOTH sources fail. The calls are deferred
	 * into promise callbacks so a missing/undefined fetcher (partial API
	 * mocks) surfaces as a per-source rejection, not a synchronous throw.
	 */
	async function refreshLogs() {
		logsLoading = true;
		const [executor, preEval] = await Promise.allSettled([
			Promise.resolve().then(() => fetchExecutorLogs(200)),
			Promise.resolve().then(() => fetchPreEvalLogs(200)),
		]);
		const merged: ExecutorLogEntry[] = [];
		const failures: string[] = [];
		if (executor.status === "fulfilled") {
			merged.push(
				...executor.value.entries.map((e) => ({ ...e, source: "executor" as const })),
			);
		} else {
			failures.push(
				executor.reason instanceof Error
					? executor.reason.message
					: "Executor logs unavailable",
			);
		}
		if (preEval.status === "fulfilled") {
			merged.push(...preEval.value.entries);
		} else {
			failures.push(
				preEval.reason instanceof Error
					? preEval.reason.message
					: "Pre-evaluation logs unavailable",
			);
		}
		merged.sort((a, b) => a.ts - b.ts);
		logEntries = merged;
		logsError = failures.length === 2 ? failures.join("; ") : null;
		logsLoading = false;
	}

	/** Last time the submissions store was refreshed by the run poller (ms epoch). */
	let lastStoreRefresh = 0;

	$effect(() => {
		if (processStartedAt === null && preEvalStartedAt === null) return;
		// Immediate fetch + poll every 2s while a batch run is active.
		void refreshProcessStatus();
		void refreshPreEvalStatus();
		void refreshLogs();
		const timer = setInterval(() => {
			void refreshProcessStatus();
			void refreshPreEvalStatus();
			void refreshLogs();
			// Table sync during an active run: refresh the store at most
			// every 5s so row statuses stay current without hammering the
			// list endpoint. refresh() keeps the last-good list and only
			// records the error (BUG-011) — the page never flaps into
			// loading or throws mid-poll, unlike load().
			if (selectedAssignment && Date.now() - lastStoreRefresh > 5000) {
				lastStoreRefresh = Date.now();
				void submissionsStore.refresh();
			}
		}, 2000);
		return () => clearInterval(timer);
	});

	// BUG-020: keep the store's 2s list-polling loop alive while a
	// pre-evaluation run is in flight so dashboard rows update live mid-run —
	// the pre-evaluate path produces no pending/executing rows, so row-status
	// polling alone would never keep the loop going. Stops when the run ends.
	$effect(() => {
		submissionsStore.setPreEvalActive(runRegistry.preEval.running);
	});

	// Restore run state after a page reload: the unified pipeline status
	// re-arms in-flight run trackers (stopwatch/polling), and the per-run
	// status fetches restore the final tallies (the executor's log buffer
	// persists, and each status keeps its final tallies).
	$effect(() => {
		void fetchPipelineStatus();
		void refreshProcessStatus();
		void refreshPreEvalStatus();
	});

	/** Done/total for the bulk bar — server status wins, statuses fall back. */
	let progressDone = $derived(processStatus?.done ?? Math.min(processDone, processTargetCount));
	let progressTotal = $derived(processStatus?.total ?? processTargetCount);
	let progressCurrentId = $derived(processStatus?.currentStudentId ?? null);
	/** Auto-fix line shown only when at least one attempt happened. */
	let progressAutofix = $derived(
		(processStatus?.autofixAttempts ?? 0) > 0
			? `${processStatus?.autofixSucceeded ?? 0}/${processStatus?.autofixAttempts ?? 0}`
			: null,
	);
	/** Completed-run summary chip for the log panel header. */
	let logSummary = $derived(
		processStatus && !processStatus.running && processStatus.total > 0
			? `${processStatus.done}/${processStatus.total} notebooks${
					(processStatus.autofixAttempts ?? 0) > 0
						? ` · auto-fix ${processStatus.autofixSucceeded}/${processStatus.autofixAttempts}`
						: ""
				}`
			: null,
	);

	/**
	 * Completed pre-evaluation run tallies for the log panel banner. The POST
	 * response wins (it carries exact succeeded/failed counts and is written
	 * to the shared registry by the dashboard's handler — BUG-007); after a
	 * page reload the status endpoint's retained final tallies are the
	 * fallback.
	 */
	let preEvalBanner = $derived(
		runRegistry.preEval.summary ??
			(preEvalStatus && !preEvalStatus.running && preEvalStatus.total > 0
				? {
						submitted: preEvalStatus.total,
						succeeded: preEvalStatus.succeeded,
						failed: preEvalStatus.failed,
					}
				: null),
	);

	/**
	 * Live done/total for the log panel's compact collapsed strip — the
	 * active run wins (batch process status first, pre-evaluation second).
	 */
	let logProgress = $derived(
		processStartedAt !== null && processStatus
			? { done: processStatus.done, total: processStatus.total }
			: preEvalStartedAt !== null && preEvalStatus
				? { done: preEvalStatus.done, total: preEvalStatus.total }
				: null,
	);

	/**
	 * Live pre-evaluation progress for the progress bar — the server status
	 * wins; the restored target count is the fallback while the first poll
	 * is still in flight.
	 */
	let preEvalBarDone = $derived(preEvalStatus?.done ?? 0);
	let preEvalBarTotal = $derived(preEvalStatus?.total ?? preEvalTargetCount);

	/** Format elapsed seconds as m:ss (or h:mm:ss past an hour). */
	function formatElapsed(total: number): string {
		const s = Math.max(0, Math.floor(total));
		const h = Math.floor(s / 3600);
		const m = Math.floor((s % 3600) / 60);
		const sec = s % 60;
		const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
		const ss = String(sec).padStart(2, "0");
		return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
	}

	/** Bulk delete confirm body (explicit batch, no typed id required). */
	let bulkDeleteMessage = $derived(
		scopeIds.length === 0
			? ""
			: `Permanently delete <span class="font-medium text-foreground">${scopeIds.length}</span> submission(s)? This removes the notebooks, execution results, and plagiarism pairs. This cannot be undone.<br><span class="font-mono text-xs">${selectionPreview}</span>`,
	);

	/** Bulk reset confirm body. */
	let bulkResetMessage = $derived(
		scopeIds.length === 0
			? ""
			: `Reset grading progress on <span class="font-medium text-foreground">${scopeIds.length}</span> submission(s)? Clears rubric selections, scores, notes, and the final grade; status returns to Executed.<br><span class="font-mono text-xs">${selectionPreview}</span>`,
	);

	// -----------------------------------------------------------------------
	// Teacher backup (download / restore the whole data directory)
	// -----------------------------------------------------------------------
	let backupFileInput: HTMLInputElement | undefined = $state(undefined);
	let backupBusy = $state(false);

	async function handleDownloadBackup() {
		if (backupBusy) return;
		backupBusy = true;
		try {
			const { fileName, content } = await downloadBackup();
			const blob = new Blob([content], { type: "application/zip" });
			const url = URL.createObjectURL(blob);
			const link = document.createElement("a");
			link.href = url;
			link.download = fileName;
			link.click();
			URL.revokeObjectURL(url);
			addToast("success", `Backup downloaded: ${fileName}`, 3500);
		} catch (e) {
			addToast("error", e instanceof Error ? e.message : "Failed to download backup", 4000);
		} finally {
			backupBusy = false;
		}
	}

	function handleOpenBackupPicker() {
		backupFileInput?.click();
	}

	async function handleRestoreBackup(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = "";
		if (!file) return;
		backupBusy = true;
		try {
			const { restored } = await restoreBackup(file);
			addToast("success", `Backup restored (${restored} files). Reloading…`, 3500);
			await loadSubmissions();
		} catch (err) {
			addToast(
				"error",
				err instanceof Error ? err.message : "Failed to restore backup",
				4000,
			);
		} finally {
			backupBusy = false;
		}
	}

	// -----------------------------------------------------------------------
	// Data loading
	// -----------------------------------------------------------------------
	$effect(() => {
		// No assignment yet (still fetching the list) — skip the empty-id call.
		if (!selectedAssignment) return;
		loadSubmissions();
	});

	// Materials indicator: re-fetch whenever the selected assignment changes.
	$effect(() => {
		const assignmentId = selectedAssignment;
		if (!assignmentId) return;
		let cancelled = false;
		fetchMaterials(assignmentId)
			.then((m) => {
				if (!cancelled) materials = m;
			})
			.catch((e) => {
				if (cancelled) return;
				materials = null;
				configError =
					e instanceof Error ? e.message : "Failed to load assignment materials";
			});
		return () => {
			cancelled = true;
		};
	});

	// Assignment dropdown: fetch the enabled list once on mount and default
	// the selection to the first assignment. Until this resolves, the
	// selector renders the "No assignments configured" placeholder.
	$effect(() => {
		void (async () => {
			try {
				const { assignments } = await fetchAssignments();
				const options = assignments.map((a) => ({ id: a.id, label: a.title }));
				assignmentOptions = options;
				selectedAssignment = options[0]?.id ?? "";
				if (options.length === 0) {
					// Nothing to load — release the skeleton so the content
					// state renders with the empty selector placeholder.
					isLoading = false;
				}
			} catch (e) {
				const message = e instanceof Error ? e.message : "Failed to load assignments";
				assignmentsError = message;
				configError = message;
				isLoading = false;
				addToast("error", message, 4000);
			}
		})();
	});

	async function loadSubmissions() {
		isLoading = true;
		error = null;
		try {
			await submissionsStore.load(selectedAssignment);
		} catch (e) {
			error = e instanceof Error ? e.message : "Failed to load submissions";
		} finally {
			isLoading = false;
		}
	}

	// -----------------------------------------------------------------------
	// Submission lifecycle: archive / restore / delete (bulk actions)
	// -----------------------------------------------------------------------

	function handleAssignmentChange(id: string) {
		selectedAssignment = id;
		// A different batch — the old selection no longer applies.
		selectedIds.clear();
		// loadSubmissions() re-runs via the $effect on selectedAssignment.
	}

	function handleSearchChange(q: string) {
		searchQuery = q;
	}

	function handleStatusFilterChange(f: string) {
		statusFilter = f;
		// Reload with archived rows when the "Archived" filter is active.
		submissionsStore.includeArchived = f === "archived";
		void loadSubmissions();
	}

	function handleConfidenceFilterChange(f: string) {
		confidenceFilter = f;
	}

	function handleToggleUploadPanel() {
		uploadPanelOpen = !uploadPanelOpen;
	}

	/** After a successful panel upload: refresh materials + keep the list fresh. */
	async function handleUploaded(results: SubmissionUploadResult[]) {
		try {
			materials = await fetchMaterials(selectedAssignment);
		} catch {
			materials = null;
		}
		// Auto-select the freshly uploaded submission rows so the teacher can
		// immediately Process/Archive them from the bulk bar. The upload
		// response carries the classified student ids — no list diffing.
		const uploaded = results
			.filter((r) => !r.error && r.kind === "submission" && r.studentId)
			.map((r) => r.studentId!);
		if (uploaded.length > 0) {
			for (const id of uploaded) selectedIds.add(id);
			addToast("info", `${uploaded.length} uploaded submission(s) auto-selected`, 3000);
		}
	}

	// -----------------------------------------------------------------------
	// Bulk selection + actions
	// -----------------------------------------------------------------------
	function handleToggleSelect(id: string) {
		if (selectedIds.has(id)) {
			selectedIds.delete(id);
		} else {
			selectedIds.add(id);
		}
	}

	function handleSelectRange(ids: string[]) {
		for (const id of ids) selectedIds.add(id);
	}

	function handleDeselectRange(ids: string[]) {
		for (const id of ids) selectedIds.delete(id);
	}

	function handleSelectAllVisible() {
		selectedIds.clear();
		for (const id of visibleIds) selectedIds.add(id);
	}

	function handleClearSelection() {
		selectedIds.clear();
	}

	/** Run a bulk op with busy/progress state and shared error handling. */
	async function runBulk(label: string, fn: () => Promise<void>) {
		if (bulkBusy) return;
		bulkBusy = true;
		bulkAction = label;
		try {
			await fn();
		} catch (e) {
			addToast("error", e instanceof Error ? e.message : `${label} failed`, 4000);
		} finally {
			bulkBusy = false;
			bulkAction = null;
		}
	}

	/** Drop archived ids from the selection after archive/restore/delete. */
	function removeFromSelection(ids: string[]) {
		for (const id of ids) selectedIds.delete(id);
	}

	async function handleBulkArchive() {
		const ids = scopeIds.filter((id) => {
			const sub = submissions.find((s) => s.id === id);
			return sub && sub.status !== "archived";
		});
		if (ids.length === 0) return;
		await runBulk("Archiving", async () => {
			await submissionsStore.archiveMany(ids, "archive");
			removeFromSelection(ids);
			addToast("success", `Archived ${ids.length} submission(s)`, 3000);
		});
	}

	async function handleBulkRestore() {
		const ids = scopeIds.filter((id) => {
			const sub = submissions.find((s) => s.id === id);
			return sub && sub.status === "archived";
		});
		if (ids.length === 0) return;
		await runBulk("Restoring", async () => {
			await submissionsStore.archiveMany(ids, "restore");
			removeFromSelection(ids);
			addToast("success", `Restored ${ids.length} submission(s)`, 3000);
		});
	}

	async function handleBulkDelete() {
		const ids = scopeIds;
		if (ids.length === 0) return;
		await runBulk("Deleting", async () => {
			await submissionsStore.deleteMany(ids);
			removeFromSelection(ids);
			addToast("success", `Deleted ${ids.length} submission(s)`, 3000);
		});
		bulkDeleteOpen = false;
	}

	function downloadBlob(fileName: string, blob: Blob) {
		const url = URL.createObjectURL(blob);
		const link = document.createElement("a");
		link.href = url;
		link.download = fileName;
		link.click();
		URL.revokeObjectURL(url);
	}

	/** Export the scope rows: single YAML when one, a zip bundle when many. */
	async function handleBulkExport(kind: "student" | "teacher") {
		const ids = scopeIds;
		if (ids.length === 0 || bulkBusy) return;
		bulkBusy = true;
		bulkAction = kind === "student" ? "Exporting" : "Exporting teacher copies";
		try {
			if (ids.length === 1) {
				const { fileName, content } = await submissionsStore.export(ids[0], kind);
				downloadBlob(fileName, new Blob([content], { type: "text/yaml" }));
			} else {
				const files: Record<string, Uint8Array> = {};
				for (const id of ids) {
					const { fileName, content } = await submissionsStore.export(id, kind);
					files[fileName] = strToU8(content);
				}
				const zipped = zipSync(files);
				downloadBlob(
					`submissions-${kind}-${new Date().toISOString().slice(0, 10)}.zip`,
					new Blob([zipped], { type: "application/zip" }),
				);
			}
			addToast("success", `Exported ${ids.length} submission(s)`, 3000);
		} catch (e) {
			addToast("error", e instanceof Error ? e.message : "Export failed", 4000);
		} finally {
			bulkBusy = false;
			bulkAction = null;
		}
	}

	async function handleBulkProcess() {
		const ids = scopeIds.filter((id) => {
			const sub = submissions.find((s) => s.id === id);
			return (
				sub &&
				(sub.status === "pending" || sub.status === "executing" || sub.status === "error")
			);
		});
		if (ids.length === 0 || bulkBusy) return;
		bulkBusy = true;
		bulkAction = "Processing";
		processTargetIds.clear();
		for (const id of ids) processTargetIds.add(id);
		markRunStarted("process", ids.length);
		processElapsed = 0;
		processStatus = null;
		submissionsStore.startPolling(); // live row statuses while the batch runs
		try {
			const resp = await submissionsStore.process(ids);
			addToast(
				"success",
				`Processed ${resp.succeeded} of ${resp.submitted} submission(s)${resp.failed > 0 ? `, ${resp.failed} failed` : ""}`,
				5000,
			);
		} catch (e) {
			addToast("error", e instanceof Error ? e.message : "Batch processing failed", 5000);
		} finally {
			bulkBusy = false;
			bulkAction = null;
			markRunFinished("process");
			processTargetIds.clear();
			// Fetch once more — the route already wrote its final tallies, so
			// the panel can show the completed run summary (done/total, autofix).
			void refreshProcessStatus();
		}
	}

	async function handleBulkReset() {
		const ids = scopeIds.filter((id) => {
			const sub = submissions.find((s) => s.id === id);
			return sub && (sub.status === "graded" || sub.status === "pre-evaluated");
		});
		if (ids.length === 0) return;
		await runBulk("Resetting", async () => {
			await submissionsStore.resetMany(ids);
			addToast("success", `Reset ${ids.length} submission(s) to executed`, 3000);
		});
		bulkResetOpen = false;
	}

	/**
	 * Reset pre-evaluation for the whole assignment: POST to
	 * /api/submissions/pre-evaluate/reset, which flips rows back to
	 * "executed" and clears the stored preEval envelopes so the batch can be
	 * pre-evaluated again. Grading data is untouched.
	 */
	async function handlePreEvalReset() {
		if (preEvalResetBusy || preEvalRunning) return;
		preEvalResetBusy = true;
		try {
			const res = await fetch(`${base}/api/submissions/pre-evaluate/reset`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ assignmentId: selectedAssignment }),
			});
			if (res.status === 409) {
				addToast("error", "A pre-evaluation run is in progress", 4000);
				return;
			}
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { message?: string } | null;
				throw new Error(body?.message ?? `Pre-evaluation reset failed (${res.status})`);
			}
			const body = (await res.json()) as { reset: number };
			addToast(
				"success",
				`${body.reset} submission(s) reset. Run pre-evaluation to regenerate.`,
				4000,
			);
			// The route flipped rows back to "executed" — refresh the list so
			// the table shows the re-runnable statuses immediately.
			await submissionsStore.refresh();
		} catch (e) {
			addToast("error", e instanceof Error ? e.message : "Pre-evaluation reset failed", 4000);
		} finally {
			preEvalResetBusy = false;
		}
		preEvalResetOpen = false;
	}
</script>

<svelte:head>
	<title>SciPro Review — Submissions</title>
</svelte:head>

<!-- ================================================================ -->
<!-- Loading state -->
<!-- ================================================================ -->
{#if isLoading}
	<div class="page-layout">
		<!-- Assignment row skeleton -->
		<div class="assign-upload-row">
			<SkeletonPulse class="h-[34px] w-[360px] rounded-[var(--radius-md)]" />
			<SkeletonPulse class="h-[34px] w-[110px] rounded-[var(--radius)]" />
		</div>

		<!-- Materials skeleton -->
		<div class="materials-section">
			<SkeletonPulse class="h-3 w-48" />
		</div>

		<!-- Table card skeleton -->
		<div class="overflow-hidden rounded-[var(--radius-lg)] border border-border">
			<!-- Toolbar -->
			<div class="flex items-center gap-3 border-b border-border px-3.5 py-2">
				<SkeletonPulse class="h-7 w-[260px] rounded-[var(--radius-md)]" />
				<SkeletonPulse class="h-7 w-[140px] rounded-[var(--radius-md)]" />
			</div>
			<!-- Table header -->
			<div class="flex items-center gap-4 border-b border-border px-3.5 py-2.5">
				<SkeletonPulse class="h-3 w-[13%]" />
				<SkeletonPulse class="h-3 w-[14%]" />
				<SkeletonPulse class="h-3 w-[15%]" />
				<SkeletonPulse class="h-3 w-[13%]" />
				<SkeletonPulse class="h-3 w-[12%]" />
			</div>
			<!-- Table rows -->
			{#each [1, 2, 3, 4, 5] as _i (_i)}
				<div
					class="flex items-center gap-4 border-b border-border px-3.5 py-2.5 last:border-0"
				>
					<SkeletonPulse class="h-3 w-[13%]" />
					<SkeletonPulse class="h-4 w-[14%] rounded-full" />
					<SkeletonPulse class="h-3 w-[15%]" />
					<SkeletonPulse class="h-3 w-[13%]" />
					<SkeletonPulse class="h-3 w-[12%]" />
					<SkeletonPulse class="ml-auto h-6 w-14 rounded-[var(--radius-md)]" />
				</div>
			{/each}
		</div>

		<!-- Action bar skeleton -->
		<div class="flex items-center gap-2">
			<SkeletonPulse class="h-8 w-[110px] rounded-[var(--radius)]" />
			<SkeletonPulse class="h-8 w-[130px] rounded-[var(--radius)]" />
		</div>

		<!-- Upload bar skeleton -->
		<SkeletonPulse class="h-9 w-full rounded-[var(--radius-md)]" />
	</div>

	<!-- ================================================================ -->
	<!-- Error state -->
	<!-- ================================================================ -->
{:else if error}
	<div class="flex items-center justify-center px-6 py-20 md:px-10 lg:px-16 xl:px-24">
		<div class="max-w-md text-center">
			<AlertTriangle size={40} class="mx-auto text-destructive" />
			<h2 class="mt-4 text-lg font-semibold text-foreground">Something went wrong</h2>
			<p class="mt-2 text-sm text-muted-foreground">{error}</p>
			<div class="mt-6 flex items-center justify-center gap-3">
				<button
					onclick={loadSubmissions}
					class="inline-flex items-center gap-2 rounded-[var(--radius)] bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
				>
					<RefreshCw size={14} />
					Try again
				</button>
				<a
					href={base}
					class="inline-flex items-center gap-1 rounded-[var(--radius)] border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-black/5 dark:hover:bg-white/10"
				>
					Go to Dashboard
				</a>
			</div>
		</div>
	</div>

	<!-- ================================================================ -->
	<!-- Content state -->
	<!-- ================================================================ -->
{:else}
	<div class="page-layout">
		<!-- ── Assignment row ── -->
		<div class="assign-upload-row">
			<AssignmentSelector
				assignments={assignmentOptions}
				selected={selectedAssignment}
				onChange={handleAssignmentChange}
			/>
			<Button variant="outline" size="sm" onclick={handleToggleUploadPanel}>
				<Upload size={14} />
				{uploadPanelOpen ? "Close Upload" : "Upload More"}
			</Button>
		</div>

		<!-- ── Upload Panel (inline, toggled by "Upload More" button) ── -->
		{#if uploadPanelOpen}
			<div transition:slide={{ duration: 180 }}>
				<UploadPanel
					inline={true}
					assignmentId={selectedAssignment}
					onUploaded={handleUploaded}
				/>
			</div>
		{/if}

		<!-- ── Materials: indicator (toggles the manager) + management panel ── -->
		<div class="materials-section">
			<button
				class="materials-toggle"
				title="Manage assignment materials (upload, replace, delete)"
				onclick={() => (materialsOpen = !materialsOpen)}
			>
				<MaterialsIndicator
					materials={[
						{ label: "PDF", present: materials?.hasPdf ?? false },
						{ label: "Key", present: materials?.hasKey ?? false },
						{ label: "Data", present: materials?.hasInputData ?? false },
					]}
				/>
				<span class="materials-toggle-label">{materialsOpen ? "Hide" : "Manage"}</span>
			</button>
			{#if materialsOpen}
				<MaterialsManager
					assignmentId={selectedAssignment}
					{materials}
					onChange={(status) => (materials = status)}
				/>
			{/if}
		</div>

		<!-- ── Dashboard table ── -->
		{#if configError}
			<ConfigErrorBanner message={configError} onDismiss={() => (configError = null)} />
		{/if}
		<SubmissionsDashboard
			{submissions}
			{searchQuery}
			{statusFilter}
			{confidenceFilter}
			assignmentId={selectedAssignment}
			{selectedIds}
			onToggleSelect={handleToggleSelect}
			onSelectRange={handleSelectRange}
			onDeselectRange={handleDeselectRange}
			onSelectAllVisible={handleSelectAllVisible}
			onClearSelection={handleClearSelection}
			onSearchChange={handleSearchChange}
			onStatusFilterChange={handleStatusFilterChange}
			onConfidenceFilterChange={handleConfidenceFilterChange}
		>
			{#snippet toolbarActions()}
				<a
					class={cn(buttonVariants({ variant: "outline", size: "sm" }), "gap-1.5")}
					href={`${base}/settings/assignments`}
					title="Manage the assignment registry"
				>
					<FolderCog size={14} />
					Manage Assignments
				</a>
				{#snippet backupIcon()}
					<HardDriveDownload size={14} />
				{/snippet}
				<MenuButton
					label="Backup"
					title="Download or restore a teacher backup of the data directory"
					primaryOnClick={handleDownloadBackup}
					items={[
						{
							id: "restore",
							label: "Restore backup…",
							description: "Import a teacher backup zip (replaces data directory)",
							onclick: handleOpenBackupPicker,
						},
					]}
					icon={backupIcon}
				/>
				<input
					type="file"
					accept=".zip,application/zip"
					hidden
					bind:this={backupFileInput}
					onchange={handleRestoreBackup}
				/>
			{/snippet}
		</SubmissionsDashboard>

		<!-- ── Bulk action bar: one button set; scope = selection or all ── -->
		{#if assignmentsError}
			<p class="assignments-error">Assignments unavailable: {assignmentsError}</p>
		{/if}
		<div class="bulk-bar">
			<div class="bulk-info" aria-live="polite">
				<span class="bulk-count">
					{scopeLabel}
					<span class="bulk-context">({visibleIds.length} in view)</span>
				</span>
				{#if selectedIds.size > 0}
					<Button
						variant="ghost"
						size="sm"
						title="Select every submission currently visible"
						onclick={handleSelectAllVisible}
						disabled={bulkBusy}
					>
						<ListChecks size={14} />
						Select all in view
					</Button>
					<Button
						variant="ghost"
						size="sm"
						title="Clear the current selection"
						aria-label="Clear selection"
						onclick={handleClearSelection}
						disabled={bulkBusy}
					>
						<X size={14} />
					</Button>
				{/if}
				{#if bulkBusy && bulkAction}
					<span class="bulk-progress">
						<span class="progress-spinner" aria-hidden="true"></span>
						{bulkAction}… {#if processStartedAt !== null && processTargetCount > 0}
							<span class="progress-count">
								{progressDone}/{progressTotal}
								{#if progressCurrentId}
									· {progressCurrentId} ({formatElapsed(processCurrentElapsed)})
								{/if}
								· total {formatElapsed(processElapsed)}
								{#if progressAutofix}· auto-fix {progressAutofix}{/if}
							</span>
						{/if}
					</span>
				{/if}
			</div>
			<div class="bulk-actions">
				{#if bulkCanRestore}
					<Button
						variant="outline"
						size="sm"
						title="Restore the archived submissions to the active batch"
						onclick={handleBulkRestore}
						disabled={bulkBusy}
					>
						<ArchiveRestore size={14} />
						Restore
					</Button>
				{:else}
					<Button
						variant="outline"
						size="sm"
						title="Archive the submissions (hidden, restorable)"
						onclick={handleBulkArchive}
						disabled={bulkBusy || !bulkCanArchive}
					>
						<Archive size={14} />
						Archive
					</Button>
				{/if}
				<Button
					variant="outline"
					size="sm"
					title="Permanently delete the submissions"
					onclick={() => (bulkDeleteOpen = true)}
					disabled={bulkBusy}
					class="text-destructive hover:text-destructive"
				>
					<Trash2 size={14} />
					Delete
				</Button>
				{#snippet bulkExportIcon()}
					<Download size={14} />
				{/snippet}
				<MenuButton
					label="Export"
					title="Export the submissions (student or teacher copy)"
					primaryOnClick={() => handleBulkExport("student")}
					items={[
						{
							id: "teacher",
							label: "Export teacher YAML",
							description: "Full record + plagiarism audit (-teacher)",
							onclick: () => handleBulkExport("teacher"),
						},
					]}
					icon={bulkExportIcon}
				/>
				<Button
					variant="default"
					size="sm"
					title="Execute the pending submissions"
					onclick={handleBulkProcess}
					disabled={bulkBusy || !bulkCanProcess}
				>
					<Play size={14} />
					Process
				</Button>
				<Button
					variant="outline"
					size="sm"
					title="Clear pre-evaluation results for the whole assignment so the batch can be pre-evaluated again"
					onclick={() => (preEvalResetOpen = true)}
					disabled={bulkBusy ||
						preEvalResetBusy ||
						preEvalRunning ||
						!canResetPreEvaluation}
				>
					<Eraser size={14} />
					Reset Pre-Evaluation
				</Button>
				<Button
					variant="outline"
					size="sm"
					title="Reset grading progress on the submissions"
					onclick={() => (bulkResetOpen = true)}
					disabled={bulkBusy || !bulkCanReset}
				>
					<RotateCcw size={14} />
					Reset
				</Button>
			</div>
		</div>

		<!-- ── Pipeline progress: live run bars (process + pre-evaluation) ── -->
		{#if processStartedAt !== null || preEvalStartedAt !== null}
			{#if processStartedAt !== null}
				<PipelineProgressBar
					done={progressDone}
					total={progressTotal}
					currentId={progressCurrentId}
					elapsed={formatElapsed(processElapsed)}
					autofixAttempts={processStatus?.autofixAttempts ?? 0}
					autofixSucceeded={processStatus?.autofixSucceeded ?? 0}
					running={processStartedAt !== null}
				/>
			{/if}
			{#if preEvalStartedAt !== null}
				<PipelineProgressBar
					label="Pre-evaluating batch"
					done={preEvalBarDone}
					total={preEvalBarTotal}
					currentId={preEvalStatus?.currentStudentId ?? null}
					elapsed={formatElapsed(preEvalElapsed)}
					running={preEvalStartedAt !== null}
				/>
			{/if}
		{/if}

		<!-- ── Pipeline log: executor + pre-evaluation activity (collapsible) ── -->
		<PipelineLogPanel
			entries={logEntries}
			live={processStartedAt !== null || preEvalStartedAt !== null}
			loading={logsLoading}
			error={logsError}
			summary={logSummary}
			preEvalSummary={preEvalBanner}
			progress={logProgress}
			onRefresh={refreshLogs}
		/>

		<!-- ── Assignment copilot (teacher build only, collapsible) ── -->
		{#if apiMode.value}
			<div class="copilot-panel" class:copilot-panel-open={copilotOpen}>
				<button
					class="copilot-toggle"
					type="button"
					aria-expanded={copilotOpen}
					onclick={() => (copilotOpen = !copilotOpen)}
				>
					<Sparkles size={14} />
					<span class="copilot-title">AI Copilot</span>
					<span class="copilot-scope">Assignment: {selectedAssignment}</span>
					{#if copilotOpen}
						<ChevronUp size={14} />
					{:else}
						<ChevronDown size={14} />
					{/if}
				</button>
				{#if copilotOpen}
					<div class="copilot-body">
						<CopilotPanel assignmentId={selectedAssignment} />
					</div>
				{/if}
			</div>
		{/if}
	</div>
{/if}

<!-- Bulk delete confirmation (the batch is explicit in the message). -->
<ConfirmationDialog
	open={bulkDeleteOpen}
	title="Delete Submissions"
	message={bulkDeleteMessage}
	confirmLabel="Delete"
	variant="danger"
	onconfirm={handleBulkDelete}
	oncancel={() => (bulkDeleteOpen = false)}
/>

<!-- Bulk reset confirmation. -->
<ConfirmationDialog
	open={bulkResetOpen}
	title="Reset Submissions"
	message={bulkResetMessage}
	confirmLabel="Reset"
	variant="danger"
	onconfirm={handleBulkReset}
	oncancel={() => (bulkResetOpen = false)}
/>

<!-- Pre-evaluation reset confirmation (whole assignment). -->
<ConfirmationDialog
	open={preEvalResetOpen}
	title="Reset Pre-Evaluation"
	message="This will clear all pre-evaluation results for the selected assignment. Run pre-evaluation again to regenerate."
	confirmLabel="Reset"
	variant="danger"
	onconfirm={handlePreEvalReset}
	oncancel={() => (preEvalResetOpen = false)}
/>

<style>
	.page-layout {
		padding: 24px 32px;
		max-width: 1200px;
		margin: 0 auto;
		width: 100%;
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	/* ── Assignment + Upload row ── */
	.assign-upload-row {
		display: flex;
		align-items: center;
		gap: 12px;
		flex-wrap: wrap;
	}

	/* ── Mobile dashboard ── */
	@media (max-width: 767px) {
		.page-layout {
			padding: 12px 16px;
			gap: 12px;
		}
		.assign-upload-row {
			flex-direction: column;
			align-items: stretch;
		}
	}

	/* ── Materials indicator ── */
	.materials-section {
		padding: 0 14px;
		/* Match table cell horizontal padding so text aligns with card contents */
	}
	.materials-toggle {
		display: inline-flex;
		align-items: center;
		gap: 10px;
		background: transparent;
		border: none;
		cursor: pointer;
		padding: 2px 0;
		font: inherit;
	}
	.materials-toggle-label {
		font-size: 11px;
		font-weight: 500;
		color: var(--primary);
	}

	/* ── Bulk action bar (single set; scope = selection or all) ── */
	.assignments-error {
		margin: 0;
		font-size: 13px;
		color: var(--destructive);
	}
	.bulk-bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		flex-wrap: wrap;
		padding: 10px 14px;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--card);
	}
	.bulk-info {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}
	.bulk-count {
		display: inline-flex;
		align-items: baseline;
		gap: 6px;
		font-size: 13px;
		font-weight: 600;
		color: var(--fg);
	}
	.bulk-context {
		font-size: 12px;
		font-weight: 400;
		color: var(--muted-foreground);
	}
	.bulk-progress {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 12px;
		font-style: italic;
		color: var(--muted-foreground);
	}
	.progress-spinner {
		width: 12px;
		height: 12px;
		border-radius: 999px;
		border: 2px solid color-mix(in oklch, var(--accent) 30%, transparent);
		border-top-color: var(--accent);
		animation: progress-spin 0.8s linear infinite;
	}
	@keyframes progress-spin {
		to {
			transform: rotate(360deg);
		}
	}
	.progress-count {
		font-style: normal;
		font-variant-numeric: tabular-nums;
		color: var(--fg);
	}
	.bulk-actions {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}

	/* ── Responsive ── */
	@media (max-width: 900px) {
		.page-layout {
			padding: 16px;
		}
		.assign-upload-row {
			flex-direction: column;
			align-items: stretch;
		}
		.bulk-bar {
			flex-direction: column;
			align-items: flex-start;
		}
	}

	/* ── Assignment copilot (collapsible panel, matches PipelineLogPanel) ── */
	.copilot-panel {
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--card);
		overflow: hidden;
	}
	.copilot-toggle {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		padding: 8px 14px;
		background: transparent;
		border: none;
		cursor: pointer;
		font: inherit;
		color: var(--fg);
	}
	.copilot-title {
		font-size: 13px;
		font-weight: 600;
	}
	.copilot-scope {
		margin-left: auto;
		font-size: 11px;
		font-weight: 500;
		color: var(--muted-foreground);
		font-variant-numeric: tabular-nums;
	}
	.copilot-body {
		border-top: 1px solid var(--border);
		height: 420px;
	}
</style>
