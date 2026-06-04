<script lang="ts">
	import FileText from "@lucide/svelte/icons/file-text";
	import ExternalLink from "@lucide/svelte/icons/external-link";
	import { base } from "$app/paths";
	import { VERSION } from "$lib/version.js";
</script>

<div class="overflow-hidden rounded-[var(--radius)] border border-border bg-card shadow-sm">
	<div class="p-5 pb-3">
		<h2 class="text-base font-semibold tracking-tight">About</h2>
	</div>
	<div class="space-y-3 px-5 pb-5">
		<div class="flex items-center gap-3">
			<div
				class="flex h-10 w-10 items-center justify-center rounded-[var(--radius)] bg-primary/10"
			>
				<FileText size={20} class="text-primary" />
			</div>
			<div>
				<p class="text-sm font-semibold text-foreground">SciPro Review</p>
				<p class="text-xs text-muted-foreground">{VERSION}</p>
			</div>
		</div>
		<p class="text-sm leading-relaxed text-muted-foreground">
			Peer-review and grading tool for Jupyter notebook submissions. Designed for Scientific
			Programming in Python courses at the Bonn-Rhein-Sieg University of Applied Sciences.
		</p>
		<div class="flex items-center gap-3 pt-2">
			<a
				href="https://github.com/EmKaCe/svelte_review"
				target="_blank"
				rel="noopener noreferrer"
				class="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
			>
				<svg
					xmlns="http://www.w3.org/2000/svg"
					width="14"
					height="14"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
					><path
						d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"
					/><path d="M9 18c-4.51 2-5-2-7-2" /></svg
				>
				GitHub Repository
			</a>
			<a
				href="{base}/docs"
				target="_blank"
				rel="noopener noreferrer"
				class="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
			>
				<ExternalLink size={14} />
				Documentation
			</a>
		</div>
		<p class="pt-1 text-xs text-muted-foreground">Licensed under AGPL v3.0</p>
	</div>
</div>
