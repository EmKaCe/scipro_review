<script lang="ts">
	import type { Assignment } from "$lib/types/assignments.js";
	import CustomSwitch from "$lib/components/ui/custom-switch.svelte";
	import ArrowRight from "@lucide/svelte/icons/arrow-right";

	/** Props for the new review creation form component. */
	interface Props {
		/** Semester prefix to prepend to student IDs (e.g. "2026SS_"). */
		semesterPrefix: string;
		/** Available assignments for the current semester. */
		assignments: readonly Assignment[];
		/** Whether the form is in a loading state. */
		disabled?: boolean;
		/** Callback invoked with student ID and assignment ID when the form is submitted. */
		onSubmit: (studentId: string, assignmentId: string) => void;
	}

	let { semesterPrefix, assignments, disabled = false, onSubmit }: Props = $props();

	let studentId = $state("");
	let selectedAssignment = $state("");
	let customId = $state(false);

	let isValid = $derived(studentId.trim().length > 0 && selectedAssignment.length > 0);

	let fullId = $derived(customId ? studentId.trim() : `${semesterPrefix}${studentId.trim()}`);

	let helperText = $derived(
		customId
			? "Full manual entry enabled"
			: `Auto-prefixed with current semester (${semesterPrefix})`,
	);

	function handleSubmit() {
		if (!isValid || disabled) return;
		onSubmit(fullId, selectedAssignment);
		studentId = "";
		selectedAssignment = "";
	}
</script>

<div class="rounded-[var(--radius)] border border-border bg-card p-6 shadow-sm">
	<h2 class="mb-6 text-lg font-semibold tracking-tight">Start a New Review</h2>
	<div class="space-y-5">
		<!-- Student ID -->
		<div>
			<label for="student-id" class="mb-1.5 block text-sm font-medium">Student ID</label>
			<div class="flex flex-wrap items-center gap-3 sm:flex-nowrap">
				<div
					class="flex min-w-0 flex-1 overflow-hidden rounded-[var(--radius)] border border-border bg-background focus-within:ring-2 focus-within:ring-ring"
				>
					{#if !customId}
						<span
							class="inline-flex shrink-0 items-center border-r border-border bg-muted px-3 text-xs text-muted-foreground select-none"
						>
							{semesterPrefix}
						</span>
					{/if}
					<input
						id="student-id"
						type="text"
						placeholder={customId ? "e.g., 2026SS_42" : "e.g., 42"}
						bind:value={studentId}
						class="h-10 min-w-0 flex-1 border-0 bg-transparent px-3 text-sm focus:outline-none"
						onkeydown={(e) => {
							if (e.key === "Enter") handleSubmit();
						}}
					/>
				</div>
				<div class="flex shrink-0 items-center gap-2">
					<CustomSwitch bind:checked={customId} label="Custom ID" />
				</div>
			</div>
			<p class="mt-1.5 text-xs text-muted-foreground">{helperText}</p>
		</div>

		<!-- Assignment -->
		<div>
			<label for="assignment" class="mb-1.5 block text-sm font-medium">Assignment</label>
			<select
				id="assignment"
				bind:value={selectedAssignment}
				class="h-10 w-full rounded-[var(--radius)] border border-border bg-background px-3 text-sm text-foreground transition-shadow focus:ring-2 focus:ring-ring focus:outline-none"
			>
				<option value="">Select an assignment...</option>
				{#each assignments as a (a.id)}
					{#if a.enabled}
						<option value={a.id}>{a.title}</option>
					{/if}
				{/each}
			</select>
		</div>

		<!-- Start Button -->
		<button
			onclick={handleSubmit}
			disabled={!isValid || disabled}
			class="flex h-10 w-full items-center justify-center gap-2 rounded-[var(--radius)] bg-primary text-sm font-medium text-primary-foreground transition-all {!isValid ||
			disabled
				? 'cursor-not-allowed opacity-50'
				: 'cursor-pointer hover:opacity-90'}"
		>
			Start Review
			<ArrowRight size={16} />
		</button>
	</div>
</div>
