<script lang="ts">
	import GraduationCap from "@lucide/svelte/icons/graduation-cap";
	import Keyboard from "@lucide/svelte/icons/keyboard";
	import { settings, setMode } from "$lib/stores/settings.svelte.js";
	import { addToast } from "$lib/stores/toast.svelte.js";

	let isTeacher = $derived(settings.mode === "teacher");

	function toggleMode() {
		const oldMode = settings.mode;
		const newMode = oldMode === "teacher" ? "student" : "teacher";
		setMode(newMode);
		addToast(
			"success",
			newMode === "teacher" ? "Switched to Teacher Mode" : "Switched to Student Mode",
		);
	}

	$effect(() => {
		function handleShortcut(e: KeyboardEvent) {
			if (e.altKey && e.shiftKey && (e.key === "G" || e.key === "g")) {
				e.preventDefault();
				toggleMode();
			}
		}
		window.addEventListener("keydown", handleShortcut);
		return () => window.removeEventListener("keydown", handleShortcut);
	});
</script>

<div class="overflow-hidden rounded-[var(--radius)] border border-border bg-card shadow-sm">
	<div class="p-5 pb-3">
		<h2 class="text-base font-semibold tracking-tight">Mode</h2>
		<p class="mt-1 text-sm text-muted-foreground">
			Switch between student and teacher review modes.
		</p>
	</div>
	<div class="space-y-4 px-5 pb-5">
		<div class="flex items-center gap-3">
			<span class="text-sm font-medium text-foreground">Current mode:</span>
			<span
				class="inline-flex items-center rounded-full border border-primary bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary"
			>
				{isTeacher ? "Teacher" : "Student"}
			</span>
		</div>
		{#if isTeacher}
			<button
				onclick={toggleMode}
				class="flex h-9 items-center gap-2 rounded-[var(--radius)] border border-border px-3 text-sm font-medium text-foreground transition-colors hover:bg-black/5 dark:hover:bg-white/10"
			>
				<GraduationCap size={14} />
				Switch to Student Mode
			</button>
			<div class="space-y-1">
				<p class="flex items-center gap-1 text-xs text-muted-foreground">
					<Keyboard size={12} />
					Keyboard shortcut:
					<kbd
						class="rounded border border-border bg-background px-1.5 py-0.5 font-mono text-xs text-foreground"
						>Alt+Shift+G</kbd
					>
				</p>
				<p class="text-xs text-muted-foreground">
					Teacher mode enables grading controls and dimension sliders.
				</p>
			</div>
		{:else}
			<p class="text-xs text-muted-foreground">
				Student mode is the default review experience.
			</p>
		{/if}
	</div>
</div>
