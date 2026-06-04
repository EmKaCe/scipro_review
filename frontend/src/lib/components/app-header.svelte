<script lang="ts">
	import type { Snippet } from "svelte";
	import ArrowLeft from "@lucide/svelte/icons/arrow-left";
	import Sun from "@lucide/svelte/icons/sun";
	import Moon from "@lucide/svelte/icons/moon";
	import Settings from "@lucide/svelte/icons/settings";
	import Upload from "@lucide/svelte/icons/upload";
	import Save from "@lucide/svelte/icons/save";
	import { base } from "$app/paths";
	import { goto } from "$app/navigation";
	import { settings, setTheme } from "$lib/stores/settings.svelte.js";

	/** Props for the application header bar component. */
	interface Props {
		/** Whether to show the back navigation button. */
		showBack?: boolean;
		/** Breadcrumb label displayed next to the back button. */
		breadcrumb?: string;
		/** Whether to show the save button. */
		showSave?: boolean;
		/** Callback invoked when the save button is clicked. */
		onsaveclick?: () => void;
		/** Whether to show the import button. */
		showImport?: boolean;
		/** Callback invoked when the import button is clicked. */
		onimportclick?: () => void;
		/** Snippet rendered in the center of the header. */
		centerContent?: Snippet;
		/** Additional CSS class names. */
		class?: string;
	}

	let {
		showBack = false,
		breadcrumb,
		showSave = false,
		onsaveclick,
		showImport = false,
		onimportclick,
		centerContent,
		class: className = "",
	}: Props = $props();

	let isDark = $derived(settings.theme === "dark");

	function toggleTheme() {
		const newTheme = isDark ? "light" : "dark";
		setTheme(newTheme);
	}

	function goBack() {
		if (history.length > 1) {
			history.back();
		} else {
			goto(base);
		}
	}
</script>

<header
	class="sticky top-0 z-40 flex h-14 items-center border-b border-border bg-background/80 px-4 backdrop-blur-md {className}"
>
	<!-- Left -->
	<div class="flex min-w-0 flex-1 items-center gap-2">
		{#if showBack}
			<button
				onclick={goBack}
				class="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius)] text-foreground transition-colors hover:bg-black/5 dark:hover:bg-white/10"
				aria-label="Go back"
			>
				<ArrowLeft size={16} />
			</button>
		{/if}

		<span class="shrink-0 text-lg font-semibold tracking-tight">SciPro Review</span>

		{#if breadcrumb}
			<span class="mx-1 text-muted-foreground select-none">/</span>
			<span class="truncate text-sm text-muted-foreground">{breadcrumb}</span>
		{/if}
	</div>

	<!-- Center -->
	{#if centerContent}
		<div class="absolute left-1/2 hidden -translate-x-1/2 items-center gap-3 lg:flex">
			{@render centerContent()}
		</div>
	{/if}

	<!-- Right -->
	<div class="flex flex-1 items-center justify-end gap-1">
		{#if showSave}
			<button
				title="Save (Ctrl+S)"
				onclick={onsaveclick}
				class="hidden shrink-0 items-center gap-1.5 rounded-[var(--radius)] bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 sm:flex"
			>
				<Save size={14} />
				Save
			</button>
		{/if}

		{#if showImport}
			<button
				onclick={onimportclick}
				aria-label="Import review"
				class="flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-[var(--radius)] border border-border px-3 text-sm font-medium text-foreground transition-colors hover:bg-black/5 dark:hover:bg-white/10"
			>
				<Upload size={16} />
				<span class="hidden sm:inline">Import</span>
			</button>
		{/if}

		<button
			onclick={toggleTheme}
			aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
			class="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius)] text-foreground transition-colors hover:bg-black/5 dark:hover:bg-white/10"
		>
			{#if isDark}
				<Sun size={16} />
			{:else}
				<Moon size={16} />
			{/if}
		</button>

		<a
			href="{base}/settings"
			aria-label="Settings"
			class="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius)] text-foreground transition-colors hover:bg-black/5 dark:hover:bg-white/10"
		>
			<Settings size={16} />
		</a>
	</div>
</header>
