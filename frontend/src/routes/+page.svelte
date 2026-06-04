<script lang="ts">
	import { reviewStore } from "$lib/stores/review.svelte.js";
	import { addToast } from "$lib/stores/toast.svelte.js";
	import { headerConfig } from "$lib/stores/header.svelte.js";
	import { settings } from "$lib/stores/settings.svelte.js";
	import { goto } from "$app/navigation";
	import { base } from "$app/paths";
	import { parseImport } from "$lib/services/session-persistence.js";
	import { saveReview } from "$lib/services/db.js";
	import NewReviewForm from "$lib/components/new-review-form.svelte";
	import SavedReviews from "$lib/components/saved-reviews.svelte";
	import ImportDialog from "$lib/components/import-dialog.svelte";
	import ConfirmationDialog from "$lib/components/confirmation-dialog.svelte";

	// Configure header for this page
	$effect(() => {
		headerConfig.showBack = false;
		headerConfig.breadcrumb = undefined;
		headerConfig.showImport = true;
		headerConfig.onimportclick = () => (showImportDialog = true);
		return () => {
			headerConfig.showBack = false;
			headerConfig.breadcrumb = undefined;
			headerConfig.showImport = false;
			headerConfig.onimportclick = undefined;
		};
	});

	// Initialize store on mount (guard against double-init)
	$effect(() => {
		if (assignments.length === 0 && !isLoading) {
			reviewStore.init();
		}
	});

	// Reactive references to store state
	let assignments = $derived(reviewStore.assignments);
	let savedReviews = $derived(reviewStore.saved_reviews);
	let isLoading = $derived(reviewStore.is_loading);

	let showImportDialog = $state(false);
	let showDeleteDialog = $state(false);
	let deleteTargetId: string | null = $state(null);
	let deleteTargetLabel = $state("");

	/** Current semester prefix derived from the current date. */
	let semesterPrefix = $derived.by(() => {
		const now = new Date();
		const year = now.getFullYear();
		const month = now.getMonth() + 1; // 0-indexed
		const semester = month >= 4 && month <= 9 ? "SS" : "WS";
		return `${year}${semester}_`;
	});

	async function startReview(studentId: string, assignmentId: string) {
		try {
			await reviewStore.setAssignment(assignmentId);
			reviewStore.student_id = studentId;
			addToast("success", `Starting review for ${studentId}...`, 3000);
			goto(`${base}/review/${assignmentId}`);
		} catch (error) {
			addToast("error", "Failed to start review. Please try again.");
			console.error("[Landing] Failed to start review:", error);
		}
	}

	async function openReview(id: string) {
		try {
			await reviewStore.loadById(id);
			// Sync store mode with user settings so grading controls work correctly
			reviewStore.mode = settings.mode;
			addToast("success", "Review loaded", 2000);
			goto(`${base}/review/${reviewStore.assignment_id}`);
		} catch (error) {
			addToast("error", "Failed to load review.");
			console.error("[Landing] Failed to load review:", error);
		}
	}

	async function confirmDelete(id: string) {
		// Find the review label for the confirmation dialog
		const review = savedReviews.find((r) => r.id === id);
		if (review) {
			deleteTargetId = id;
			deleteTargetLabel = review.student_id;
			showDeleteDialog = true;
		}
	}

	async function handleDelete() {
		if (deleteTargetId) {
			await reviewStore.deleteReview(deleteTargetId);
			deleteTargetId = null;
			deleteTargetLabel = "";
		}
		showDeleteDialog = false;
	}

	async function bulkDelete(ids: string[]) {
		for (const id of ids) {
			await reviewStore.deleteReview(id);
		}
		addToast("success", `Deleted ${ids.length} review${ids.length !== 1 ? "s" : ""}`, 3000);
	}

	async function handleImport(file: File, readOnly: boolean) {
		try {
			const text = await file.text();
			await reviewStore.importReview(text, file.name, readOnly);
			// Enforce forced read-only for student mode with teacher grades
			const importedGrading = reviewStore.grading;
			const hasGradingValues = Object.values(importedGrading).some((v) => v > 0);
			if (settings.mode === "student" && hasGradingValues) {
				reviewStore.is_read_only = true;
				reviewStore.is_forced_read_only = true;
			}
			// Sync store mode with user settings so grading controls work correctly
			reviewStore.mode = settings.mode;
			showImportDialog = false;
			goto(`${base}/review/${reviewStore.assignment_id}`);
		} catch (error) {
			addToast("error", "Failed to import review. Check the file format and try again.");
			console.error("[Landing] Import failed:", error);
		}
	}

	async function handleBulkImport(files: File[]) {
		let successCount = 0;
		let failCount = 0;

		for (const file of files) {
			try {
				const text = await file.text();
				const session = parseImport(text, file.name);
				if (session) {
					await saveReview(session);
					successCount++;
				} else {
					failCount++;
				}
			} catch (error) {
				console.error("[Landing] Bulk import failed for file:", file.name, error);
				failCount++;
			}
		}

		await reviewStore.refreshSavedReviews();
		showImportDialog = false;

		if (successCount > 0) {
			addToast("success", `Imported ${successCount} review${successCount !== 1 ? "s" : ""}`);
		}
		if (failCount > 0) {
			addToast("error", `Failed to import ${failCount} file${failCount !== 1 ? "s" : ""}`);
		}
	}
</script>

<svelte:head>
	<title>SciPro Review</title>
</svelte:head>

<div class="space-y-8 px-6 py-8 md:px-10 lg:px-16 xl:px-24">
	<NewReviewForm {semesterPrefix} {assignments} disabled={isLoading} onSubmit={startReview} />
	<SavedReviews
		reviews={savedReviews}
		{assignments}
		onOpen={openReview}
		onDelete={confirmDelete}
		onBulkDelete={bulkDelete}
	/>
</div>

<ImportDialog
	open={showImportDialog}
	onclose={() => (showImportDialog = false)}
	onimport={handleImport}
	onbulkimport={handleBulkImport}
/>

<ConfirmationDialog
	open={showDeleteDialog}
	title="Delete Review"
	message="Are you sure you want to delete the review for <span class=&quot;font-medium text-foreground&quot;>{deleteTargetLabel}</span>? This cannot be undone."
	confirmLabel="Delete"
	variant="danger"
	onconfirm={handleDelete}
	oncancel={() => (showDeleteDialog = false)}
/>
