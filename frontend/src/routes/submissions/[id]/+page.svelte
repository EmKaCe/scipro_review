<script lang="ts">
	import { submissionsStore } from "$lib/services/submissions-store.js";
	import { plagiarismStore } from "$lib/services/plagiarism-store.svelte.js";
	import { autofixStore } from "$lib/services/autofix-store.svelte.js";
	import { headerConfig } from "$lib/stores/header.svelte.js";
	import { addToast } from "$lib/stores/toast.svelte.js";
	import { page } from "$app/state";
	import { base } from "$app/paths";
	import type { SubmissionDetail } from "$lib/types/submissions.js";
	import type { GradingConfig, GradingInputs, GradeResult } from "$lib/types/grading.js";
	import type { MergedRubric, CategoryKey } from "$lib/types/criteria.js";
	import type { CategorySelections, ReviewSession } from "$lib/types/session.js";
	import { defaultGradingInputs } from "$lib/types/grading.js";
	import { calculateGrade } from "$lib/services/grade-calculator.js";
	import { getCriteriaForAssignment } from "$lib/services/criteria-loader.js";
	import { getGradingConfig } from "$lib/services/grading-config.js";
	import { generateEvaluationText } from "$lib/services/text-generator.js";
	import {
		feedbackToSelections,
		selectionsToFeedback,
	} from "$lib/services/grading-persistence.js";
	import { rubricSentimentCounts } from "$lib/types/criteria.js";
	import { statusConfig } from "$lib/components/submissions/status-config.js";
	import {
		apiMode,
		type CopilotSuggestion,
	} from "$lib/components/submissions/copilot-store.svelte.js";
	import { applySuggestionToState } from "$lib/utils/apply-suggestion.js";
	import ExecutionOutput from "$lib/components/submissions/execution-output.svelte";
	import ReferenceComparison from "$lib/components/submissions/reference-comparison.svelte";
	import RightPanelTabs from "$lib/components/submissions/right-panel-tabs.svelte";
	import MenuButton from "$lib/components/ui/menu-button.svelte";
	import { Button } from "$lib/components/ui/button/index.js";
	import { buttonVariants } from "$lib/components/ui/button/button-variants.js";
	import { cn } from "$lib/utils.js";
	import SkeletonPulse from "$lib/components/ui/skeleton-pulse.svelte";
	import AlertTriangle from "@lucide/svelte/icons/alert-triangle";
	import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
	import RefreshCw from "@lucide/svelte/icons/refresh-cw";
	import WandSparkles from "@lucide/svelte/icons/wand-sparkles";
	import FileText from "@lucide/svelte/icons/file-text";
	import PanelRightClose from "@lucide/svelte/icons/panel-right-close";
	import PanelRightOpen from "@lucide/svelte/icons/panel-right-open";
	import Files from "@lucide/svelte/icons/files";
	import ListChecks from "@lucide/svelte/icons/list-checks";
	import Gauge from "@lucide/svelte/icons/gauge";
	import ShieldCheck from "@lucide/svelte/icons/shield-check";
	import Sparkles from "@lucide/svelte/icons/sparkles";
	import Download from "@lucide/svelte/icons/download";
	import Save from "@lucide/svelte/icons/save";
	import FilePlus2 from "@lucide/svelte/icons/file-plus-2";
	import X from "@lucide/svelte/icons/x";
	import { SvelteSet } from "svelte/reactivity";

	/** Desktop right-panel tabs (mockup: Rubric | Grading | Plagiarism | Copilot). */
	type Tab = "rubric" | "grading" | "plagiarism" | "copilot";
	/** Mobile tabs (mockup: Cells | Rubric | Grade | Plagiarism | Copilot). */
	type MobileTab = "cells" | Tab;

	// -----------------------------------------------------------------------
	// Header config
	// -----------------------------------------------------------------------
	$effect(() => {
		const sub = submission;
		headerConfig.headerState = "submission";
		headerConfig.showBack = true;
		headerConfig.breadcrumb = sub ? `Submission: ${sub.studentId}` : "Submission";
		headerConfig.showSave = true;
		headerConfig.onsaveclick = handleSaveGrade;
		headerConfig.showExport = true;
		headerConfig.onexportclick = () => handleExport("student");
		headerConfig.exportMenuItems = [
			{
				id: "teacher",
				label: "Export teacher YAML",
				description: "Full record + plagiarism audit (-teacher)",
				onclick: () => handleExport("teacher"),
			},
		];
		headerConfig.showImport = true;
		headerConfig.onimportclick = () => importInput?.click();
		return () => {
			headerConfig.headerState = "dashboard";
			headerConfig.showBack = false;
			headerConfig.breadcrumb = undefined;
			headerConfig.showSave = false;
			headerConfig.onsaveclick = undefined;
			headerConfig.showExport = false;
			headerConfig.onexportclick = undefined;
			headerConfig.exportMenuItems = undefined;
			headerConfig.showImport = false;
			headerConfig.onimportclick = undefined;
		};
	});

	// -----------------------------------------------------------------------
	// State
	// -----------------------------------------------------------------------
	let submission = $state<SubmissionDetail | null>(null);
	let isLoading = $state(true);
	let error = $state<string | null>(null);
	let gradingConfig = $state<GradingConfig | null>(null);
	let gradingInputs = $state<GradingInputs>(defaultGradingInputs());
	let rubric = $state<MergedRubric | null>(null);
	/**
	 * Set when the rubric for this assignment fails to load (getCriteriaForAssignment
	 * returned null) — shown as an inline notice in the right panel Rubric tab area
	 * so a broken criteria config is never a silent null.
	 */
	let rubricError = $state<string | null>(null);
	let categorySelections = $state<Record<string, CategorySelections>>({});
	/**
	 * Top-level teacher notes (3f.5 / notes editor). Single source for the
	 * notes card; the header Save persists it via GradingPatch.notes, and
	 * autofix cell-note saves append to it and sync it back (onNotesSaved).
	 */
	let notesDraft = $state("");
	let notesCardRef: HTMLDivElement | undefined = $state();
	let activeTab = $state<Tab>("rubric");
	/** Hidden file input backing the header Import button (teacher YAML, 3i). */
	let importInput: HTMLInputElement | undefined = $state(undefined);

	// -----------------------------------------------------------------------
	// Non-destructive autofix view state (3c.3): view set is EPHEMERAL
	// (never persisted — reload always shows the authentic original);
	// dispositions are durable and ride the grading save.
	// -----------------------------------------------------------------------
	/** Indices of cells currently showing their auto-fixed version. */
	let fixedView = new SvelteSet<number>();
	/** Teacher's per-cell decision on each verified fix (durable). */
	let dispositions = $state<Record<string, "accepted" | "ignored">>({});

	// -----------------------------------------------------------------------
	// Mobile state (P3-6): 5-tab bar + bottom bar
	// -----------------------------------------------------------------------
	let mobileTab = $state<MobileTab>("cells");

	// -----------------------------------------------------------------------
	// Export guard (P3-1): unreviewed plagiarism pairs block Save/Export
	// -----------------------------------------------------------------------
	let exportGuardOpen = $state(false);
	/** The action being guarded: "Export YAML" | "Save Grade". */
	let exportGuardAction = $state("Export YAML");
	/** Pending action to run after "Export anyway" resolved the guard. */
	let pendingAction: "save" | "export" | null = $state(null);
	/** Export kind requested when the guard opened ("export" pending action). */
	let pendingExportKind: "student" | "teacher" = $state("student");

	// -----------------------------------------------------------------------
	// Resizable divider + collapsible right panel
	// -----------------------------------------------------------------------
	/** Left panel width in pixels. Default: 66% of the container. */
	let leftPanelWidth = $state<number | null>(null);
	let isDragging = $state(false);
	let rightPanelCollapsed = $state(false);
	let containerRef: HTMLDivElement | undefined = $state(undefined);

	// Clamp values: right panel min 300px, max 50% of container
	const RIGHT_MIN = 300;
	const RIGHT_MAX_FRAC = 0.5;

	function getContainerWidth(): number {
		return containerRef?.clientWidth ?? 1200;
	}

	function handleDividerPointerDown(e: PointerEvent) {
		if (rightPanelCollapsed) return;
		isDragging = true;
		// Capture pointer so we get events even outside the element
		(e.target as HTMLElement).setPointerCapture(e.pointerId);
	}

	function handleDividerPointerMove(e: PointerEvent) {
		if (!isDragging || !containerRef || rightPanelCollapsed) return;
		const rect = containerRef.getBoundingClientRect();
		const cw = rect.width;
		if (cw <= 0) return;
		// x relative to container
		let x = e.clientX - rect.left;
		// Clamp: right panel min RIGHT_MIN, max 50%
		const rightMax = cw * RIGHT_MAX_FRAC;
		const leftMax = cw - RIGHT_MIN;
		const leftMin = cw - rightMax;
		x = Math.max(leftMin, Math.min(leftMax, x));
		leftPanelWidth = x;
	}

	function handleDividerPointerUp() {
		isDragging = false;
	}

	function toggleRightPanel() {
		rightPanelCollapsed = !rightPanelCollapsed;
	}

	// Reset on mobile — no custom resize below 768px
	let isMobile = $state(false);
	$effect(() => {
		if (typeof window === "undefined") return;
		const mq = window.matchMedia("(max-width: 767px)");
		function handler(e: MediaQueryListEvent | MediaQueryList) {
			isMobile = e.matches;
			if (e.matches) {
				rightPanelCollapsed = false;
				leftPanelWidth = null;
			}
		}
		handler(mq);
		mq.addEventListener("change", handler as (e: MediaQueryListEvent) => void);
		return () => mq.removeEventListener("change", handler as (e: MediaQueryListEvent) => void);
	});

	// -----------------------------------------------------------------------
	// Derived
	// -----------------------------------------------------------------------
	let gradeResult = $derived<GradeResult | null>(
		gradingConfig ? calculateGrade(gradingInputs, gradingConfig, 0) : null,
	);
	let totalDeductions = $derived(0);

	// -----------------------------------------------------------------------
	// Data loading
	// -----------------------------------------------------------------------
	$effect(() => {
		const id = page.params.id;
		if (!id) return;
		loadData(id);
	});

	async function loadData(id: string) {
		isLoading = true;
		error = null;
		try {
			// Real data: submissionsStore.select() fetches the detail from the
			// API and caches it.
			const sub = await submissionsStore.select(id);
			submission = sub;
			autofixStore.reset();

			// Load the plagiarism comparison for this assignment (badge +
			// tab data; 404 means no check yet — the tab offers a run).
			plagiarismStore.load(sub.assignmentId).catch(() => {
				// surfaced inside the Plagiarism tab / guard modal
			});

			// Load grading config via the service (teacher build fetches
			// GET /api/config/grading; student build fetches the static
			// copy). Failures leave gradingConfig null — the page renders
			// without sliders rather than erroring.
			try {
				gradingConfig = await getGradingConfig();
			} catch {
				gradingConfig = null;
			}

			// Restore dimension sliders from the persisted record (defaults
			// for dimensions that were never saved).
			const saved = sub.grading;
			gradingInputs = { ...defaultGradingInputs(), ...(saved?.dimensions ?? {}) };

			// Restore the top-level notes editor from the persisted record.
			notesDraft = saved?.notes ?? "";

			// Restore autofix dispositions (durable). The VIEW set stays
			// empty — reload always shows the authentic original first.
			dispositions = { ...(saved?.autofixDispositions ?? {}) };
			fixedView.clear();

			// Load rubric for this assignment
			const mergedRubric = await getCriteriaForAssignment(sub.assignmentId);
			rubric = mergedRubric;
			// A null rubric (loader failure) is surfaced as an inline notice in
			// the right panel Rubric tab area — never a silent empty panel.
			rubricError = mergedRubric ? null : "Rubric could not be loaded for this assignment.";

			// Restore per-category selections from the persisted feedback
			// block (record -> rubric -> selections ordering).
			if (mergedRubric && mergedRubric.categories.length > 0) {
				categorySelections = feedbackToSelections(
					saved?.feedback,
					mergedRubric.categories.map((c) => c.key),
				);
			}
		} catch (e) {
			error = e instanceof Error ? e.message : "Failed to load submission";
		} finally {
			isLoading = false;
		}
	}

	// -----------------------------------------------------------------------
	// Handlers
	// -----------------------------------------------------------------------
	function handleTabChange(tab: Tab) {
		activeTab = tab;
	}

	function handleMobileTabChange(tab: MobileTab) {
		mobileTab = tab;
	}

	/**
	 * Update a dimension slider value immutably (key = dimension id).
	 */
	function handleUpdateDimension(key: string, value: number) {
		gradingInputs = { ...gradingInputs, [key as keyof GradingInputs]: value };
	}

	/** Unreviewed pairs involving the current submission (guard trigger). */
	let unreviewedCount = $derived(
		submission ? plagiarismStore.unreviewedCount(submission.studentId) : 0,
	);

	/** Counts by status for the guard modal ("2 unreviewed · 1 accepted …"). */
	let guardCounts = $derived.by(() => {
		if (!submission) return "";
		const u = plagiarismStore.countByStatus("unreviewed", submission.studentId);
		const a = plagiarismStore.countByStatus("accepted", submission.studentId);
		const d = plagiarismStore.countByStatus("dismissed", submission.studentId);
		const i = plagiarismStore.countByStatus("ignored", submission.studentId);
		const parts = [`${u} unreviewed`, `${a} accepted`, `${d} dismissed`, `${i} ignored`];
		return parts.filter((p) => !p.startsWith("0 ")).join(" · ");
	});

	/**
	 * P3-1 export guard: while unreviewed pairs exist for this submission,
	 * Save Grade / Export YAML open the guard modal. "Export anyway" marks
	 * all remaining unreviewed pairs as ignored and then proceeds.
	 */
	function guardExport(action: "Export YAML" | "Save Grade", proceed: () => void) {
		if (unreviewedCount === 0 || !submission) {
			proceed();
			return;
		}
		exportGuardAction = action;
		pendingAction = action === "Save Grade" ? "save" : "export";
		exportGuardOpen = true;
	}

	function handleGuardGoReview() {
		exportGuardOpen = false;
		pendingAction = null;
		activeTab = "plagiarism";
		mobileTab = "plagiarism";
	}

	async function handleGuardProceed() {
		exportGuardOpen = false;
		const action = pendingAction;
		const kind = pendingExportKind;
		pendingAction = null;
		try {
			// Mark all remaining unreviewed pairs as ignored (persisted).
			if (submission) {
				await plagiarismStore.ignoreAllUnreviewed(submission.assignmentId);
			}
		} catch {
			addToast("error", "Could not mark plagiarism pairs as ignored", 4000);
			return;
		}
		if (action === "save") {
			await doSaveGrade();
		} else if (action === "export") {
			await doExport(kind);
		}
	}

	async function doSaveGrade() {
		if (!submission) return;
		// Never silent at grading time: surface which cells are being saved
		// in the derived (auto-fixed) view so the teacher cannot mistake
		// pipeline output for student work.
		if (fixedView.size > 0) {
			const cells = [...fixedView]
				.map((i) => i + 1)
				.sort((a, b) => a - b)
				.join(", ");
			addToast(
				"info",
				`Saving ${fixedView.size} cell(s) in auto-fixed view (cells ${cells}) — dispositions included`,
				4000,
			);
		}
		try {
			const record = await submissionsStore.saveGrading(submission.id, {
				dimensions: { ...gradingInputs },
				feedback: selectionsToFeedback(categorySelections),
				notes: notesDraft,
				autofixDispositions: dispositions,
			});
			// Keep local state fresh: autofix existingNotes must reflect the merge.
			const savedGrading = (record as { grading?: SubmissionDetail["grading"] }).grading;
			submission = {
				...submission,
				grading: savedGrading,
			};
			// The notes editor mirrors the persisted top-level notes now.
			if (savedGrading?.notes != null) {
				notesDraft = savedGrading.notes;
			}
			addToast("success", `Grade saved for ${submission.studentId}`, 3000);
		} catch (e) {
			addToast("error", e instanceof Error ? e.message : "Failed to save grade", 4000);
		}
	}

	function handleSaveGrade() {
		guardExport("Save Grade", () => void doSaveGrade());
	}

	/**
	 * Generate (3f.5): compile the current rubric selections + grading into
	 * editable evaluation text (deterministic — no KI), shown inline in the
	 * notes card; the teacher edits and saves it with Save.
	 */
	function handleGenerate() {
		if (!submission || !rubric) return;
		const session: ReviewSession = {
			student_id: submission.studentId,
			assignment_id: submission.assignmentId,
			mode: "teacher",
			category_selections: categorySelections as unknown as Record<
				CategoryKey,
				CategorySelections
			>,
			grading: { ...gradingInputs },
			generated_text: "",
			notes: notesDraft,
			started_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
		};
		notesDraft = generateEvaluationText(session, rubric);
		// Optional call: jsdom does not implement scrollIntoView.
		notesCardRef?.scrollIntoView?.({ behavior: "smooth", block: "center" });
		addToast("success", "Generated evaluation text — edit and press Save", 3500);
	}

	/** Reset (3f.5): clear all review state locally for the next student. */
	function handleReset() {
		if (!rubric) return;
		const empty: Record<string, CategorySelections> = {};
		for (const entry of rubric.categories) {
			empty[entry.key] = {
				checked_items: new SvelteSet<string>(),
				notes: "",
				comments: {},
				deductions: {},
			};
		}
		categorySelections = empty;
		gradingInputs = defaultGradingInputs();
		notesDraft = "";
		addToast("info", "Review cleared — press Save to persist", 3500);
	}

	/** Notes card edits. */
	function handleNotesInput(value: string) {
		notesDraft = value;
	}

	/**
	 * Autofix cell-note saves append to the top-level notes on the server;
	 * mirror the resulting notes into the editor so the card never drifts
	 * from what Save will persist.
	 */
	function handleNotesSaved(notes: string) {
		notesDraft = notes;
	}

	/** Record the teacher's decision on a verified fix (durable on Save). */
	function handleDisposition(cellIndex: number, disposition: "accepted" | "ignored") {
		dispositions = { ...dispositions, [String(cellIndex)]: disposition };
	}

	/** Reset the ephemeral view set — everything back to the authentic original. */
	function resetFixedView() {
		fixedView.clear();
	}

	async function doExport(kind: "student" | "teacher" = "student") {
		if (!submission) return;
		try {
			const { fileName, content } = await submissionsStore.export(submission.id, kind);
			// Client-side download of the grading YAML document.
			const blob = new Blob([content], { type: "text/yaml;charset=utf-8" });
			const url = URL.createObjectURL(blob);
			const link = document.createElement("a");
			link.href = url;
			link.download = fileName;
			link.click();
			URL.revokeObjectURL(url);
			addToast("success", `Exported ${fileName}`, 3000);
		} catch (e) {
			addToast("error", e instanceof Error ? e.message : "Failed to export", 4000);
		}
	}

	/**
	 * Export entry points (split button): primary click = student copy
	 * (default); the caret menu offers the teacher YAML variant. Both pass
	 * through the same P3-1 guard.
	 */
	function handleExport(kind: "student" | "teacher") {
		pendingExportKind = kind;
		guardExport("Export YAML", () => void doExport(kind));
	}

	/**
	 * Teacher-YAML import (3i): the header Import button opens a hidden file
	 * picker; the chosen `*-teacher.yaml` is imported through the store and
	 * applied to the page state (status/teacherGrade/grading), then the
	 * plagiarism pairs are reloaded (review statuses may have changed).
	 */
	async function handleImportFile(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = "";
		if (!file || !submission) return;
		try {
			const record = await submissionsStore.importTeacherYaml(
				submission.id,
				await file.text(),
			);
			submission = {
				...submission,
				status: record.status,
				teacherGrade: record.teacherGrade,
				grading: (record as { grading?: SubmissionDetail["grading"] }).grading,
			};
			// Imported notes replace the record's top-level notes — sync the
			// notes editor so it reflects what is now persisted.
			const importedGrading = (record as { grading?: SubmissionDetail["grading"] }).grading;
			if (importedGrading?.notes != null) {
				notesDraft = importedGrading.notes;
			}
			// Badges/statuses may have changed — refresh the assignment's pairs.
			await plagiarismStore.load(submission.assignmentId);
			addToast("success", `Imported ${file.name}`, 3500);
		} catch (err) {
			addToast("error", err instanceof Error ? err.message : "Import failed", 5000);
		}
	}

	function handleSuggestGrade() {
		activeTab = "copilot";
		mobileTab = "copilot";
	}

	function handleDraftNotes() {
		activeTab = "copilot";
		mobileTab = "copilot";
	}

	// -----------------------------------------------------------------------
	// Copilot apply + inline chip wiring (4e)
	// -----------------------------------------------------------------------
	/**
	 * Prompts queued by the inline "Ask copilot" chips (rubric category
	 * headers, cell headers). The tab switch mounts the CopilotPanel; a
	 * $effect below drains the queue by driving the panel's own input.
	 */
	let copilotPromptQueue = $state<string[]>([]);

	/**
	 * Apply a pending copilot suggestion to page state (grading inputs +
	 * notes draft) via the pure applySuggestionToState helper. Never
	 * auto-saves — the teacher reviews and presses Save.
	 */
	function handleApplySuggestion(suggestion: CopilotSuggestion) {
		const next = applySuggestionToState(suggestion, {
			gradingInputs: { ...gradingInputs },
			notesDraft,
		});
		gradingInputs = next.gradingInputs;
		notesDraft = next.notesDraft;
		if (suggestion.kind === "grade") {
			addToast("success", "Suggested scores applied — review and press Save", 3500);
		} else if (suggestion.kind === "draft") {
			addToast("success", "Feedback draft applied — review and press Save", 3500);
		}
		// fix / export kinds have no page-state apply path — the helper
		// returned the state unchanged and no toast is shown.
	}

	/**
	 * Inline chips dispatch a 'copilot-request' CustomEvent (detail: prompt
	 * string). Switch BOTH tab states to the copilot tab (desktop + mobile)
	 * and queue the prompt for the panel — delivered once it is mounted.
	 */
	function handleCopilotRequest(e: Event) {
		const prompt = (e as CustomEvent<string>).detail;
		if (!prompt?.trim()) return;
		rightPanelCollapsed = false;
		activeTab = "copilot";
		mobileTab = "copilot";
		copilotPromptQueue = [...copilotPromptQueue, prompt.trim()];
	}

	/**
	 * The panel owns its copilot store instance and exposes no external
	 * send API, and copilot-panel.svelte must stay untouched (4e scope),
	 * so the queued prompt is delivered by driving the panel's own input
	 * the way a teacher would: fill the field, fire an `input` event
	 * (handleInput writes copilot.inputValue), then an Enter keydown
	 * (handleKeydown → handleSend). The effect runs AFTER the tab switch
	 * mounts the panel, so the input exists on the first drain.
	 */
	$effect(() => {
		if (activeTab !== "copilot" || rightPanelCollapsed || copilotPromptQueue.length === 0) {
			return;
		}
		const prompt = copilotPromptQueue[0];
		const input = document.querySelector<HTMLInputElement>(
			".copilot-container input.input-field",
		);
		if (!input) return;
		input.value = prompt;
		input.dispatchEvent(new Event("input", { bubbles: true }));
		input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		copilotPromptQueue = copilotPromptQueue.slice(1);
	});

	/** Listen for inline-chip 'copilot-request' events (client-side only). */
	$effect(() => {
		if (typeof window === "undefined") return;
		const handler = (e: Event) => handleCopilotRequest(e);
		window.addEventListener("copilot-request", handler);
		return () => window.removeEventListener("copilot-request", handler);
	});
</script>

<svelte:head>
	<title>SciPro Review — {submission?.studentId ?? "Submission"}</title>
</svelte:head>

<!-- Loading state -->
{#if isLoading}
	<div
		class="review-layout"
		style="display:flex;flex-direction:row;flex:1;min-height:0;max-height:calc(100vh - 56px);"
	>
		<!-- Left panel skeleton -->
		<div class="flex flex-1 flex-col overflow-hidden" style="flex:2 1 0">
			<!-- Submission header -->
			<div class="flex items-center gap-3 border-b border-border px-6 py-4 md:px-10 lg:px-8">
				<SkeletonPulse class="h-5 w-28" />
				<SkeletonPulse class="h-5 w-20 rounded-full" />
				<div class="ml-auto flex items-center gap-2">
					<SkeletonPulse class="h-7 w-[70px] rounded-[var(--radius)]" />
					<SkeletonPulse class="h-7 w-[90px] rounded-[var(--radius)]" />
					<SkeletonPulse class="h-7 w-7 rounded-[var(--radius)]" />
				</div>
			</div>
			<!-- Reference comparison skeleton -->
			<div
				class="flex items-center gap-2 border-b border-border px-6 py-2.5 md:px-10 lg:px-8"
			>
				<SkeletonPulse class="h-3 w-4" />
				<SkeletonPulse class="h-3 w-36" />
				<div class="ml-auto flex items-center gap-4">
					<SkeletonPulse class="h-3 w-28" />
				</div>
			</div>
			<!-- Cell cards skeleton -->
			<div class="flex-1 space-y-3 overflow-y-auto p-4">
				{#each [1, 2, 3, 4] as _i (_i)}
					<div class="overflow-hidden rounded-[var(--radius)] border border-border">
						<div
							class="flex items-center gap-4 border-b border-border px-3 py-1.5"
							style="background:oklch(0.985 0.002 247.8)"
						>
							<SkeletonPulse class="h-3 w-16" />
							<SkeletonPulse class="ml-auto h-4 w-28 rounded-full" />
						</div>
						<div class="p-3">
							<SkeletonPulse
								class="h-12 w-full"
								style="background:oklch(0.148 0.004 228.8)"
							/>
						</div>
					</div>
				{/each}
			</div>
		</div>

		<!-- Divider skeleton -->
		<div class="w-[6px] shrink-0">
			<div
				class="mx-auto mt-[50vh] h-8 w-[2px] rounded-full"
				style="background:var(--border)"
			></div>
		</div>

		<!-- Right panel skeleton -->
		<div class="flex flex-1 flex-col" style="flex:1 1 0;min-width:300px;max-width:50%">
			<!-- Tab bar -->
			<div class="flex border-b border-border px-3 py-2.5">
				<SkeletonPulse class="mr-6 h-4 w-14" />
				<SkeletonPulse class="mr-6 h-4 w-16" />
				<SkeletonPulse class="h-4 w-16" />
			</div>
			<!-- Tab content -->
			<div class="flex-1 space-y-2 overflow-y-auto p-3">
				{#each [1, 2, 3] as _j (_j)}
					<div class="overflow-hidden rounded-[var(--radius)] border border-border">
						<div
							class="flex items-center justify-between border-b border-border px-3 py-2.5"
						>
							<SkeletonPulse class="h-4 w-32" />
							<SkeletonPulse class="h-4 w-4" />
						</div>
						<div class="space-y-2 p-3">
							<SkeletonPulse class="h-3 w-full" />
							<SkeletonPulse class="h-3 w-3/4" />
							<SkeletonPulse class="h-3 w-1/2" />
						</div>
					</div>
				{/each}
			</div>
		</div>
	</div>

	<!-- Error state -->
{:else if error}
	<div class="flex items-center justify-center px-6 py-20 md:px-10 lg:px-16 xl:px-24">
		<div class="max-w-md text-center">
			<AlertTriangle size={40} class="mx-auto text-destructive" />
			<h2 class="mt-4 text-lg font-semibold text-foreground">Something went wrong</h2>
			<p class="mt-2 text-sm text-muted-foreground">{error}</p>
			<div class="mt-6 flex items-center justify-center gap-3">
				<Button
					variant="default"
					size="sm"
					onclick={() => page.params.id && loadData(page.params.id)}
				>
					<RefreshCw size={14} />
					Try again
				</Button>
				<a
					href="{base}/submissions"
					class={cn(buttonVariants({ variant: "outline", size: "sm" }), "gap-1")}
				>
					Go to Dashboard
				</a>
			</div>
		</div>
	</div>

	<!-- Content state -->
{:else if submission}
	{@const cells = submission.cells}

	<!--
		Two-panel layout with resizable divider.
		On mobile (<768px): stacks vertically, no divider.
		Uses flex — handles the divider as a sibling between panels
		without the grid child-counting issue.
	-->
	{@const showDivider = !isMobile && !rightPanelCollapsed}
	{@const showRightPanel = !rightPanelCollapsed}
	{@const leftStyle = rightPanelCollapsed
		? "flex: 1 1 100%"
		: isMobile
			? "flex: 1 1 auto"
			: leftPanelWidth !== null
				? `flex: 0 0 ${leftPanelWidth}px`
				: "flex: 2 1 0"}
	{@const rightTab: Tab = mobileTab === "cells" ? "rubric" : mobileTab}
	{@const sent = rubricSentimentCounts(rubric, categorySelections)}
	{@const mobUnreviewed = plagiarismStore.unreviewedCount(submission.studentId)}
	{@const statusCfg = statusConfig[submission.status] ?? statusConfig.pending}
	{@const StatusIcon = statusCfg.icon}
	<div
		class="review-layout"
		class:is-dragging={isDragging}
		class:right-collapsed={rightPanelCollapsed}
		class:is-mobile={isMobile}
		bind:this={containerRef}
	>
		<!-- Mobile tab bar (P3-6): Cells | Rubric | Grade | Plagiarism | Copilot.
		     Icons hidden <420px via CSS so labels fit. -->
		{#if isMobile}
			<div class="mob-tab-bar">
				<button
					class="mob-tab"
					class:active={mobileTab === "cells"}
					onclick={() => handleMobileTabChange("cells")}
				>
					<Files size={12} />
					Cells
				</button>
				<button
					class="mob-tab"
					class:active={mobileTab === "rubric"}
					onclick={() => handleMobileTabChange("rubric")}
				>
					<ListChecks size={12} />
					Rubric
					<span class="tab-sent" title="Flagged rubric items by sentiment">
						<span class="sent-item sent-pos"
							><span class="sent-num">{sent.positive}</span></span
						>
						<span class="sent-item sent-neu"
							><span class="sent-num">{sent.neutral}</span></span
						>
						<span class="sent-item sent-neg"
							><span class="sent-num">{sent.negative}</span></span
						>
					</span>
				</button>
				<button
					class="mob-tab"
					class:active={mobileTab === "grading"}
					onclick={() => handleMobileTabChange("grading")}
				>
					<Gauge size={12} />
					Grade
					{#if gradeResult}
						<span class="tab-badge">{gradeResult.percentage.toFixed(0)}%</span>
					{/if}
				</button>
				<button
					class="mob-tab"
					class:active={mobileTab === "plagiarism"}
					onclick={() => handleMobileTabChange("plagiarism")}
				>
					<ShieldCheck size={12} />
					Plagiarism
					{#if mobUnreviewed > 0}
						<span class="tab-badge tab-badge-warn">{mobUnreviewed}</span>
					{/if}
				</button>
				<button
					class="mob-tab"
					class:active={mobileTab === "copilot"}
					onclick={() => handleMobileTabChange("copilot")}
				>
					<Sparkles size={12} />
					Copilot
				</button>
			</div>
		{/if}

		<!-- Left Panel: Cells (hidden on mobile while another tab is active) -->
		{#if !isMobile || mobileTab === "cells"}
			<div class="left-panel" style={leftStyle}>
				<!-- Submission header -->
				<div
					class="flex items-center gap-3 border-b border-border bg-card px-6 py-4 md:px-10 lg:px-8"
				>
					<h1 class="text-lg font-semibold text-foreground">{submission.studentId}</h1>
					<span
						class="status-badge status-{submission.status}"
						title={submission.error ?? ""}
					>
						<StatusIcon size={11} />
						{statusCfg.label}
					</span>
					<div class="ml-auto flex items-center gap-2">
						<button
							onclick={handleSuggestGrade}
							class="inline-flex items-center gap-1.5 rounded-[var(--radius)] border border-border px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-black/5 dark:hover:bg-white/10"
						>
							<WandSparkles size={14} />
							Suggest
						</button>
						<button
							onclick={handleDraftNotes}
							class="inline-flex items-center gap-1.5 rounded-[var(--radius)] border border-border px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-black/5 dark:hover:bg-white/10"
						>
							<FileText size={14} />
							Draft Notes
						</button>
						<button
							onclick={handleGenerate}
							title="Compile rubric + grading into editable evaluation text"
							class="inline-flex items-center gap-1.5 rounded-[var(--radius)] border border-border px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-black/5 dark:hover:bg-white/10"
						>
							<FilePlus2 size={14} />
							Generate
						</button>
						<button
							onclick={handleReset}
							title="Clear all rubric selections, sliders and notes (local — Save persists)"
							class="inline-flex items-center gap-1.5 rounded-[var(--radius)] border border-destructive/40 px-3 py-1.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10"
						>
							<RefreshCw size={14} />
							Reset
						</button>

						<!-- Collapse/expand right panel toggle (desktop only) -->
						{#if !isMobile}
							<button
								onclick={toggleRightPanel}
								class="toggle-panel-btn"
								aria-label={rightPanelCollapsed ? "Show panel" : "Hide panel"}
								title={rightPanelCollapsed
									? "Show grading panel"
									: "Hide grading panel"}
							>
								{#if rightPanelCollapsed}
									<PanelRightOpen size={16} />
								{:else}
									<PanelRightClose size={16} />
								{/if}
							</button>
						{/if}
					</div>
				</div>

				<!-- Reference comparison -->
				<ReferenceComparison submissionCells={cells} preEval={submission.preEval} />

				<!-- Sticky page-level counter for the derived view: only visible
				     while at least one cell shows its auto-fixed version. -->
				{#if fixedView.size > 0}
					<div class="fixed-view-bar">
						<Sparkles size={13} />
						<span>
							{fixedView.size} cell(s) showing auto-fixed versions
						</span>
						<button type="button" class="fixed-view-reset" onclick={resetFixedView}>
							Show all original
						</button>
					</div>
				{/if}

				<!-- Cell execution output -->
				<ExecutionOutput
					{cells}
					fixedCells={submission.fixedCells}
					{fixedView}
					onDisposition={handleDisposition}
					submissionId={submission.studentId}
					assignmentId={submission.assignmentId}
					existingNotes={notesDraft}
					onNotesSaved={handleNotesSaved}
					preEval={submission.preEval}
					copilotChips={apiMode.value}
				/>

				<!-- Top-level teacher notes (3f.5): edited inline, persisted
				     with the header Save (GradingPatch.notes). -->
				<div class="notes-card" bind:this={notesCardRef}>
					<div class="notes-card-header">
						<FileText size={13} />
						<span class="notes-title">Teacher notes</span>
						<span class="notes-hint">saved with Save</span>
					</div>
					<textarea
						class="notes-textarea"
						rows={4}
						placeholder="Top-level feedback notes for this submission…"
						value={notesDraft}
						oninput={(e) => handleNotesInput((e.target as HTMLTextAreaElement).value)}
					></textarea>
				</div>
			</div>
		{/if}

		<!-- Resizable divider (hidden on mobile or when right panel is collapsed) -->
		{#if showDivider}
			<button
				type="button"
				class="panel-divider"
				onpointerdown={handleDividerPointerDown}
				onpointermove={handleDividerPointerMove}
				onpointerup={handleDividerPointerUp}
				onpointercancel={handleDividerPointerUp}
				aria-label="Resize panels"
				ondblclick={() => {
					leftPanelWidth = null;
				}}
				onkeydown={(e) => {
					if (e.key === "ArrowLeft") {
						const cw = getContainerWidth();
						leftPanelWidth = Math.max(cw * 0.5, (leftPanelWidth ?? cw * 0.66) - 20);
					} else if (e.key === "ArrowRight") {
						const cw = getContainerWidth();
						leftPanelWidth = Math.min(
							cw - RIGHT_MIN,
							(leftPanelWidth ?? cw * 0.66) + 20,
						);
					}
				}}
			></button>
		{/if}

		<!-- Right Panel: Tabs (hidden when collapsed, or on mobile while the
		     Cells tab is active) -->
		{#if showRightPanel && (!isMobile || mobileTab !== "cells")}
			<aside class="right-panel">
				{#if rubricError}
					<!-- Inline notice: rubric could not be loaded (right panel Rubric
					     tab area) — no silent null for the teacher. -->
					<div class="rubric-error-notice" role="alert">
						<TriangleAlert size={15} style="flex-shrink: 0" />
						<span>{rubricError}</span>
					</div>
				{/if}
				{#if gradingConfig}
					<RightPanelTabs
						activeTab={isMobile ? rightTab : activeTab}
						onTabChange={handleTabChange}
						dimensions={gradingConfig.dimensions}
						grading={gradingInputs}
						{gradeResult}
						{totalDeductions}
						onUpdateDimension={handleUpdateDimension}
						{rubric}
						sentimentCounts={sent}
						{categorySelections}
						onSelectionsChange={(next) => (categorySelections = next)}
						studentId={submission.studentId}
						assignmentId={submission.assignmentId}
						hideTabBar={isMobile}
						onapply={handleApplySuggestion}
						showAskCopilot={apiMode.value}
					/>
				{/if}
			</aside>
		{/if}

		<!-- Mobile bottom bar (P3-6): grade mini + Export/Save — the ONLY
		     action location on mobile (header actions are hidden <sm). -->
		{#if isMobile}
			<div class="mob-bottom-bar">
				<div class="mob-bottom-grade-mini">
					<span>Grade:</span>
					<span class="mini-score"
						>{gradeResult ? gradeResult.percentage.toFixed(1) : "—"}</span
					>
					<span>/ 100</span>
					{#if gradeResult}
						<span class="mini-letter"
							>{gradeResult.grade.toFixed(1)} {gradeResult.label}</span
						>
					{/if}
				</div>
				<div class="mob-bottom-actions">
					{#snippet exportIcon()}
						<Download size={11} />
					{/snippet}
					<MenuButton
						label="Export"
						primaryOnClick={() => handleExport("student")}
						items={[
							{
								id: "teacher",
								label: "Export teacher YAML",
								description: "Full record + plagiarism audit (-teacher)",
								onclick: () => handleExport("teacher"),
							},
						]}
						icon={exportIcon}
						variant="outline"
						size="sm"
					/>
					<Button variant="success" size="sm" onclick={handleSaveGrade}>
						<Save size={14} />
						Save Grade
					</Button>
				</div>
			</div>
		{/if}
	</div>

	<!-- Export guard modal (P3-1): unreviewed plagiarism pairs block
	     Save Grade / Export YAML until resolved or explicitly overridden. -->
	{#if exportGuardOpen}
		<div class="guard-modal" role="presentation">
			<div
				class="guard-modal-card"
				role="dialog"
				aria-modal="true"
				aria-label="Unreviewed plagiarism detections"
			>
				<div class="guard-modal-head">
					<TriangleAlert size={16} style="color: var(--destructive); flex-shrink: 0" />
					<h3>Unreviewed plagiarism detections</h3>
					<Button
						variant="ghost"
						size="icon"
						class="h-7 w-7"
						aria-label="Close"
						onclick={() => (exportGuardOpen = false)}
					>
						<X size={14} />
					</Button>
				</div>
				<p class="guard-modal-text">
					<strong>{unreviewedCount}</strong> potential plagiarism detection{unreviewedCount !==
					1
						? "s"
						: ""} ha{unreviewedCount !== 1 ? "ve" : "s"} not been reviewed yet.
					<strong>{exportGuardAction}</strong> anyway?
				</p>
				<p class="guard-counts">{guardCounts}</p>
				<div class="guard-modal-actions">
					<Button variant="outline" size="sm" onclick={handleGuardGoReview}>
						Go to review
					</Button>
					<Button variant="default" size="sm" onclick={handleGuardProceed}>
						{exportGuardAction === "Save Grade" ? "Save anyway" : "Export anyway"}
					</Button>
				</div>
			</div>
		</div>
	{/if}
{/if}

<!-- Hidden file picker for the header Import button (3i teacher YAML). -->
<input
	type="file"
	accept=".yaml,.yml,text/yaml"
	hidden
	bind:this={importInput}
	onchange={handleImportFile}
/>

<style>
	/* ── Review layout (two-panel) ── */
	.review-layout {
		display: flex;
		flex-direction: row;
		flex: 1;
		min-height: 0;
		max-height: calc(100vh - 56px);
		position: relative;
		user-select: none;
	}
	.review-layout.is-dragging {
		cursor: col-resize;
	}
	/* .review-layout.right-collapsed — left panel takes full width via inline style */
	.review-layout.is-mobile {
		flex-direction: column;
	}

	/* ── Left panel ── */
	.left-panel {
		min-width: 0;
		overflow-y: auto;
		background: var(--bg);
		border-right: 1px solid var(--border);
		/* flex value set via inline style */
	}
	.review-layout.right-collapsed .left-panel {
		border-right: none;
	}

	/* ── Panel divider (draggable) ── */
	.panel-divider {
		position: relative;
		width: 6px;
		margin-left: -3px;
		cursor: col-resize;
		background: transparent;
		z-index: 10;
		flex-shrink: 0;
		transition: background 0.1s;
		border: none;
		padding: 0;
	}
	.panel-divider:hover,
	.review-layout.is-dragging .panel-divider {
		background: var(--accent);
		opacity: 0.3;
	}
	.panel-divider::after {
		content: "";
		position: absolute;
		top: 50%;
		left: 50%;
		transform: translate(-50%, -50%);
		width: 2px;
		height: 32px;
		border-radius: 2px;
		background: var(--border);
		transition:
			background 0.1s,
			height 0.1s;
	}
	.panel-divider:hover::after,
	.review-layout.is-dragging .panel-divider::after {
		background: var(--accent);
		height: 48px;
		opacity: 0.8;
	}
	/* Focus ring for keyboard users */
	.panel-divider:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -1px;
	}

	/* ── Right panel ── */
	.right-panel {
		display: flex;
		flex-direction: column;
		overflow: hidden;
		background: var(--bg);
		flex: 1 1 0;
		min-width: 300px;
		max-width: 50%;
	}

	/* ── Rubric load failure notice ── */
	.rubric-error-notice {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		margin: 10px 12px 0;
		padding: 9px 11px;
		border: 1px solid color-mix(in oklch, var(--destructive) 35%, transparent);
		border-radius: var(--radius-md);
		background: color-mix(in oklch, var(--destructive) 8%, transparent);
		font-size: 12.5px;
		line-height: 1.45;
		color: var(--destructive);
		flex-shrink: 0;
	}

	/* ── Collapse toggle button ── */
	.toggle-panel-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		border-radius: var(--radius);
		color: var(--muted-foreground);
		background: transparent;
		border: 1px solid var(--border);
		cursor: pointer;
		transition:
			background 0.15s,
			color 0.15s,
			border-color 0.15s;
		margin-left: 4px;
	}
	.toggle-panel-btn:hover {
		background: var(--muted-bg);
		color: var(--fg);
		border-color: var(--muted);
	}

	/* ── Mobile overrides ── */
	@media (max-width: 767px) {
		.review-layout.is-mobile {
			max-height: calc(100vh - 56px);
		}
		.review-layout.is-mobile .right-panel {
			min-width: unset;
			max-width: none;
			width: 100%;
			border-top: 1px solid var(--border);
			flex: 1 1 auto;
		}
		.review-layout.is-mobile .left-panel {
			border-right: none;
			flex: 1 1 auto !important;
		}
		/* Tighter submission header on mobile */
		.review-layout.is-mobile .left-panel > div:first-child {
			flex-wrap: wrap;
			gap: 8px;
			padding: 10px 12px;
		}
	}

	/* ── Mobile tab bar (P3-6) ── */
	.mob-tab-bar {
		display: flex;
		flex-shrink: 0;
		border-bottom: 1px solid var(--border);
		background: var(--card);
	}
	.mob-tab {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 5px;
		padding: 8px 3px;
		font-size: 11px;
		font-weight: 500;
		color: var(--muted-foreground);
		background: none;
		border: none;
		border-bottom: 2px solid transparent;
		cursor: pointer;
		white-space: nowrap;
		min-width: 0;
	}
	.mob-tab.active {
		color: var(--primary);
		font-weight: 600;
		border-bottom-color: var(--primary);
	}
	.mob-tab .tab-badge {
		font-size: 9px;
		padding: 0 4px;
		border-radius: 999px;
		background: color-mix(in oklch, var(--accent) 60%, transparent);
		color: var(--accent-foreground);
		font-weight: 700;
		font-variant-numeric: tabular-nums;
	}
	.mob-tab .tab-badge-warn {
		background: color-mix(in oklch, var(--destructive) 14%, transparent);
		color: var(--destructive);
		border: 1px solid color-mix(in oklch, var(--destructive) 30%, transparent);
	}
	.mob-tab .tab-sent {
		display: inline-flex;
		align-items: center;
		gap: 4px;
	}
	.mob-tab .sent-item {
		display: inline-flex;
		align-items: center;
	}
	.mob-tab .sent-num {
		font-size: 9px;
		font-weight: 700;
		font-variant-numeric: tabular-nums;
		line-height: 1;
	}
	.mob-tab .sent-pos .sent-num {
		color: var(--success);
	}
	.mob-tab .sent-neu .sent-num {
		color: var(--muted-foreground);
	}
	.mob-tab .sent-neg .sent-num {
		color: var(--destructive);
	}
	/* Icons hidden <420px so labels fit (P3-6). Lucide icons render <svg>
	   via components, so the selector needs :global for the analyzer. */
	@media (max-width: 420px) {
		.mob-tab {
			font-size: 10px;
			padding: 8px 2px;
			gap: 2px;
		}
		:global(.mob-tab svg) {
			display: none;
		}
	}

	/* ── Mobile bottom bar (P3-6) ── */
	.mob-bottom-bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		flex-shrink: 0;
		padding: 8px 12px;
		border-top: 1px solid var(--border);
		background: var(--card);
	}
	.mob-bottom-grade-mini {
		display: flex;
		align-items: baseline;
		gap: 4px;
		font-size: 11px;
		color: var(--muted-foreground);
		white-space: nowrap;
	}
	.mob-bottom-grade-mini .mini-score {
		font-size: 14px;
		font-weight: 700;
		color: var(--fg);
		font-variant-numeric: tabular-nums;
	}
	.mob-bottom-grade-mini .mini-letter {
		font-size: 11px;
		font-weight: 600;
		color: var(--fg);
	}
	.mob-bottom-actions {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	/* ── Export guard modal (P3-1) ── */
	.guard-modal {
		position: fixed;
		inset: 0;
		background: color-mix(in oklch, var(--bg) 55%, transparent);
		backdrop-filter: blur(2px);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 60;
		padding: 20px;
	}
	.guard-modal-card {
		width: 420px;
		max-width: calc(100vw - 40px);
		background: var(--card);
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		box-shadow: 0 16px 48px rgb(0 0 0 / 0.18);
		padding: 18px;
	}
	.guard-modal-head {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.guard-modal-head h3 {
		flex: 1;
		font-size: 14px;
		font-weight: 600;
		color: var(--fg);
	}
	.guard-modal-text {
		margin-top: 12px;
		font-size: 13px;
		line-height: 1.5;
		color: var(--muted-foreground);
	}
	.guard-modal-text strong {
		color: var(--fg);
	}
	.guard-counts {
		margin-top: 8px;
		font-size: 12px;
		color: var(--muted-foreground);
		font-variant-numeric: tabular-nums;
	}
	.guard-modal-actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		margin-top: 16px;
	}

	/* ── Status badge (shared config, same palette as the dashboard) ── */
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

	/* ── Top-level teacher notes card (3f.5) ── */
	.notes-card {
		margin: 12px;
		padding: 10px 12px;
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: var(--bg);
	}
	.notes-card-header {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-bottom: 6px;
		color: var(--muted-foreground);
	}
	.notes-title {
		font-size: 12px;
		font-weight: 600;
		color: var(--fg);
	}
	.notes-hint {
		margin-left: auto;
		font-size: 11px;
		color: var(--muted-foreground);
	}
	.notes-textarea {
		width: 100%;
		box-sizing: border-box;
		padding: 8px;
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		font-size: 12px;
		font-family: var(--font-mono, ui-monospace, monospace);
		resize: vertical;
		background: var(--bg);
		color: var(--fg);
	}
	.notes-textarea:focus {
		outline: none;
		border-color: var(--ring);
		box-shadow: 0 0 0 2px color-mix(in oklch, var(--ring) 30%, transparent);
	}
	.notes-textarea::placeholder {
		color: var(--muted-foreground);
	}

	/* ── Sticky derived-view counter (3c.3) ── */
	.fixed-view-bar {
		position: sticky;
		top: 0;
		z-index: 20;
		display: flex;
		align-items: center;
		gap: 6px;
		margin: 0 16px;
		padding: 6px 10px;
		border: 1px solid color-mix(in oklch, var(--warning) 50%, transparent);
		border-radius: var(--radius-md);
		background: color-mix(in oklch, var(--warning) 14%, var(--bg));
		color: var(--warning);
		font-size: 12px;
		font-weight: 600;
	}
	.fixed-view-reset {
		margin-left: auto;
		background: none;
		border: none;
		padding: 0;
		color: inherit;
		font-size: inherit;
		font-weight: 600;
		text-decoration: underline;
		cursor: pointer;
	}
</style>
